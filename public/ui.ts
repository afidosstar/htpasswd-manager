/**
 * Briques d'interface partagées par les vues : icônes, notifications, confirmation, dates.
 */
import { ApiError, api, el } from './lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icône du sprite inline de index.html (#i-<nom>). */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Bouton icône accessible. */
export function iconButton(name: string, label: string, onClick: (ev: MouseEvent) => void, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn ${className}`.trim();
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(name));
  b.addEventListener('click', onClick);
  return b;
}

/** Appel API : une 401 (session expirée) renvoie vers la page de connexion. */
export async function call<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await api<T>(path, options);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) location.replace('/login');
    throw err;
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, isError = false): void {
  const t = el('toast', HTMLDivElement);
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2600);
}

/** Fenêtre de confirmation (remplace window.confirm). Résout true si l'utilisateur confirme. */
export function confirmAction(title: string, text: string, confirmLabel: string): Promise<boolean> {
  const dialog = el('confirm-dialog', HTMLDialogElement);
  el('confirm-title', HTMLHeadingElement).textContent = title;
  el('confirm-text', HTMLParagraphElement).textContent = text;
  el('confirm-ok', HTMLButtonElement).textContent = confirmLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}

const RELATIVE = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const ABSOLUTE = new Intl.DateTimeFormat('fr', { dateStyle: 'short', timeStyle: 'medium' });

/** « il y a 3 minutes », « hier »… */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12]];
  let value = s;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return unit === 'second' && Math.abs(value) < 10 ? "à l'instant" : RELATIVE.format(value, unit);
    value = Math.round(value / size);
  }
  return RELATIVE.format(value, 'year');
}

export const formatDate = (iso: string): string => ABSOLUTE.format(new Date(iso));
