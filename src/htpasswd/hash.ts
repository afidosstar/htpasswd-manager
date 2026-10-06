/**
 * Implémentations des formats de hachage compatibles htpasswd / crypt(3).
 *
 *  - MD5-crypt ($1$) et APR1 ($apr1$) : algorithme de Poul-Henning Kamp
 *  - SHA-crypt ($5$ / $6$)            : spécification d'Ulrich Drepper
 *  - SHA ({SHA}) / SSHA ({SSHA})      : formats LDAP / Apache
 *  - Bcrypt ($2y$ / $2a$)             : bcryptjs (implémentation pure JS, sans binaire natif)
 *
 * Seules les primitives de node:crypto (MD5, SHA-1, SHA-256, SHA-512, CSPRNG)
 * sont utilisées : aucun code natif tiers.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type Algorithm = 'bcrypt-2y' | 'bcrypt-2a' | 'sha512' | 'sha256' | 'apr1' | 'md5' | 'ssha' | 'sha' | 'plain';
export type DetectedAlgorithm = Algorithm | 'bcrypt-2b' | 'des' | 'plain-prefixed';

export interface AlgorithmInfo {
  label: string;
  hint: string;
}

export interface HashOptions {
  bcryptCost?: number;
  shaRounds?: number;
}

export const ALGORITHMS: Readonly<Record<Algorithm, AlgorithmInfo>> = Object.freeze({
  'bcrypt-2y': { label: 'Bcrypt ($2y$)', hint: 'Recommandé. Format par défaut de htpasswd\u00a0-B.' },
  'bcrypt-2a': { label: 'Bcrypt ($2a$)', hint: 'Variante pour les outils qui ne reconnaissent pas $2y$.' },
  sha512: { label: 'SHA-512 crypt ($6$)', hint: 'Format glibc crypt(3), salé et itéré.' },
  sha256: { label: 'SHA-256 crypt ($5$)', hint: 'Format glibc crypt(3), salé et itéré.' },
  apr1: { label: 'APR1 MD5 ($apr1$)', hint: 'Format historique de htpasswd\u00a0-m. Reconnu partout, cryptographiquement faible.' },
  md5: { label: 'MD5 crypt ($1$)', hint: 'Format glibc historique. Cryptographiquement faible.' },
  ssha: { label: 'SSHA ({SSHA})', hint: 'SHA-1 salé façon LDAP. Rapide donc faible face au brute-force.' },
  sha: { label: 'SHA-1 ({SHA})', hint: 'Non salé : deux mots de passe identiques donnent le même hash. Déconseillé.' },
  plain: { label: 'Texte brut', hint: 'Aucun hachage : le mot de passe est lisible dans le fichier. Tests uniquement.' },
});

export type Strength = 'strong' | 'weak' | 'none';

const STRENGTH: Record<DetectedAlgorithm, Strength> = {
  'bcrypt-2y': 'strong', 'bcrypt-2a': 'strong', 'bcrypt-2b': 'strong', sha512: 'strong', sha256: 'strong',
  apr1: 'weak', md5: 'weak', ssha: 'weak', sha: 'weak', des: 'weak',
  plain: 'none', 'plain-prefixed': 'none',
};

/** Robustesse d'un format face au brute-force : fort (lent et salé), faible, aucun (texte brut). */
export const algorithmStrength = (id: DetectedAlgorithm): Strength => STRENGTH[id];

export const isAlgorithm = (a: unknown): a is Algorithm => typeof a === 'string' && Object.hasOwn(ALGORITHMS, a);

const DETECT_LABELS: Record<DetectedAlgorithm, string> = {
  ...(Object.fromEntries(Object.entries(ALGORITHMS).map(([k, v]) => [k, v.label])) as Record<Algorithm, string>),
  'bcrypt-2b': 'Bcrypt ($2b$)',
  des: 'DES crypt (hérité)',
  'plain-prefixed': 'Texte brut ({PLAIN})',
};

export const BCRYPT_MAX_BYTES = 72;

/* ------------------------------------------------------------------ utils */

function to64(value: number, n: number): string {
  let out = '';
  while (n-- > 0) {
    out += ITOA64.charAt(value & 0x3f);
    value >>>= 6;
  }
  return out;
}

