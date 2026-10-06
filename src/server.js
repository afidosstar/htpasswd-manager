/**
 * htpasswd-manager — serveur HTTP (node:http, aucun framework).
 */
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ALGORITHMS, BCRYPT_MAX_BYTES, SHA_ROUNDS_DEFAULT, detectAlgorithm, hashPassword } from './hash.js';
import { HtpasswdStore } from './store.js';

/* ------------------------------------------------------------ config */

const env = process.env;

/** Lit VAR ou VAR_FILE (compatible Docker secrets). */
function secret(name) {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return env[name] || '';
}

function intEnv(name, def, min, max) {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

const config = {
  host: env.HOST || '0.0.0.0',
  port: intEnv('PORT', 8080, 1, 65535),
  file: env.HTPASSWD_PATH || '/data/passwords',
  fileMode: Number.parseInt(env.FILE_MODE || '640', 8),
  adminUser: secret('ADMIN_USER'),
  adminPassword: secret('ADMIN_PASSWORD'),
  defaultAlgorithm: env.DEFAULT_ALGORITHM || 'bcrypt-2y',
  bcryptCost: intEnv('BCRYPT_COST', 10, 4, 14),
  shaRounds: intEnv('SHACRYPT_ROUNDS', SHA_ROUNDS_DEFAULT, 1000, 1_000_000),
  maxBody: 8 * 1024,
};

if (!(config.defaultAlgorithm in ALGORITHMS)) {
  console.error(`DEFAULT_ALGORITHM invalide : ${config.defaultAlgorithm}`);
  process.exit(1);
}
if (Boolean(config.adminUser) !== Boolean(config.adminPassword)) {
  // Fail closed : une configuration à moitié faite ne doit jamais ouvrir l'accès.
  console.error('ADMIN_USER et ADMIN_PASSWORD doivent être définis ensemble.');
  process.exit(1);
}
const authEnabled = Boolean(config.adminUser);

/* ------------------------------------------------------------ assets */

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const assetCache = Object.fromEntries(
  Object.entries(ASSETS).map(([route, [file, type]]) => [route, { body: readFileSync(path.join(publicDir, file)), type }]),
);

/* ------------------------------------------------------------ helpers */

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload), ...extra });
  res.end(payload);
}

function audit(action, details) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: action, ...details }));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type application/json attendu.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBody) throw new HttpError(413, 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Corps JSON invalide.');
  }
}

/* ------------------------------------------------------------ validation */

// Jeu de caractères portable POSIX (IEEE Std 1003.1, §3.437), sans « - » initial.
// Exclut de fait espaces, « : », caractères de contrôle et non-ASCII.
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

function validateUsername(u) {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) {
    throw new HttpError(400, "Identifiant invalide : 1 à 64 caractères parmi A-Z a-z 0-9 . _ - (sans « - » au début, ni espace ni « : »).");
  }
  return u;
}

function validatePassword(p, algorithm) {
  if (typeof p !== 'string' || p.length === 0) throw new HttpError(400, 'Le mot de passe est obligatoire.');
  if (p.length > 256) throw new HttpError(400, 'Le mot de passe dépasse 256 caractères.');
  if (/[\r\n\0]/.test(p)) throw new HttpError(400, 'Le mot de passe ne peut pas contenir de retour à la ligne ni de caractère nul.');
  if (algorithm.startsWith('bcrypt') && Buffer.byteLength(p, 'utf8') > BCRYPT_MAX_BYTES) {
    // bcrypt tronque silencieusement au-delà de 72 octets : on refuse plutôt que de tromper l'utilisateur.
    throw new HttpError(400, `Bcrypt ignore tout au-delà de ${BCRYPT_MAX_BYTES} octets : raccourcissez le mot de passe ou choisissez SHA-512.`);
  }
  if (algorithm === 'plain' && /^(\$|\{)/.test(p)) {
    // Un vérificateur interpréterait ce texte brut comme un hash.
    throw new HttpError(400, 'En texte brut, le mot de passe ne peut pas commencer par « $ » ou « { ».');
  }
  return p;
}

function validateAlgorithm(a) {
  if (typeof a !== 'string' || !(a in ALGORITHMS)) throw new HttpError(400, 'Algorithme non supporté.');
  return a;
}

/* ------------------------------------------------------------ security */

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest();
const safeEqual = (a, b) => timingSafeEqual(sha256(a), sha256(b));

const failures = new Map(); // ip -> { count, until }
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 60_000).unref();

