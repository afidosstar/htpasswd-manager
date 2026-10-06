// Tests HTTP de bout en bout (sans réseau) : nécessitent `npm run build` pour dist/public.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { LoginThrottle } from '../src/auth/throttle.ts';

const H = { 'x-requested-with': 'htpasswd-manager' };
let app: FastifyInstance;

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-app-'));
  const config = loadConfig({ HTPASSWD_PATH: path.join(dir, 'passwords'), ADMIN_USER: 'admin', ADMIN_PASSWORD: 'secret', BCRYPT_COST: '4' });
  app = await buildApp(config, { logger: false, publicDir: 'dist/public', throttle: new LoginThrottle({ maxFailures: 3 }) });
});
after(() => app.close());

const login = async (password = 'secret', remoteAddress = '127.0.0.1') => app.inject({
  method: 'POST', url: '/api/login', headers: H, payload: { username: 'admin', password }, remoteAddress,
});

async function session(): Promise<string> {
  const res = await login();
  const c = res.cookies.find((x) => x.name === 'hm_session');
  assert.ok(c);
  return c.value;
}

const as = (token: string, opts: InjectOptions): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> =>
  app.inject({ ...opts, headers: { ...H, ...opts.headers }, cookies: { hm_session: token } });

test('sans session : / redirige, API 401 sans boîte Basic, pages publiques accessibles', async () => {
  const home = await app.inject({ url: '/' });
  assert.equal(home.statusCode, 303);
  assert.equal(home.headers.location, '/login');

  const api = await app.inject({ url: '/api/users' });
  assert.equal(api.statusCode, 401);
  assert.equal(api.headers['www-authenticate'], undefined);

  for (const url of ['/login', '/login.js', '/lib.js', '/app.css', '/healthz']) {
    assert.equal((await app.inject({ url })).statusCode, 200, url);
  }
  for (const url of ['/app.js', '/views/users.js', '/api/audit']) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
  }
});

test('en-têtes de sécurité présents', async () => {
  const res = await app.inject({ url: '/login' });
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('connexion : cookie HttpOnly / SameSite=Strict, Secure derrière HTTPS', async () => {
  const res = await login();
  assert.equal(res.statusCode, 200);
  const c = res.cookies.find((x) => x.name === 'hm_session');
  assert.ok(c?.httpOnly);
  assert.equal(c?.sameSite, 'Strict');
  assert.equal(c?.secure, undefined);

  const https = await app.inject({ method: 'POST', url: '/api/login', headers: { ...H, 'x-forwarded-proto': 'https' }, payload: { username: 'admin', password: 'secret' } });
  assert.equal(https.cookies[0]?.secure, true);
});

test('cycle complet : création, mise à jour, téléchargement, suppression, déconnexion', async () => {
  const t = await session();
  assert.equal((await as(t, { url: '/login' })).statusCode, 303);

  const meta = await as(t, { url: '/api/meta' });
  assert.equal(meta.json().user, 'admin');

  const created = await as(t, { method: 'POST', url: '/api/users', payload: { username: 'alice', password: 'pw', algorithm: 'sha512' } });
  assert.equal(created.statusCode, 201);
  const updated = await as(t, { method: 'POST', url: '/api/users', payload: { username: 'alice', password: 'pw2' } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().algorithm, 'bcrypt-2y');

  await as(t, { method: 'POST', url: '/api/users', payload: { username: 'legacy', password: 'pw', algorithm: 'apr1' } });
  const list = await as(t, { url: '/api/users' });
  assert.deepEqual(list.json().users.map((u: { username: string; strength: string }) => [u.username, u.strength]), [['alice', 'strong'], ['legacy', 'weak']]);
  assert.ok(Date.parse(list.json().modifiedAt) > 0);
  await as(t, { method: 'DELETE', url: '/api/users/legacy' });

  const dl = await as(t, { url: '/api/download' });
  assert.match(dl.body, /^alice:\$2y\$04\$/);
  assert.match(String(dl.headers['content-disposition']), /attachment; filename="passwords"/);

  assert.equal((await as(t, { method: 'DELETE', url: '/api/users/alice' })).statusCode, 200);
  assert.equal((await as(t, { method: 'DELETE', url: '/api/users/alice' })).statusCode, 404);

  const out = await as(t, { method: 'POST', url: '/api/logout' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.cookies[0]?.maxAge, 0);
  assert.equal((await as(t, { url: '/api/users' })).statusCode, 401);
});

test("journal d'audit : événements du plus récent au plus ancien", async () => {
  const t = await session();
  await as(t, { method: 'POST', url: '/api/users', payload: { username: 'carol', password: 'pw' } });
  await as(t, { method: 'DELETE', url: '/api/users/carol' });
  const { entries } = (await as(t, { url: '/api/audit' })).json() as { entries: Array<{ event: string; username?: string; actor: string }> };
  assert.deepEqual(entries.slice(0, 3).map((e) => [e.event, e.username ?? null]), [['user.deleted', 'carol'], ['user.created', 'carol'], ['auth.login', null]]);
  assert.equal(entries[0]?.actor, 'admin');
});

test('validation et formats refusés', async () => {
  const t = await session();
  const bad = await as(t, { method: 'POST', url: '/api/users', payload: { username: '-x', password: 'p' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Identifiant invalide/);

  const text = await as(t, { method: 'POST', url: '/api/users', headers: { 'content-type': 'text/plain' }, payload: 'x' });
  assert.equal(text.statusCode, 415);
  assert.equal(text.json().error, 'Content-Type application/json attendu.');

  const big = await as(t, { method: 'POST', url: '/api/users', payload: { username: 'a', password: 'x'.repeat(10_000) } });
  assert.equal(big.statusCode, 413);
});

test('anti-CSRF : en-tête manquant ou origine étrangère refusés', async () => {
  const t = await session();
  const noHeader = await app.inject({ method: 'POST', url: '/api/users', cookies: { hm_session: t }, payload: { username: 'a', password: 'p' } });
  assert.equal(noHeader.statusCode, 403);
  const foreign = await as(t, { method: 'POST', url: '/api/users', headers: { origin: 'https://evil.example' }, payload: { username: 'a', password: 'p' } });
  assert.equal(foreign.statusCode, 403);
  const site = await as(t, { method: 'DELETE', url: '/api/users/a', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(site.statusCode, 403);
});

test('verrouillage après échecs répétés', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await login('faux', '10.0.0.9')).statusCode, 401);
  const locked = await login('secret', '10.0.0.9');
  assert.equal(locked.statusCode, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal((await login('secret', '10.0.0.10')).statusCode, 200);
});
