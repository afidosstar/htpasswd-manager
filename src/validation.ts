/**
 * Validation des entrées de l'API.
 */
import { BCRYPT_MAX_BYTES, isAlgorithm, type Algorithm } from './htpasswd/hash.ts';
import { HttpError } from './http/errors.ts';

// Jeu de caractères portable POSIX (IEEE Std 1003.1, §3.437), sans « - » initial.
// Exclut de fait espaces, « : », caractères de contrôle et non-ASCII.
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export function validateUsername(u: unknown): string {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) {
    throw new HttpError(400, "Identifiant invalide : 1 à 64 caractères parmi A-Z a-z 0-9 . _ - (sans « - » au début, ni espace ni « : »).");
  }
  return u;
}

export function validatePassword(p: unknown, algorithm: Algorithm): string {
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

export function validateAlgorithm(a: unknown): Algorithm {
  if (!isAlgorithm(a)) throw new HttpError(400, 'Algorithme non supporté.');
  return a;
}
