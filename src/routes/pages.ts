/**
 * Pages et ressources statiques de l'interface.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { loadAssets, type Asset } from '../http/static.ts';

// Accessibles sans session : la page de connexion et ce qu'elle charge.
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/lib.js', '/app.css']);
// Les pages HTML sont servies sans extension.
const PAGE_ROUTES: Record<string, string> = { '/index.html': '/', '/login.html': '/login' };

const send = (asset: Asset) => (_request: FastifyRequest, reply: FastifyReply) =>
  reply.type(asset.type).header('Cache-Control', 'no-cache').send(asset.body);

const pages: FastifyPluginAsync<{ publicDir?: string }> = async (app, { publicDir }) => {
  for (const [file, asset] of loadAssets(publicDir)) {
    const route = PAGE_ROUTES[file] ?? file;
    if (route.endsWith('.html')) continue;
    const config = { public: PUBLIC_FILES.has(file) };
    if (route === '/login') {
      // Déjà connecté : inutile de revoir la page de connexion.
      app.get(route, { config }, (request, reply) => (request.user ? reply.redirect('/', 303) : send(asset)(request, reply)));
    } else {
      // Routes protégées : la garde redirige « / » vers /login et répond 401 ailleurs.
      app.get(route, { config }, send(asset));
    }
  }

  app.get('/healthz', { config: { public: true } }, (_request, reply) => reply.type('text/plain; charset=utf-8').send('ok'));
};

export default pages;
