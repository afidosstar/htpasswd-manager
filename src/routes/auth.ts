/**
 * Connexion / déconnexion de l'interface.
 */
import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '../http/errors.ts';
import type { Deps } from '../types.ts';
import { SESSION_COOKIE, cookieOptions, credentialsMatch } from '../auth/guard.ts';

interface LoginBody {
  username: string;
  password: string;
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', maxLength: 256 },
      password: { type: 'string', maxLength: 256 },
    },
  },
};

const authRoutes: FastifyPluginAsync<Deps> = async (app, { config, sessions, throttle, audit }) => {
  app.post<{ Body: LoginBody }>('/api/login', { config: { public: true }, schema: loginSchema }, async (request, reply) => {
    if (!config.authEnabled) return { username: request.user };

    const { ip } = request;
    throttle.assertAllowed(ip);
    const { username, password } = request.body;
    if (!credentialsMatch(config, username, password)) {
      throttle.fail(ip);
      // Identifiant tenté non journalisé : un mot de passe saisi dans le mauvais champ y finirait en clair.
      audit.record(request, 'auth.failure', { actor: null });
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
    }
    throttle.reset(ip);

    const token = sessions.create(username);
    audit.record(request, 'auth.login', { actor: username });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(request, config, config.sessionMaxAgeMs));
    return { username };
  });

  app.post('/api/logout', { config: { public: true } }, async (request, reply) => {
    if (sessions.destroy(request.cookies[SESSION_COOKIE])) {
      audit.record(request, 'auth.logout');
    }
    reply.clearCookie(SESSION_COOKIE, cookieOptions(request, config, 0));
    return { loggedOut: true };
  });
};

export default authRoutes;
