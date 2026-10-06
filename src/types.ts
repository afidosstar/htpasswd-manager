/**
 * Types partagés et extensions des types Fastify.
 */
import type { HtpasswdStore } from './htpasswd/store.ts';
import type { SessionStore } from './auth/session.ts';
import type { LoginThrottle } from './auth/throttle.ts';
import type { Config } from './config.ts';
import type { AuditLog } from './audit/log.ts';

/** Dépendances injectées dans les plugins de routes. */
export interface Deps {
  config: Config;
  store: HtpasswdStore;
  sessions: SessionStore;
  throttle: LoginThrottle;
  audit: AuditLog;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Utilisateur authentifié, « anonymous » si l'authentification est désactivée, sinon null. */
    user: string | null;
  }
  interface FastifyContextConfig {
    /** Route accessible sans session. */
    public?: boolean;
  }
}
