/**
 * Persistance du fichier htpasswd.
 *
 *  - Les lignes non reconnues (commentaires, lignes vides) sont conservées telles quelles.
 *  - Toutes les mutations passent par un mutex en mémoire (lecture-modification-écriture
 *    sérialisée) : pas de « lost update » entre deux requêtes concurrentes.
 *  - Écriture atomique : fichier temporaire dans le même répertoire -> fsync -> rename -> fsync du dossier.
 *    Un lecteur (Mailpit, Nginx…) voit toujours soit l'ancienne version complète, soit la nouvelle.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

/** Ligne du fichier : entrée « user:hash » ou ligne conservée telle quelle. */
export type Entry = { username: string; hash: string; raw?: undefined } | { username?: undefined; raw: string };
export type UserEntry = Extract<Entry, { username: string }>;

interface Logger {
  warn?: (msg: string) => void;
}

const isNodeError = (err: unknown): err is NodeJS.ErrnoException => err instanceof Error && 'code' in err;

export class HtpasswdStore {
  #chain: Promise<unknown> = Promise.resolve();
  readonly file: string;
  readonly dir: string;
  readonly mode: number;
  readonly logger: Logger;

  constructor(file: string, { mode = 0o640, logger = console as Logger }: { mode?: number; logger?: Logger } = {}) {
    this.file = path.resolve(file);
    this.dir = path.dirname(this.file);
    this.mode = mode;
    this.logger = logger;
  }

  /** Vérifie au démarrage que le répertoire existe et est inscriptible (fail fast). */
  async check(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.access(this.dir, fs.constants.W_OK);
  }

  async readRaw(): Promise<string> {
    try {
      return await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return '';
      throw err;
    }
  }

  static parse(raw: string): Entry[] {
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line) => {
      const idx = line.indexOf(':');
      if (idx <= 0 || line.trimStart().startsWith('#')) return { raw: line };
      return { username: line.slice(0, idx), hash: line.slice(idx + 1) };
    });
  }

  static serialize(entries: Entry[]): string {
    if (entries.length === 0) return '';
    return entries.map((e) => (e.username !== undefined ? `${e.username}:${e.hash}` : e.raw)).join('\n') + '\n';
  }

  async list(): Promise<{ raw: string; users: UserEntry[]; modifiedAt: string | null }> {
    const [raw, modifiedAt] = await Promise.all([this.readRaw(), this.modifiedAt()]);
    return { raw, modifiedAt, users: HtpasswdStore.parse(raw).filter((e): e is UserEntry => e.username !== undefined) };
  }

  /** Date de dernière modification du fichier (ISO), null s'il n'existe pas encore. */
  async modifiedAt(): Promise<string | null> {
    try {
      return (await fs.stat(this.file)).mtime.toISOString();
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Crée ou remplace l'entrée `username`. */
  upsert(username: string, hash: string): Promise<{ created: boolean }> {
    return this.#withLock(async () => {
      const entries = HtpasswdStore.parse(await this.readRaw());
      let found = false;
      const next: Entry[] = [];
      for (const e of entries) {
        if (e.username === username) {
          if (!found) next.push({ username, hash }); // remplace en place, purge les doublons
          found = true;
        } else next.push(e);
      }
      if (!found) next.push({ username, hash });
      await this.#writeAtomic(HtpasswdStore.serialize(next));
      return { created: !found };
    });
  }

  /** Supprime `username`. Retourne false s'il n'existait pas. */
  remove(username: string): Promise<boolean> {
    return this.#withLock(async () => {
      const entries = HtpasswdStore.parse(await this.readRaw());
      const next = entries.filter((e) => e.username !== username);
      if (next.length === entries.length) return false;
      await this.#writeAtomic(HtpasswdStore.serialize(next));
      return true;
    });
  }

  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #writeAtomic(content: string): Promise<void> {
    const tmp = path.join(this.dir, `.${path.basename(this.file)}.${randomBytes(6).toString('hex')}.tmp`);
    let fh: FileHandle | undefined;
    try {
      fh = await fs.open(tmp, 'wx', this.mode);
      await fh.writeFile(content, 'utf8');
      await fh.chmod(this.mode); // indépendant de l'umask
      await fh.sync();
      await fh.close();
      fh = undefined;

      try {
        await fs.rename(tmp, this.file);
      } catch (err) {
        // Cas d'un fichier monté seul en bind mount (rename impossible sur un point de montage).
        // Repli non atomique mais sûr : copie + fsync. Préférez monter le RÉPERTOIRE.
        if (!isNodeError(err) || (err.code !== 'EBUSY' && err.code !== 'EXDEV')) throw err;
        this.logger.warn?.(`[store] rename impossible (${err.code}) : réécriture en place. Montez un répertoire plutôt qu'un fichier.`);
        await fs.copyFile(tmp, this.file);
        const target = await fs.open(this.file, 'r+');
        try { await target.sync(); } finally { await target.close(); }
        await fs.unlink(tmp);
      }

      try {
        const d = await fs.open(this.dir, 'r');
        try { await d.sync(); } finally { await d.close(); }
      } catch { /* fsync de répertoire non supporté sur certains FS : sans gravité */ }
    } catch (err) {
      if (fh) await fh.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
