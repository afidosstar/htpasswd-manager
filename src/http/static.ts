/**
 * Fichiers statiques de l'interface, chargés une fois en mémoire au démarrage.
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Après compilation : dist/http/static.js -> dist/public (HTML/CSS copiés, front compilé).
export const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface Asset {
  body: Buffer;
  type: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Tous les fichiers servables du répertoire, indexés par chemin HTTP (« /views/users.js »). */
export function loadAssets(dir: string = DEFAULT_PUBLIC_DIR): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const type = TYPES[path.extname(entry.name)];
    if (!entry.isFile() || !type) continue;
    const file = path.join(entry.parentPath, entry.name);
    assets.set('/' + path.relative(dir, file).split(path.sep).join('/'), { body: readFileSync(file), type });
  }
  return assets;
}
