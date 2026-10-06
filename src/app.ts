/**
 * Assemblage de l'application Fastify (sans écoute réseau : testable via app.inject).
 */
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { HtpasswdStore } from './htpasswd/store.ts';
import { SessionStore } from './auth/session.ts';
import { LoginThrottle } from './auth/throttle.ts';
import { AuditLog } from './audit/log.ts';
import { registerGuard } from './auth/guard.ts';
import { registerSecurity } from './http/security.ts';
import type { Config } from './config.ts';
import type { Deps } from './types.ts';
import pages from './routes/pages.ts';
import authRoutes from './routes/auth.ts';
import userRoutes from './routes/users.ts';
import './types.ts';

export interface AppOptions extends Partial<Omit<Deps, 'config'>> {
  logger?: FastifyServerOptions['logger'];
  /** Répertoire des fichiers de l'interface (par défaut : dist/public). */
  publicDir?: string;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const deps: Deps = {
    config,
    store: options.store ?? new HtpasswdStore(config.file, { mode: config.fileMode }),
    sessions: options.sessions ?? new SessionStore({ idleMs: config.sessionIdleMs, maxAgeMs: config.sessionMaxAgeMs }),
    throttle: options.throttle ?? new LoginThrottle(),
    audit: options.audit ?? new AuditLog(),
  };

  const app = Fastify({
    logger: options.logger ?? true,
    // Pas de journal par requête : seuls les événements d'audit et les erreurs sont tracés.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: config.maxBody,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
  });

  const purge = setInterval(() => { deps.sessions.purge(); deps.throttle.purge(); }, 60_000).unref();
  app.addHook('onClose', async () => clearInterval(purge));

  await app.register(cookie);
  registerSecurity(app);
  registerGuard(app, deps);

  await app.register(pages, { publicDir: options.publicDir });
  await app.register(authRoutes, deps);
  await app.register(userRoutes, deps);

  return app;
}
