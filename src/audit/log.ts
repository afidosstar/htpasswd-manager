/**
 * Journal d'audit : derniers événements en mémoire (consultables dans l'interface)
 * et copie systématique dans les journaux du conteneur.
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn'>;

export type AuditEvent = 'auth.login' | 'auth.logout' | 'auth.failure' | 'user.created' | 'user.updated' | 'user.deleted' | 'reload.sent' | 'reload.failed';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  ip: string;
  actor: string | null;
  username?: string;
  algorithm?: string;
  /** Détail technique (code HTTP, erreur réseau…). */
  detail?: string;
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
    return this.#push({ ts: this.now().toISOString(), event, ip: request.ip, actor: details.actor ?? request.user, ...details }, request.log);
  }

  /** Événement émis par le serveur lui-même (hors requête), ex. résultat du webhook. */
  system(log: Logger, event: AuditEvent, detail: string): AuditEntry {
    return this.#push({ ts: this.now().toISOString(), event, ip: '', actor: 'système', detail }, log);
  }

  #push(entry: AuditEntry, log: Logger): AuditEntry {
    this.#entries.push(entry);
    if (this.#entries.length > this.limit) this.#entries.splice(0, this.#entries.length - this.limit);
    log[entry.event.endsWith('failure') || entry.event.endsWith('failed') ? 'warn' : 'info']({ audit: entry }, entry.event);
    return entry;
  }

  /** Événements du plus récent au plus ancien. */
  list(): AuditEntry[] {
    return this.#entries.toReversed();
  }
}
