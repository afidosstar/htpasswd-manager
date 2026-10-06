/**
 * Vue « Journal d'audit » : derniers événements (connexions, modifications de comptes).
 */
import { el, errorMessage } from '../lib.js';
import { call, formatDate, timeAgo, toast } from '../ui.js';
import type { AuditEntry, AuditEvent } from '../types.js';

const EVENTS: Record<AuditEvent, { label: string; tone: 'ok' | 'bad' | 'info' | '' }> = {
  'auth.login': { label: 'Connexion', tone: 'ok' },
  'auth.logout': { label: 'Déconnexion', tone: '' },
  'auth.failure': { label: 'Échec de connexion', tone: 'bad' },
  'user.created': { label: 'Compte créé', tone: 'info' },
  'user.updated': { label: 'Mot de passe changé', tone: 'info' },
  'user.deleted': { label: 'Compte supprimé', tone: 'bad' },
};

function cell(text: string, className = ''): HTMLTableCellElement {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

export function createAuditView() {
  const body = el('audit-body', HTMLTableSectionElement);
  const empty = el('audit-empty', HTMLParagraphElement);

  function row(e: AuditEntry): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const when = cell(timeAgo(e.ts), 'when');
    when.title = formatDate(e.ts);

    const ev = document.createElement('td');
    const tag = document.createElement('span');
    const info = EVENTS[e.event];
    tag.className = `event ${info.tone}`.trim();
    tag.textContent = info.label;
    ev.append(tag);

    tr.append(when, ev, cell(e.username ?? '—', 'who'), cell(e.actor ?? '—', 'who'), cell(e.ip, 'ip'));
    return tr;
  }

  async function load(): Promise<void> {
    try {
      const { entries } = await call<{ entries: AuditEntry[] }>('/api/audit');
      body.replaceChildren(...entries.map(row));
      empty.hidden = entries.length > 0;
    } catch (err) {
      toast(`Journal indisponible : ${errorMessage(err)}`, true);
    }
  }

  return { load };
}
