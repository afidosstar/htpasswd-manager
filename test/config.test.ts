import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, loadEnvFile } from '../src/config.ts';

test('.env chargé sans écraser l\'environnement réel', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-env-'));
  await writeFile(path.join(dir, '.env'), '# commentaire\nADMIN_USER=admin\nADMIN_PASSWORD="phrase avec espaces"\nPORT=9000\n');
  const env: Record<string, string | undefined> = { PORT: '7000' };
  assert.equal(loadEnvFile(env, dir)?.file, path.join(dir, '.env'));
  assert.equal(env.ADMIN_USER, 'admin');
  assert.equal(env.ADMIN_PASSWORD, 'phrase avec espaces');
  assert.equal(env.PORT, '7000');
  assert.equal(loadConfig(env).port, 7000);
});

test('.env lisible par d\'autres utilisateurs signalé', async () => {
  const { chmod } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-env-'));
  const file = path.join(dir, '.env');
  await writeFile(file, 'X=1\n');
  await chmod(file, 0o644);
  assert.equal(loadEnvFile({}, dir)?.exposed, true);
  await chmod(file, 0o600);
  assert.equal(loadEnvFile({}, dir)?.exposed, false);
});

test('sans .env : rien n\'est chargé ; ENV_FILE absent : erreur', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-env-'));
  assert.equal(loadEnvFile({}, dir), null);
  assert.throws(() => loadEnvFile({ ENV_FILE: 'absent.env' }, dir), ConfigError);
});

test('configuration incohérente refusée', () => {
  assert.throws(() => loadConfig({ ADMIN_USER: 'a' }), /ensemble/);
  assert.throws(() => loadConfig({ DEFAULT_ALGORITHM: 'rot13' }), ConfigError);
  assert.throws(() => loadConfig({ COOKIE_SECURE: 'oui' }), ConfigError);
  assert.throws(() => loadConfig({ FILE_MODE: 'abc' }), /FILE_MODE invalide/);
  assert.throws(() => loadConfig({ FILE_MODE: '0666' }), /modifiable par tous/);
  assert.equal(loadConfig({ FILE_MODE: '0644' }).fileMode, 0o644);
});

test('webhook de rechargement : désactivé par défaut, configuration validée', () => {
  assert.equal(loadConfig({}).reloadWebhook, null);
  const hook = loadConfig({
    RELOAD_WEBHOOK_URL: 'https://dokploy.example.fr/api/application.reload',
    RELOAD_WEBHOOK_HEADERS: 'x-api-key: abc; X-Trace: 1',
    RELOAD_WEBHOOK_BODY: '{"applicationId":"42"}',
  }).reloadWebhook;
  assert.equal(hook?.method, 'POST');
  assert.deepEqual(hook?.headers, { 'x-api-key': 'abc', 'x-trace': '1' });
  assert.equal(hook?.body, '{"applicationId":"42"}');
  assert.throws(() => loadConfig({ RELOAD_WEBHOOK_URL: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => loadConfig({ RELOAD_WEBHOOK_URL: 'https://x', RELOAD_WEBHOOK_METHOD: 'DELETE' }), /METHOD/);
  assert.throws(() => loadConfig({ RELOAD_WEBHOOK_URL: 'https://x', RELOAD_WEBHOOK_HEADERS: 'sans-deux-points' }), /HEADERS/);
});
