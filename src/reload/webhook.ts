/**
 * Webhook de rechargement : prévient un service externe (ex. Dokploy) que le fichier a changé,
 * pour qu'il relance les consommateurs qui ne le relisent qu'au démarrage (Mailpit).
 *
 *  - Regroupement : plusieurs modifications rapprochées ne produisent qu'un appel.
 *  - Nouvelles tentatives en cas d'échec, puis abandon journalisé.
 *  - Un seul appel à la fois ; une modification pendant l'envoi en déclenche un nouveau ensuite.
 */

export interface WebhookConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Corps envoyé tel quel ; null = corps JSON par défaut ({ event, file, ts }). */
  body: string | null;
  delayMs: number;
  timeoutMs: number;
  retryDelaysMs: number[];
}

export type WebhookState = 'idle' | 'pending' | 'sending' | 'ok' | 'failed';

export interface WebhookStatus {
  state: WebhookState;
  /** Fin du dernier envoi (ISO), réussi ou non. */
  at: string | null;
  error: string | null;
}

export interface WebhookEvents {
  onSuccess?: (status: number, attempts: number) => void;
  onFailure?: (error: string, attempts: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Message lisible : fetch masque la cause réelle (ECONNREFUSED, DNS…) derrière « fetch failed ». */
function describe(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return `délai de ${timeoutMs} ms dépassé`;
  return err.cause instanceof Error ? err.cause.message : err.message;
}

export class ReloadWebhook {
  readonly config: WebhookConfig;
  readonly file: string;
  readonly events: WebhookEvents;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | null = null;
  #again = false;
  #closed = false;
  #status: WebhookStatus = { state: 'idle', at: null, error: null };

  constructor(config: WebhookConfig, file: string, events: WebhookEvents = {}) {
    this.config = config;
    this.file = file;
    this.events = events;
  }

  get status(): WebhookStatus {
    return { ...this.#status };
  }

  /** Demande un appel après le délai de regroupement (repoussé à chaque nouvelle demande). */
  schedule(): void {
    if (this.#closed) return;
    if (this.#sending) {
      this.#again = true;
      return;
    }
    clearTimeout(this.#timer);
    this.#status = { ...this.#status, state: 'pending' };
    this.#timer = setTimeout(() => void this.#flush(), this.config.delayMs);
  }

  /** Arrêt : annule l'appel en attente et attend la fin d'un envoi en cours. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#sending;
  }

  async #flush(): Promise<void> {
    this.#sending = this.#send().finally(() => {
      this.#sending = null;
      if (this.#again && !this.#closed) {
        this.#again = false;
        this.schedule();
      }
    });
    await this.#sending;
  }

  async #send(): Promise<void> {
    this.#status = { ...this.#status, state: 'sending' };
    const { url, method, headers, body, timeoutMs, retryDelaysMs } = this.config;
    const payload = body ?? JSON.stringify({ event: 'htpasswd.changed', file: this.file, ts: new Date().toISOString() });
    let error = '';
    let attempt = 0;

    while (attempt <= retryDelaysMs.length) {
      attempt++;
      try {
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json', 'user-agent': 'htpasswd-manager', ...headers },
          body: method === 'GET' || method === 'HEAD' ? undefined : payload,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        await res.body?.cancel();
        if (res.ok) {
          this.#status = { state: 'ok', at: new Date().toISOString(), error: null };
          this.events.onSuccess?.(res.status, attempt);
          return;
        }
        error = `HTTP ${res.status}`;
      } catch (err) {
        error = describe(err, timeoutMs);
      }
      const wait = retryDelaysMs[attempt - 1];
      if (wait === undefined || this.#closed) break;
      await sleep(wait);
    }

    this.#status = { state: 'failed', at: new Date().toISOString(), error };
    this.events.onFailure?.(error, attempt);
  }
}
