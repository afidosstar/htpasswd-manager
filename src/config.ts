/**
 * Configuration lue depuis l'environnement (compatible Docker secrets via VAR_FILE).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { SHA_ROUNDS_DEFAULT, isAlgorithm, type Algorithm } from './htpasswd/hash.ts';

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;
export type CookieSecure = 'auto' | 'true' | 'false';

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly file: string;
  readonly fileMode: number;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly authEnabled: boolean;
  readonly defaultAlgorithm: Algorithm;
  readonly bcryptCost: number;
  readonly shaRounds: number;
  readonly sessionIdleMs: number;
  readonly sessionMaxAgeMs: number;
  readonly cookieSecure: CookieSecure;
  readonly trustProxy: boolean;
  readonly maxBody: number;
}

function intEnv(env: Env, name: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

/** Lit VAR ou VAR_FILE. */
function secret(env: Env, name: string): string {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return env[name] || '';
}

/**
 * Charge un fichier dotenv dans `env` sans écraser les variables déjà définies
 * (l'environnement réel du conteneur reste prioritaire).
 *
 * Fichier : ENV_FILE si défini (obligatoire alors), sinon ./.env s'il existe.
 * @returns le chemin chargé et s'il est lisible par d'autres utilisateurs, ou null si aucun fichier.
 */
export function loadEnvFile(env: Env = process.env, cwd: string = process.cwd()): { file: string; exposed: boolean } | null {
  const explicit = env.ENV_FILE;
  const file = path.resolve(cwd, explicit || '.env');
  if (!existsSync(file)) {
    if (explicit) throw new ConfigError(`ENV_FILE introuvable : ${file}`);
    return null;
  }
  let values: Record<string, string>;
  try {
    values = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch (err) {
    throw new ConfigError(`Lecture de ${file} impossible : ${(err as Error).message}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  // Le fichier contient ADMIN_PASSWORD : il ne doit être lisible que par son propriétaire (chmod 600).
  const exposed = process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0;
  return { file, exposed };
}

export function loadConfig(env: Env = process.env): Config {
  const defaultAlgorithm = env.DEFAULT_ALGORITHM || 'bcrypt-2y';
  if (!isAlgorithm(defaultAlgorithm)) throw new ConfigError(`DEFAULT_ALGORITHM invalide : ${defaultAlgorithm}`);

  const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();
  if (cookieSecure !== 'auto' && cookieSecure !== 'true' && cookieSecure !== 'false') {
    throw new ConfigError(`COOKIE_SECURE invalide : ${cookieSecure} (auto, true ou false)`);
  }

  const rawMode = env.FILE_MODE || '0640';
  if (!/^0?[0-7]{3}$/.test(rawMode)) throw new ConfigError(`FILE_MODE invalide : ${rawMode} (octal, ex. 0640)`);
  const fileMode = Number.parseInt(rawMode, 8);
  if (fileMode & 0o002) throw new ConfigError(`FILE_MODE ${rawMode} refusé : le fichier serait modifiable par tous.`);

  const adminUser = secret(env, 'ADMIN_USER');
  const adminPassword = secret(env, 'ADMIN_PASSWORD');
  if (Boolean(adminUser) !== Boolean(adminPassword)) {
    // Fail closed : une configuration à moitié faite ne doit jamais ouvrir l'accès.
    throw new ConfigError('ADMIN_USER et ADMIN_PASSWORD doivent être définis ensemble.');
  }

  return Object.freeze({
    host: env.HOST || '0.0.0.0',
    port: intEnv(env, 'PORT', 8080, 1, 65535),
    file: env.HTPASSWD_PATH || './data/passwords',
    fileMode,
    adminUser,
    adminPassword,
    authEnabled: Boolean(adminUser),
    defaultAlgorithm,
    bcryptCost: intEnv(env, 'BCRYPT_COST', 10, 4, 14),
    shaRounds: intEnv(env, 'SHACRYPT_ROUNDS', SHA_ROUNDS_DEFAULT, 1000, 1_000_000),
    sessionIdleMs: intEnv(env, 'SESSION_IDLE_MINUTES', 60, 1, 24 * 60) * 60_000,
    sessionMaxAgeMs: intEnv(env, 'SESSION_MAX_HOURS', 12, 1, 24 * 30) * 3_600_000,
    // auto : Secure si la requête arrive en HTTPS (directement ou via X-Forwarded-Proto).
    cookieSecure,
    // À activer derrière un reverse proxy : l'IP client (verrouillage) vient alors de X-Forwarded-For.
    trustProxy: env.TRUST_PROXY === 'true',
    maxBody: 8 * 1024,
  });
}
