const $ = (id) => document.getElementById(id);
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const WEAK = new Set(['plain', 'plain-prefixed', 'sha', 'des', 'md5']);

const state = { users: [], raw: '', algorithms: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'htpasswd-manager', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------ toast */
let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2600);
}

/* ------------------------------------------------------------ render */
function renderUsers() {
  const body = $('users-body');
  body.replaceChildren();
  for (const u of state.users) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'name';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = u.username;
    pick.title = 'Changer le mot de passe de cet utilisateur';
    pick.addEventListener('click', () => {
      $('username').value = u.username;
      syncSubmitLabel();
      $('password').focus();
    });
    name.append(pick);

    const algo = document.createElement('td');
    algo.className = 'algo' + (WEAK.has(u.algorithm) ? ' weak' : '');
    algo.textContent = u.algorithmLabel;

    const act = document.createElement('td');
    act.className = 'act';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-delete';
    del.textContent = 'Supprimer';
    del.setAttribute('aria-label', `Supprimer ${u.username}`);
    del.addEventListener('click', () => removeUser(u.username));
    act.append(del);

    tr.append(name, algo, act);
    body.append(tr);
  }
  const n = state.users.length;
  $('user-count').textContent = n ? `${n} au total` : '';
  $('users-empty').hidden = n > 0;
}

function renderFile(highlight) {
  const view = $('file-view');
  view.replaceChildren();
  const lines = state.raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) {
    const p = document.createElement('span');
    p.className = 'placeholder';
    p.textContent = '# Fichier vide';
    view.append(p);
    return;
  }
  let target;
  for (const line of lines) {
    const ln = document.createElement('span');
    ln.className = 'ln';
    const i = line.indexOf(':');
    if (i > 0 && !line.trimStart().startsWith('#')) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = line.slice(0, i);
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ':';
      ln.append(u, sep, document.createTextNode(line.slice(i + 1)));
      if (line.slice(0, i) === highlight) target = ln;
    } else {
      ln.classList.add('c');
      ln.textContent = line || ' ';
    }
    view.append(ln);
  }
  if (target) {
    target.classList.add('flash');
    target.scrollIntoView({ block: 'nearest' });
    setTimeout(() => target.classList.remove('flash'), 60);
  }
}

function syncSubmitLabel() {
  const exists = state.users.some((u) => u.username === $('username').value.trim());
  $('submit-btn').textContent = exists ? 'Mettre à jour le mot de passe' : "Ajouter l'utilisateur";
  $('form-title').textContent = exists ? 'Mettre à jour un utilisateur' : 'Ajouter un utilisateur';
}

function syncAlgorithmHint() {
  const a = state.algorithms.find((x) => x.id === $('algorithm').value);
  $('algorithm-hint').textContent = a ? a.hint : '';
}

/* ------------------------------------------------------------ actions */
async function refresh(highlight) {
  const data = await api('/api/users');
  state.users = data.users;
  state.raw = data.raw;
  renderUsers();
  renderFile(highlight);
  syncSubmitLabel();
}

function showFormError(msg, field) {
  const e = $('form-error');
  e.textContent = msg || '';
  e.hidden = !msg;
  for (const id of ['username', 'password']) $(id).removeAttribute('aria-invalid');
  if (field) { $(field).setAttribute('aria-invalid', 'true'); $(field).focus(); }
}

async function submit(ev) {
  ev.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  const algorithm = $('algorithm').value;

  if (!USERNAME_RE.test(username)) return showFormError("Identifiant invalide : utilisez uniquement A-Z, a-z, 0-9, « . », « _ » ou « - », sans « - » au début.", 'username');
  if (!password) return showFormError('Saisissez un mot de passe ou générez-en un.', 'password');
  if (algorithm.startsWith('bcrypt') && new TextEncoder().encode(password).length > 72) {
    return showFormError('Bcrypt ignore tout au-delà de 72 octets : raccourcissez le mot de passe ou choisissez SHA-512.', 'password');
  }
  showFormError('');

  const btn = $('submit-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, algorithm }) });
    $('password').value = '';
    await refresh(username);
    toast(r.created ? `Utilisateur ${username} ajouté` : `Mot de passe de ${username} mis à jour`);
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeUser(username) {
  if (!confirm(`Supprimer l'utilisateur « ${username} » ? Il ne pourra plus se connecter.`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await refresh();
    toast(`Utilisateur ${username} supprimé`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function copyRaw() {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(state.raw);
    } else {
      // Repli pour HTTP non-localhost (Clipboard API indisponible hors contexte sécurisé).
      const ta = document.createElement('textarea');
      ta.value = state.raw;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error();
    }
    toast('Contenu copié dans le presse-papiers');
  } catch {
    toast('Copie impossible : sélectionnez le texte manuellement.', true);
  }
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';
  const max = Math.floor(256 / alphabet.length) * alphabet.length; // rejet pour éviter le biais modulo
  let out = '';
  while (out.length < 20) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < max && out.length < 20) out += alphabet[b % alphabet.length];
    }
  }
  const pw = $('password');
  pw.value = out;
  pw.type = 'text';
  $('toggle-password').textContent = 'Masquer';
  $('toggle-password').setAttribute('aria-pressed', 'true');
  pw.select();
  toast('Mot de passe généré : notez-le avant d\u2019enregistrer');
}

function togglePassword() {
  const pw = $('password');
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('toggle-password').textContent = show ? 'Masquer' : 'Afficher';
  $('toggle-password').setAttribute('aria-pressed', String(show));
}

/* ------------------------------------------------------------ init */
async function init() {
  const meta = await api('/api/meta');
  state.algorithms = meta.algorithms;
  $('file-path').textContent = meta.file;

  const auth = $('auth-state');
  auth.hidden = false;
  auth.textContent = meta.authEnabled ? 'Accès protégé par mot de passe' : 'Accès libre : définissez ADMIN_USER et ADMIN_PASSWORD';
  auth.classList.toggle('open', !meta.authEnabled);

  const sel = $('algorithm');
  for (const a of meta.algorithms) sel.append(new Option(a.label, a.id, a.id === meta.defaultAlgorithm, a.id === meta.defaultAlgorithm));
  syncAlgorithmHint();

  $('user-form').addEventListener('submit', submit);
  $('username').addEventListener('input', syncSubmitLabel);
  sel.addEventListener('change', syncAlgorithmHint);
  $('copy-btn').addEventListener('click', copyRaw);
  $('generate-password').addEventListener('click', generatePassword);
  $('toggle-password').addEventListener('click', togglePassword);

  await refresh();
}

init().catch((err) => toast(`Chargement impossible : ${err.message}`, true));
