/** Réponses de l'API consommées par l'interface. */

export type Strength = 'strong' | 'weak' | 'none';

export interface AlgorithmInfo { id: string; label: string; hint: string }

export interface Meta {
  file: string;
  authEnabled: boolean;
  user: string;
  defaultAlgorithm: string;
  algorithms: AlgorithmInfo[];
}

export interface User { username: string; algorithm: string; algorithmLabel: string; strength: Strength }

export interface UsersResponse { raw: string; modifiedAt: string | null; users: User[] }

export type AuditEvent = 'auth.login' | 'auth.logout' | 'auth.failure' | 'user.created' | 'user.updated' | 'user.deleted';

export interface AuditEntry { ts: string; event: AuditEvent; ip: string; actor: string | null; username?: string; algorithm?: string }
