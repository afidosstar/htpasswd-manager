import { ApiError, api, el, errorMessage } from './lib.js';

const form = el('login-form', HTMLFormElement);
const username = el('login-username', HTMLInputElement);
const password = el('login-password', HTMLInputElement);
const button = el('login-btn', HTMLButtonElement);
const error = el('login-error', HTMLParagraphElement);

function showError(msg: string): void {
  error.textContent = msg;
  error.hidden = !msg;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!username.value || !password.value) return showError('Saisissez votre identifiant et votre mot de passe.');
  showError('');

  button.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: { username: username.value, password: password.value } });
    location.replace('/');
  } catch (err) {
    password.value = '';
    password.focus();
    showError(err instanceof ApiError && err.status === 429 ? `${err.message} (verrouillage de 15 minutes)` : errorMessage(err));
  } finally {
    button.disabled = false;
  }
});