function authenticate(req) {
  if (!authEnabled) return 'anonymous';
  const ip = req.socket.remoteAddress || 'unknown';
  const f = failures.get(ip);
  if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
    throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.', { 'Retry-After': String(Math.ceil((f.until - Date.now()) / 1000)) });
  }
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i >= 0) {
      const user = decoded.slice(0, i);
      // Opérateur « & » volontaire : les deux comparaisons sont toujours évaluées.
      if (safeEqual(user, config.adminUser) & safeEqual(decoded.slice(i + 1), config.adminPassword)) {
        failures.delete(ip);
        return user;
      }
      const cur = failures.get(ip) || { count: 0, until: 0 };
      failures.set(ip, { count: cur.count + 1, until: Date.now() + LOCK_MS });
      audit('auth.failure', { ip });
    }
  }
  throw new HttpError(401, 'Authentification requise.', { 'WWW-Authenticate': 'Basic realm="htpasswd-manager", charset="UTF-8"' });
}

/** Anti-CSRF : la Basic Auth est renvoyée automatiquement par le navigateur, on exige donc une requête same-origin. */
function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requête cross-origin refusée.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) throw new HttpError(403, 'Origine refusée.');
  }
  if (req.headers['x-requested-with'] !== 'htpasswd-manager') throw new HttpError(403, 'En-tête X-Requested-With manquant.');
}

/* ------------------------------------------------------------ app */

const store = new HtpasswdStore(config.file, { mode: config.fileMode });

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const method = req.method;

  if (route === '/healthz' && (method === 'GET' || method === 'HEAD')) return send(res, 200, 'ok', 'text/plain; charset=utf-8');

  const actor = authenticate(req);

  if (method === 'GET' && assetCache[route]) {
    const a = assetCache[route];
    return send(res, 200, a.body, a.type, { 'Cache-Control': 'no-cache' });
  }

  if (route === '/api/meta' && method === 'GET') {
    return send(res, 200, {
      file: store.file,
      authEnabled,
      defaultAlgorithm: config.defaultAlgorithm,
      algorithms: Object.entries(ALGORITHMS).map(([id, v]) => ({ id, ...v })),
    });
  }

  if (route === '/api/users' && method === 'GET') {
    const { raw, users } = await store.list();
    return send(res, 200, {
      raw,
      users: users.map((u) => {
        const algo = detectAlgorithm(u.hash);
        return { username: u.username, algorithm: algo.id, algorithmLabel: algo.label };
      }),
    });
  }

  if (route === '/api/users' && method === 'POST') {
    assertSameOrigin(req);
    const body = await readJson(req);
    const username = validateUsername(body.username);
    const algorithm = validateAlgorithm(body.algorithm ?? config.defaultAlgorithm);
    const password = validatePassword(body.password, algorithm);
    const hash = await hashPassword(password, algorithm, { bcryptCost: config.bcryptCost, shaRounds: config.shaRounds });
    const { created } = await store.upsert(username, hash);
    audit(created ? 'user.created' : 'user.updated', { actor, username, algorithm });
    return send(res, created ? 201 : 200, { username, algorithm, created });
  }

  const del = /^\/api\/users\/([^/]+)$/.exec(route);
  if (del && method === 'DELETE') {
    assertSameOrigin(req);
    let name;
    try { name = decodeURIComponent(del[1]); } catch { throw new HttpError(400, 'Identifiant mal encodé.'); }
    const username = validateUsername(name);
    if (!(await store.remove(username))) throw new HttpError(404, `L'utilisateur « ${username} » n'existe pas.`);
    audit('user.deleted', { actor, username });
    return send(res, 200, { username, deleted: true });
  }

  if (route === '/api/download' && method === 'GET') {
    const raw = await store.readRaw();
    const name = path.basename(store.file).replace(/[^A-Za-z0-9._-]/g, '_') || 'htpasswd';
    return send(res, 200, raw, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
  }

  throw new HttpError(404, 'Ressource introuvable.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return send(res, err.status, { error: err.message }, undefined, err.headers);
    console.error('[error]', err);
    send(res, 500, { error: 'Erreur interne : consultez les journaux du conteneur.' });
  });
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

try {
  await store.check();
} catch (err) {
  console.error(`Répertoire ${store.dir} inaccessible en écriture (${err.code}). Vérifiez le volume et les permissions.`);
  process.exit(1);
}

server.listen(config.port, config.host, () => {
  console.log(`htpasswd-manager à l'écoute sur http://${config.host}:${config.port} — fichier : ${store.file}`);
  if (!authEnabled) console.warn('ATTENTION : ADMIN_USER/ADMIN_PASSWORD non définis, interface accessible sans authentification.');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} reçu, arrêt propre…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
