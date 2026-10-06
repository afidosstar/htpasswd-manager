/**
 * Garde d'authentification (hook Fastify) : session par cookie et anti-CSRF.
 *
 * Toute route est protégée sauf celles déclarées avec `config: { public: true }`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { HttpError } from '../http/errors.ts';
import type { Config } from '../config.ts';
import type { SessionStore } from './session.ts';

export const SESSION_COOKIE = 'hm_session';

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Comparaison en temps constant des identifiants administrateur. */
export function credentialsMatch(config: Config, user: string, password: string): boolean {
  // Les deux comparaisons sont toujours évaluées : pas de court-circuit révélant l'identifiant.
  const userOk = safeEqual(user, config.adminUser);
  const passwordOk = safeEqual(password, config.adminPassword);
  return userOk && passwordOk;
}

function isHttps(request: FastifyRequest): boolean {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  return request.protocol === 'https' || forwarded === 'https';
}

export function cookieOptions(request: FastifyRequest, config: Config, maxAgeMs: number): CookieSerializeOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && isHttps(request)),
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** Anti-CSRF : en complément du cookie SameSite=Strict, on exige une requête same-origin. */
export function assertSameOrigin(request: FastifyRequest): void {
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requête cross-origin refusée.');
  const origin = request.headers.origin;
  if (origin) {
    let host: string | null;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== request.headers.host) throw new HttpError(403, 'Origine refusée.');
  }
  if (request.headers['x-requested-with'] !== 'htpasswd-manager') throw new HttpError(403, 'En-tête X-Requested-With manquant.');
}

/** Installe le hook de garde sur l'instance racine. */
export function registerGuard(app: FastifyInstance, { config, sessions }: { config: Config; sessions: SessionStore }): void {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    request.user = config.authEnabled ? sessions.get(request.cookies[SESSION_COOKIE]) : 'anonymous';

    if (!SAFE_METHODS.has(request.method)) assertSameOrigin(request);
    if (request.user || request.routeOptions.config?.public) return;

    // Navigation HTML -> page de connexion ; appels API -> 401 JSON.
    if (request.method === 'GET' && request.routeOptions.url === '/') return reply.redirect('/login', 303);
    throw new HttpError(401, 'Authentification requise.');
  });
}