function b64From24(buf: Buffer, a: number, b: number, c: number, n: number): string {
  return to64((byte(buf, a) << 16) | (byte(buf, b) << 8) | byte(buf, c), n);
}

/** Octet à l'index i (les index sont toujours dans les bornes : contrôle pour le typage strict). */
function byte(buf: Buffer, i: number): number {
  const v = buf[i];
  if (v === undefined) throw new RangeError(`index ${i} hors limites`);
  return v;
}

export function randomSalt(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ITOA64.charAt(randomInt(64));
  return s;
}

function repeatTo(src: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let off = 0; off < length; off += src.length) src.copy(out, off, 0, Math.min(src.length, length - off));
  return out;
}

/* ------------------------------------------------------ MD5-crypt / APR1 */

export function md5crypt(password: string, magic: '$1$' | '$apr1$' = '$1$', salt: string = randomSalt(8)): string {
  const pw = Buffer.from(password, 'utf8');
  salt = salt.slice(0, 8);
  const s = Buffer.from(salt, 'utf8');

  let fin = createHash('md5').update(pw).update(s).update(pw).digest();

  const ctx = createHash('md5').update(pw).update(magic).update(s);
  for (let pl = pw.length; pl > 0; pl -= 16) ctx.update(fin.subarray(0, Math.min(pl, 16)));
  for (let i = pw.length; i; i >>= 1) ctx.update((i & 1) ? Buffer.alloc(1) : pw.subarray(0, 1));
  fin = ctx.digest();

  for (let i = 0; i < 1000; i++) {
    const c = createHash('md5');
    c.update((i & 1) ? pw : fin);
    if (i % 3) c.update(s);
    if (i % 7) c.update(pw);
    c.update((i & 1) ? fin : pw);
    fin = c.digest();
  }

  return magic + salt + '$'
    + b64From24(fin, 0, 6, 12, 4)
    + b64From24(fin, 1, 7, 13, 4)
    + b64From24(fin, 2, 8, 14, 4)
    + b64From24(fin, 3, 9, 15, 4)
    + b64From24(fin, 4, 10, 5, 4)
    + to64(byte(fin, 11), 2);
}

/* ------------------------------------------------------------ SHA-crypt */

type ShaAlgo = 'sha256' | 'sha512';

interface ShaSpec {
  magic: string;
  order: ReadonlyArray<readonly [number, number, number]>;
  tail: (c: Buffer) => string;
}

const SHA_CRYPT: Record<ShaAlgo, ShaSpec> = {
  sha256: {
    magic: '$5$',
    order: [[0, 10, 20], [21, 1, 11], [12, 22, 2], [3, 13, 23], [24, 4, 14],
      [15, 25, 5], [6, 16, 26], [27, 7, 17], [18, 28, 8], [9, 19, 29]],
    tail: (c) => to64((byte(c, 31) << 8) | byte(c, 30), 3),
  },
  sha512: {
    magic: '$6$',
    order: [[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26],
      [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32],
      [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38],
      [18, 39, 60], [40, 61, 19], [62, 20, 41]],
    tail: (c) => to64(byte(c, 63), 2),
  },
};

export const SHA_ROUNDS_DEFAULT = 5000;

