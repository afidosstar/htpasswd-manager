/**
 * Gestion des utilisateurs du fichier htpasswd.
 */
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Deps } from '../types.ts';
import { HttpError } from '../http/errors.ts';
import { ALGORITHMS, algorithmStrength, detectAlgorithm, hashPassword } from '../htpasswd/hash.ts';
import { validateAlgorithm, validatePassword, validateUsername } from '../validation.ts';

// Les types sont vérifiés finement par validation.js (messages explicites).
const upsertSchema = { body: { type: 'object' } };

interface UpsertBody {
  username?: unknown;
  password?: unknown;
  algorithm?: unknown;
}

const userRoutes: FastifyPluginAsync<Deps> = async (app, { config, store, audit, webhook }) => {
  app.get('/api/meta', async (request) => ({
    file: store.file,
    authEnabled: config.authEnabled,
    user: request.user,
    defaultAlgorithm: config.defaultAlgorithm,
    algorithms: Object.entries(ALGORITHMS).map(([id, v]) => ({ id, ...v })),
  }));

  app.get('/api/users', async () => {
    const { raw, users, modifiedAt } = await store.list();
    return {
      raw,
      modifiedAt,
      reload: webhook ? webhook.status : null,
      users: users.map((u) => {
        const algo = detectAlgorithm(u.hash);
        return { username: u.username, algorithm: algo.id, algorithmLabel: algo.label, strength: algorithmStrength(algo.id) };
      }),
    };
  });

  app.get('/api/audit', async () => ({ entries: audit.list() }));

  app.post<{ Body: UpsertBody }>('/api/users', { schema: upsertSchema }, async (request, reply) => {
    const body = request.body;
    const username = validateUsername(body.username);
    const algorithm = validateAlgorithm(body.algorithm ?? config.defaultAlgorithm);
    const password = validatePassword(body.password, algorithm);
    const hash = await hashPassword(password, algorithm, { bcryptCost: config.bcryptCost, shaRounds: config.shaRounds });
    const { created } = await store.upsert(username, hash);
    audit.record(request, created ? 'user.created' : 'user.updated', { username, algorithm });
    webhook?.schedule();
    return reply.code(created ? 201 : 200).send({ username, algorithm, created });
  });

  app.delete<{ Params: { username: string } }>('/api/users/:username', async (request) => {
    const username = validateUsername(request.params.username);
    if (!(await store.remove(username))) throw new HttpError(404, `L'utilisateur « ${username} » n'existe pas.`);
    audit.record(request, 'user.deleted', { username });
    webhook?.schedule();
    return { username, deleted: true };
  });

  app.get('/api/download', async (request, reply) => {
    const raw = await store.readRaw();
    const name = path.basename(store.file).replace(/[^A-Za-z0-9._-]/g, '_') || 'htpasswd';
    return reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(raw);
  });
};

export default userRoutes;
