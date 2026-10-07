/**
 * Vue « Utilisateurs » : résumé de sécurité, liste filtrable et panneau d'ajout / modification.
 */
import { el, errorMessage } from '../lib.js';
import { call, confirmAction, iconButton, timeAgo, toast } from '../ui.js';
import type { Meta, ReloadStatus, Strength, User, UsersResponse } from '../types.js';

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const STRENGTH_LABEL: Record<Strength, string> = { strong: 'Fort', weak: 'Faible', none: 'Aucun' };

export interface UsersContext {
  meta: Meta;
  data: () => UsersResponse;
  refresh: () => Promise<void>;
}

export function createUsersView(ctx: UsersContext) {
  const ui = {
    filePath: el('file-path', HTMLSpanElement),
    modified: el('file-modified', HTMLSpanElement),
    reload: el('reload-state', HTMLSpanElement),
    summary: el('summary', HTMLDivElement),
    search: el('search', HTMLInputElement),
    body: el('users-body', HTMLTableSectionElement),
    empty: el('users-empty', HTMLParagraphElement),
    add: el('add-btn', HTMLButtonElement),
    drawer: el('drawer', HTMLElement),
    drawerTitle: el('drawer-title', HTMLHeadingElement),
    drawerClose: el('drawer-close', HTMLButtonElement),
    form: el('user-form', HTMLFormElement),
    username: el('username', HTMLInputElement),
    password: el('password', HTMLInputElement),
    toggle: el('toggle-password', HTMLButtonElement),
    generate: el('generate-password', HTMLButtonElement),
    algorithm: el('algorithm', HTMLSelectElement),
    hint: el('algorithm-hint', HTMLParagraphElement),
    error: el('form-error', HTMLParagraphElement),
    submit: el('submit-btn', HTMLButtonElement),
    cancel: el('cancel-btn', HTMLButtonElement),
    remove: el('delete-btn', HTMLButtonElement),
  };

  /** Compte en cours de modification (null = création). */
  let editing: string | null = null;

  /* ---------------------------------------------------------- rendu */

  function stat(value: number, label: string, cls = ''): HTMLDivElement {
    const d = document.createElement('div');
    d.className = `stat ${cls}`.trim();
    const n = document.createElement('strong');
    n.textContent = String(value);
    const l = document.createElement('span');
    l.textContent = label;
    d.append(n, l);
    return d;
  }

  function renderSummary(users: User[]): void {
    const count = (s: Strength) => users.filter((u) => u.strength === s).length;
    const items = [stat(users.length, users.length > 1 ? 'comptes' : 'compte'), stat(count('strong'), 'en format fort', 'strong')];
    if (count('weak')) items.push(stat(count('weak'), 'à migrer', 'weak'));
    if (count('none')) items.push(stat(count('none'), 'en clair', 'none'));
    ui.summary.replaceChildren(...items);
  }

  function row(u: User): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.classList.toggle('selected', u.username === editing);
    tr.addEventListener('click', () => openEdit(u));

    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = u.username;

    const algo = document.createElement('td');
    algo.className = 'algo';
    algo.textContent = u.algorithmLabel;

    const strength = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${u.strength}`;
    pill.textContent = STRENGTH_LABEL[u.strength];
    strength.append(pill);

    const acts = document.createElement('td');
    acts.className = 'acts';
    acts.append(
      iconButton('edit', `Modifier ${u.username}`, (ev) => { ev.stopPropagation(); openEdit(u); }),
      iconButton('trash', `Supprimer ${u.username}`, (ev) => { ev.stopPropagation(); void removeUser(u.username); }, 'danger'),
    );

    tr.append(name, algo, strength, acts);
    return tr;
  }

  /** État du webhook de rechargement (masqué s'il n'est pas configuré). */
  function renderReload(reload: ReloadStatus | null): void {
    ui.reload.hidden = !reload || reload.state === 'idle';
    if (!reload) return;
    const pending = reload.state === 'pending' || reload.state === 'sending';
    ui.reload.className = `reload ${pending ? 'pending' : reload.state}`;
    ui.reload.textContent = pending
      ? 'rechargement en cours…'
      : reload.state === 'ok'
        ? `rechargement demandé ${reload.at ? timeAgo(reload.at) : ''}`
        : `échec du rechargement : ${reload.error ?? 'erreur inconnue'}`;
    ui.reload.title = reload.at ? `Dernier appel du webhook : ${new Date(reload.at).toLocaleString('fr')}` : '';
  }

  /** Après une modification, suit le webhook jusqu'à son résultat (regroupement + nouvelles tentatives). */
  let polling: ReturnType<typeof setTimeout> | undefined;
  function followReload(deadline = Date.now() + 60_000): void {
    clearTimeout(polling);
    const state = ctx.data().reload?.state;
    if (!state || state === 'idle' || state === 'ok' || state === 'failed' || Date.now() > deadline) return;
    polling = setTimeout(() => { void ctx.refresh().then(() => followReload(deadline)).catch(() => {}); }, 1500);
  }

  function render(): void {
    const { users, modifiedAt, reload } = ctx.data();
    ui.modified.textContent = modifiedAt ? `modifié ${timeAgo(modifiedAt)}` : 'pas encore créé';
    renderReload(reload);
    renderSummary(users);

    const q = ui.search.value.trim().toLowerCase();
    const shown = q ? users.filter((u) => u.username.toLowerCase().includes(q)) : users;
    ui.body.replaceChildren(...shown.map(row));
    ui.empty.hidden = shown.length > 0;
    ui.empty.textContent = users.length ? `Aucun identifiant ne contient « ${q} ».` : 'Le fichier ne contient encore aucun compte. Cliquez sur « Ajouter » pour créer le premier.';
  }

  /* ---------------------------------------------------------- panneau */

  function showError(msg: string, field?: HTMLInputElement): void {
    ui.error.textContent = msg;
    ui.error.hidden = !msg;
    for (const input of [ui.username, ui.password]) input.removeAttribute('aria-invalid');
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  function setPasswordVisible(show: boolean): void {
    ui.password.type = show ? 'text' : 'password';
    ui.toggle.setAttribute('aria-pressed', String(show));
    ui.toggle.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    ui.toggle.title = show ? 'Masquer' : 'Afficher';
  }

  function openDrawer(username: string | null): void {
    editing = username;
    ui.form.reset();
    showError('');
    setPasswordVisible(false);
    ui.algorithm.value = ctx.meta.defaultAlgorithm;
    syncHint();

    ui.username.value = username ?? '';
    ui.username.readOnly = username !== null;
    ui.drawerTitle.textContent = username ? `Modifier ${username}` : 'Ajouter un utilisateur';
    ui.submit.textContent = username ? 'Mettre à jour' : 'Ajouter';
    ui.remove.hidden = username === null;
    ui.drawer.hidden = false;
    (username ? ui.password : ui.username).focus();
    render();
  }

  const openEdit = (u: User) => openDrawer(u.username);

  function closeDrawer(): void {
    ui.drawer.hidden = true;
    editing = null;
    render();
  }

  function syncHint(): void {
    ui.hint.textContent = ctx.meta.algorithms.find((a) => a.id === ui.algorithm.value)?.hint ?? '';
  }

  function generatePassword(): void {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';
    const max = Math.floor(256 / alphabet.length) * alphabet.length; // rejet pour éviter le biais modulo
    let out = '';
    while (out.length < 20) {
      for (const b of crypto.getRandomValues(new Uint8Array(32))) {
        if (b < max && out.length < 20) out += alphabet.charAt(b % alphabet.length);
      }
    }
    ui.password.value = out;
    setPasswordVisible(true);
    ui.password.select();
    toast('Mot de passe généré : notez-le avant d’enregistrer');
  }

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    const username = ui.username.value.trim();
    const password = ui.password.value;
    const algorithm = ui.algorithm.value;

    if (!USERNAME_RE.test(username)) return showError("Identifiant invalide : utilisez uniquement A-Z, a-z, 0-9, « . », « _ » ou « - », sans « - » au début.", ui.username);
    if (!password) return showError('Saisissez un mot de passe ou générez-en un.', ui.password);
    if (algorithm.startsWith('bcrypt') && new TextEncoder().encode(password).length > 72) {
      return showError('Bcrypt ignore tout au-delà de 72 octets : raccourcissez le mot de passe ou choisissez SHA-512.', ui.password);
    }
    if (editing === null && ctx.data().users.some((u) => u.username === username)) {
      return showError(`« ${username} » existe déjà : sélectionnez-le dans la liste pour changer son mot de passe.`, ui.username);
    }
    showError('');

    ui.submit.disabled = true;
    try {
      const r = await call<{ created: boolean }>('/api/users', { method: 'POST', body: { username, password, algorithm } });
      closeDrawer();
      await ctx.refresh();
      followReload();
      toast(r.created ? `Compte ${username} ajouté` : `Mot de passe de ${username} mis à jour`);
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      ui.submit.disabled = false;
    }
  }

  async function removeUser(username: string): Promise<void> {
    const ok = await confirmAction('Supprimer le compte ?', `« ${username} » ne pourra plus se connecter à Mailpit ni aux services qui lisent ce fichier.`, 'Supprimer');
    if (!ok) return;
    try {
      await call(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      if (editing === username) closeDrawer();
      await ctx.refresh();
      followReload();
      toast(`Compte ${username} supprimé`);
    } catch (err) {
      toast(errorMessage(err), true);
    }
  }

  /* ---------------------------------------------------------- init */

  ui.filePath.textContent = ctx.meta.file;
  for (const a of ctx.meta.algorithms) ui.algorithm.append(new Option(a.label, a.id));

  ui.add.addEventListener('click', () => openDrawer(null));
  ui.drawerClose.addEventListener('click', closeDrawer);
  ui.cancel.addEventListener('click', closeDrawer);
  ui.remove.addEventListener('click', () => { if (editing) void removeUser(editing); });
  ui.search.addEventListener('input', render);
  // Une correction efface l'erreur affichée.
  for (const input of [ui.username, ui.password]) input.addEventListener('input', () => { if (!ui.error.hidden) showError(''); });
  ui.algorithm.addEventListener('change', syncHint);
  ui.toggle.addEventListener('click', () => setPasswordVisible(ui.password.type === 'password'));
  ui.generate.addEventListener('click', generatePassword);
  ui.form.addEventListener('submit', (ev) => void submit(ev));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ui.drawer.hidden && !document.querySelector('dialog[open]')) closeDrawer();
  });

  return { render, closeDrawer };
}
