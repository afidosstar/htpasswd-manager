/**
 * Utilitaires communs du front : accès typé au DOM et client de l'API.
 */

/** Élément #id du type attendu (échoue tôt si le HTML ne correspond pas). */
export function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Élément #${id} introuvable ou de type inattendu.`);
  return node;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Appel JSON same-origin avec l'en-tête anti-CSRF attendu par le serveur. */
export async function api<T>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'htpasswd-manager',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data === 'object' && data && 'error' in data ? String(data.error) : `Erreur HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}
