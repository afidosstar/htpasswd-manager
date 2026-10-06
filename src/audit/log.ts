/**
 * Journal d'audit : derniers événements en mémoire (consultables dans l'interface)
 * et copie systématique dans les journaux du conteneur.
 */
import type { FastifyRequest } from 'fastify';

export type AuditEvent = 'auth.login' | 'auth.logout' | 'auth.failure' | 'user.created' | 'user.updated' | 'user.deleted';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  ip: string;
  actor: string | null;
  username?: string;
  algorithm?: string;
}

export class AuditLog {
  #entries: AuditEntry[] = [];
  readonly limit: number;
  readonly now: () => Date;

  constructor({ limit = 500, now = () => new Date() }: { limit?: number; now?: () => Date } = {}) {
    this.limit = limit;
    this.now = now;
  }

  record(request: FastifyRequest, event: AuditEvent, details: { actor?: string | null; username?: string; algorithm?: string } = {}): AuditEntry {
    const entry: AuditEntry = { ts: this.now().toISOString(), event, ip: request.ip, actor: details.actor ?? request.user, ...details };
    this.#entries.push(entry);
    if (this.#entries.length > this.limit) this.#entries.splice(0, this.#entries.length - this.limit);
    request.log[event === 'auth.failure' ? 'warn' : 'info']({ audit: entry }, event);
    return entry;
  }

  /** Événements du plus récent au plus ancien. */
  list(): AuditEntry[] {
    return this.#entries.toReversed();
  }
}
