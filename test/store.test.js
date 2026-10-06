import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HtpasswdStore } from '../src/store.js';

test('upsert, remplacement, commentaires préservés, suppression', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-'));
  const file = path.join(dir, 'passwords');
  await writeFile(file, '# géré par htpasswd-manager\nalice:old\nbob:x\nalice:dup\n');
  const s = new HtpasswdStore(file, { mode: 0o640 });

  assert.deepEqual(await s.upsert('alice', 'new'), { created: false });
  assert.deepEqual(await s.upsert('carol', 'c'), { created: true });
  assert.equal(await readFile(file, 'utf8'), '# géré par htpasswd-manager\nalice:new\nbob:x\ncarol:c\n');
  assert.equal(await s.remove('bob'), true);
  assert.equal(await s.remove('bob'), false);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('écritures concurrentes sérialisées (aucune perte)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-'));
  const s = new HtpasswdStore(path.join(dir, 'p'));
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.upsert(`u${i}`, 'h')));
  assert.equal((await s.list()).users.length, 50);
});
