/**
 * En-têtes de sécurité communs et format unique des erreurs ({ error }).
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { HttpError } from './errors.ts';

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'no-store',
});

// Erreurs internes de Fastify traduites pour l'utilisateur.
const FASTIFY_MESSAGES: Record<string, string> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Content-Type application/json attendu.',
  FST_ERR_CTP_BODY_TOO_LARGE: 'Requête trop volumineuse.',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'Corps JSON invalide.',
  FST_ERR_CTP_INVALID_JSON_BODY: 'Corps JSON invalide.',
  FST_ERR_VALIDATION: 'Corps JSON invalide.',
};

export function registerSecurity(app: FastifyInstance): void {
  // Seul le JSON est accepté : un formulaire ou du text/plain cross-site ne passe pas (anti-CSRF).
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).headers(err.headers).send({ error: err.message });
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: FASTIFY_MESSAGES[err.code] ?? (err.validation ? 'Corps JSON invalide.' : 'Requête invalide.') });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'Erreur interne : consultez les journaux du conteneur.' });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Ressource introuvable.' }));
}
