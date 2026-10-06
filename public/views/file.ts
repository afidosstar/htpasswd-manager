/**
 * Vue « Fichier brut » : contenu exact du fichier, copie et téléchargement.
 */
import { el } from '../lib.js';
import { toast } from '../ui.js';

export function createFileView(raw: () => string) {
  const view = el('file-view', HTMLDivElement);

  function render(): void {
    const lines = raw().split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length) {
      const p = document.createElement('span');
      p.className = 'placeholder';
      p.textContent = '# Fichier vide';
      view.replaceChildren(p);
      return;
    }
    view.replaceChildren(...lines.map((line) => {
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
      } else {
        ln.classList.add('c');
        ln.textContent = line || ' ';
      }
      return ln;
    }));
  }

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(raw());
      } else {
        // Repli pour HTTP non-localhost (Clipboard API indisponible hors contexte sécurisé).
        const ta = document.createElement('textarea');
        ta.value = raw();
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

  el('copy-btn', HTMLButtonElement).addEventListener('click', () => void copy());
  return { render };
}
