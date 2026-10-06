/**
 * Sessions de l'interface d'administration (mémoire du processus).
 *
 *  - Jeton aléatoire de 256 bits, transmis uniquement par cookie HttpOnly / SameSite=Strict.
 *  - Expiration glissante (inactivité) et absolue (durée de vie maximale).
 *  - Les sessions disparaissent au redémarrage du conteneur : reconnexion nécessaire.
 */
import { randomBytes } from 'node:crypto';

interface Session {
  user: string;
  created: number;
  seen: number;
}

export interface SessionOptions {
  idleMs?: number;
  maxAgeMs?: number;
  maxSessions?: number;
  now?: () => number;
}

export class SessionStore {
  #sessions = new Map<string, Session>();
  readonly idleMs: number;
  readonly maxAgeMs: number;
  readonly maxSessions: number;
  readonly now: () => number;

  constructor({ idleMs = 60 * 60 * 1000, maxAgeMs = 12 * 60 * 60 * 1000, maxSessions = 1000, now = Date.now }: SessionOptions = {}) {
    this.idleMs = idleMs;
    this.maxAgeMs = maxAgeMs;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  create(user: string): string {
    // Borne la mémoire : on évince la session la plus ancienne (ordre d'insertion de la Map).
    const oldest = this.#sessions.keys().next();
    if (this.#sessions.size >= this.maxSessions && !oldest.done) this.#sessions.delete(oldest.value);
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.#sessions.set(token, { user, created: t, seen: t });
    return token;
  }

  /** Retourne l'utilisateur de la session valide, ou null. Prolonge la session. */
  get(token: string | null | undefined): string | null {
    if (typeof token !== 'string' || !token) return null;
    const s = this.#sessions.get(token);
    if (!s) return null;
    const t = this.now();
    if (t - s.seen > this.idleMs || t - s.created > this.maxAgeMs) {
      this.#sessions.delete(token);
      return null;
    }
    s.seen = t;
    return s.user;
  }

  destroy(token: string | null | undefined): boolean {
    return typeof token === 'string' && this.#sessions.delete(token);
  }

  purge(): void {
    for (const token of this.#sessions.keys()) this.get(token);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
