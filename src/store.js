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

export class HtpasswdStore {
  #chain = Promise.resolve();

  constructor(file, { mode = 0o640, logger = console } = {}) {
    this.file = path.resolve(file);
    this.dir = path.dirname(this.file);
    this.mode = mode;
    this.logger = logger;
  }

  /** Vérifie au démarrage que le répertoire existe et est inscriptible (fail fast). */
  async check() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.access(this.dir, fs.constants?.W_OK ?? 2);
  }

  async readRaw() {
    try {
      return await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  }

  static parse(raw) {
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line) => {
      const idx = line.indexOf(':');
      if (idx <= 0 || line.trimStart().startsWith('#')) return { raw: line };
      return { username: line.slice(0, idx), hash: line.slice(idx + 1) };
    });
  }

  static serialize(entries) {
    if (entries.length === 0) return '';
    return entries.map((e) => (e.username !== undefined ? `${e.username}:${e.hash}` : e.raw)).join('\n') + '\n';
  }

  async list() {
    const raw = await this.readRaw();
    return { raw, users: HtpasswdStore.parse(raw).filter((e) => e.username !== undefined) };
  }

  /** Crée ou remplace l'entrée `username`. */
  upsert(username, hash) {
    return this.#withLock(async () => {
      const entries = HtpasswdStore.parse(await this.readRaw());
      let found = false;
      const next = [];
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
  remove(username) {
    return this.#withLock(async () => {
      const entries = HtpasswdStore.parse(await this.readRaw());
      const next = entries.filter((e) => e.username !== username);
      if (next.length === entries.length) return false;
      await this.#writeAtomic(HtpasswdStore.serialize(next));
      return true;
    });
  }

  #withLock(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #writeAtomic(content) {
    const tmp = path.join(this.dir, `.${path.basename(this.file)}.${randomBytes(6).toString('hex')}.tmp`);
    let fh;
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
        if (err.code !== 'EBUSY' && err.code !== 'EXDEV') throw err;
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
