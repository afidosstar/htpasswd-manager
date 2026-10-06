/**
 * Limitation des tentatives de connexion par adresse IP.
 */
import { HttpError } from '../http/errors.ts';

export interface ThrottleOptions {
  maxFailures?: number;
  lockMs?: number;
  now?: () => number;
}

export class LoginThrottle {
  #failures = new Map<string, { count: number; until: number }>();
  readonly maxFailures: number;
  readonly lockMs: number;
  readonly now: () => number;

  constructor({ maxFailures = 10, lockMs = 15 * 60 * 1000, now = Date.now }: ThrottleOptions = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.now = now;
  }

  /** Lève une 429 si l'adresse est verrouillée. */
  assertAllowed(ip: string): void {
    const f = this.#failures.get(ip);
    const t = this.now();
    if (f && f.count >= this.maxFailures && f.until > t) {
      throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.', { 'Retry-After': String(Math.ceil((f.until - t) / 1000)) });
    }
  }

  fail(ip: string): void {
    const cur = this.#failures.get(ip) || { count: 0, until: 0 };
    this.#failures.set(ip, { count: cur.count + 1, until: this.now() + this.lockMs });
  }

  reset(ip: string): void {
    this.#failures.delete(ip);
  }

  purge(): void {
    const t = this.now();
    for (const [ip, f] of this.#failures) if (f.until < t) this.#failures.delete(ip);
  }
}
