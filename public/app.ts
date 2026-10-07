/**
 * Point d'entrée de l'interface : chargement initial, navigation entre les vues (#users, #file, #audit).
 */
import { api, el, errorMessage } from './lib.js';
import { call, toast } from './ui.js';
import { createUsersView } from './views/users.js';
import { createFileView } from './views/file.js';
import { createAuditView } from './views/audit.js';
import type { Meta, UsersResponse } from './types.js';

const VIEWS = ['users', 'file', 'audit'] as const;
type View = (typeof VIEWS)[number];
const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);

async function init(): Promise<void> {
  const meta = await call<Meta>('/api/meta');
  let data: UsersResponse = { raw: '', modifiedAt: null, users: [], reload: null };

  const usersView = createUsersView({ meta, data: () => data, refresh });
  const fileView = createFileView(() => data.raw);
  const auditView = createAuditView();

  async function refresh(): Promise<void> {
    data = await call<UsersResponse>('/api/users');
    el('nav-users-count', HTMLElement).textContent = String(data.users.length);
    usersView.render();
    fileView.render();
  }

  function show(view: View): void {
    for (const section of document.querySelectorAll<HTMLElement>('[data-view]')) section.hidden = section.dataset.view !== view;
    for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-nav]')) {
      if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (view !== 'users') usersView.closeDrawer();
    if (view === 'audit') void auditView.load();
    document.title = `${{ users: 'Utilisateurs', file: 'Fichier brut', audit: "Journal d'audit" }[view]} · htpasswd-manager`;
  }

  const route = () => {
    const v = location.hash.slice(1);
    show(isView(v) ? v : 'users');
  };
  window.addEventListener('hashchange', route);

  // Compte connecté et déconnexion.
  el('account-name', HTMLSpanElement).textContent = meta.authEnabled ? meta.user : 'Accès libre';
  el('open-warning', HTMLParagraphElement).hidden = meta.authEnabled;
  const logout = el('logout-btn', HTMLButtonElement);
  logout.hidden = !meta.authEnabled;
  logout.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } finally { location.replace('/login'); }
  });

  await refresh();
  route();
}

init().catch((err: unknown) => toast(`Chargement impossible : ${errorMessage(err)}`, true));