export function shacrypt(password: string, algo: ShaAlgo, { salt = randomSalt(16), rounds = SHA_ROUNDS_DEFAULT }: { salt?: string; rounds?: number } = {}): string {
  const spec = SHA_CRYPT[algo];
  if (!spec) throw new Error(`Algorithme SHA-crypt inconnu : ${algo}`);
  rounds = Math.min(999_999_999, Math.max(1000, Math.trunc(rounds)));
  const customRounds = rounds !== SHA_ROUNDS_DEFAULT;

  const P = Buffer.from(password, 'utf8');
  salt = salt.slice(0, 16);
  const S = Buffer.from(salt, 'utf8');
  const H = () => createHash(algo);

  const B = H().update(P).update(S).update(P).digest();
  const a = H().update(P).update(S);
  let n;
  for (n = P.length; n > B.length; n -= B.length) a.update(B);
  a.update(B.subarray(0, n));
  for (n = P.length; n > 0; n >>= 1) a.update((n & 1) ? B : P);
  let C = a.digest();

  const dp = H();
  for (let i = 0; i < P.length; i++) dp.update(P);
  const Pp = repeatTo(dp.digest(), P.length);

  const ds = H();
  for (let i = 0; i < 16 + byte(C, 0); i++) ds.update(S);
  const Sp = repeatTo(ds.digest(), S.length);

  for (let r = 0; r < rounds; r++) {
    const c = H();
    c.update((r & 1) ? Pp : C);
    if (r % 3) c.update(Sp);
    if (r % 7) c.update(Pp);
    c.update((r & 1) ? C : Pp);
    C = c.digest();
  }

  let out = spec.magic + (customRounds ? `rounds=${rounds}$` : '') + salt + '$';
  for (const [x, y, z] of spec.order) out += b64From24(C, x, y, z, 4);
  return out + spec.tail(C);
}

/* --------------------------------------------------------- SHA / SSHA */

export function sha1Apache(password: string): string {
  return '{SHA}' + createHash('sha1').update(password, 'utf8').digest('base64');
}

export function ssha(password: string, salt: Buffer = randomBytes(8)): string {
  const digest = createHash('sha1').update(password, 'utf8').update(salt).digest();
  return '{SSHA}' + Buffer.concat([digest, salt]).toString('base64');
}

/* ------------------------------------------------------------- bcrypt */

export async function bcryptHash(password: string, { cost = 10, variant = '2y' }: { cost?: number; variant?: '2a' | '2y' } = {}): Promise<string> {
  const hash = await bcrypt.hash(password, await bcrypt.genSalt(cost));
  // $2a$, $2b$ et $2y$ sont algorithmiquement identiques pour bcryptjs :
  // seul le préfixe change pour la compatibilité des vérificateurs.
  return hash.replace(/^\$2[abxy]\$/, `$${variant}$`);
}

/* ---------------------------------------------------------- façade */

/**
 * Hache `password` selon `algorithm`.
 * @returns la partie « hash » d'une ligne htpasswd.
 */
export async function hashPassword(password: string, algorithm: Algorithm, opts: HashOptions = {}): Promise<string> {
  switch (algorithm) {
    case 'bcrypt-2y': return bcryptHash(password, { cost: opts.bcryptCost, variant: '2y' });
    case 'bcrypt-2a': return bcryptHash(password, { cost: opts.bcryptCost, variant: '2a' });
    case 'sha512':
    case 'sha256': return shacrypt(password, algorithm, { rounds: opts.shaRounds });
    case 'apr1': return md5crypt(password, '$apr1$');
    case 'md5': return md5crypt(password, '$1$');
    case 'ssha': return ssha(password);
    case 'sha': return sha1Apache(password);
    case 'plain': return password;
    default: throw new Error(`Algorithme non supporté : ${algorithm satisfies never}`);
  }
}

/** Identifie le format d'un hash existant (lecture du fichier). */
export function detectAlgorithm(hash: string): { id: DetectedAlgorithm; label: string } {
  let id: DetectedAlgorithm;
  if (/^\$2y\$\d{2}\$/.test(hash)) id = 'bcrypt-2y';
  else if (/^\$2a\$\d{2}\$/.test(hash)) id = 'bcrypt-2a';
  else if (/^\$2b\$\d{2}\$/.test(hash)) id = 'bcrypt-2b';
  else if (hash.startsWith('$apr1$')) id = 'apr1';
  else if (hash.startsWith('$1$')) id = 'md5';
  else if (hash.startsWith('$5$')) id = 'sha256';
  else if (hash.startsWith('$6$')) id = 'sha512';
  else if (hash.startsWith('{SSHA}')) id = 'ssha';
  else if (hash.startsWith('{SHA}')) id = 'sha';
  else if (hash.startsWith('{PLAIN}')) id = 'plain-prefixed';
  else if (/^[./0-9A-Za-z]{13}$/.test(hash)) id = 'des';
  else id = 'plain';
  return { id, label: DETECT_LABELS[id] };
}
