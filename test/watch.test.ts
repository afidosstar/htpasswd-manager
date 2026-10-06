// Tests de bin/htpasswd-watch (exécuté avec sh, comme dans un conteneur consommateur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const WATCH = path.resolve('bin/htpasswd-watch');

// Faux service : note chaque démarrage et chaque SIGHUP reçu.
const SERVICE = 'echo start >> "$LOG"; trap \'echo hup >> "$LOG"\' HUP; trap \'exit 0\' TERM; while :; do sleep 0.05; done';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'htp-watch-'));
  const file = path.join(dir, 'passwords');
  const log = path.join(dir, 'log');
  await writeFile(file, 'alice:x\n');
  await writeFile(log, '');
  return { dir, file, log };
}

/** Remplacement atomique, comme htpasswd-manager. */
async function replace(file: string, content: string) {
  await writeFile(`${file}.tmp`, content);
  await rename(`${file}.tmp`, file);
}

async function until(check: () => Promise<boolean>, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await sleep(50);
  }
}

const lines = async (log: string) => (await readFile(log, 'utf8')).split('\n').filter(Boolean);

function run(args: string[], log: string): ChildProcess {
  return spawn('sh', [WATCH, ...args, '--', 'sh', '-c', SERVICE], { env: { ...process.env, LOG: log }, stdio: 'ignore' });
}

const exited = (p: ChildProcess) => new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code)));

test('relance le service quand le fichier change', async () => {
  const { file, log } = await setup();
  const p = run(['-f', file, '-i', '0.1'], log);
  try {
    await until(async () => (await lines(log)).length === 1);
    await replace(file, 'alice:x\nbob:y\n');
    await until(async () => (await lines(log)).join() === 'start,start');
  } finally {
    p.kill('SIGTERM');
  }
  assert.equal(await exited(p), 0);
});

test('envoie un signal au lieu de relancer (--signal HUP)', async () => {
  const { file, log } = await setup();
  const p = run(['-f', file, '-i', '0.1', '-s', 'HUP'], log);
  try {
    await until(async () => (await lines(log)).length === 1);
    await replace(file, 'bob:y\n');
    await until(async () => (await lines(log)).join() === 'start,hup');
  } finally {
    p.kill('SIGTERM');
  }
  await exited(p);
});

test("propage l'arrêt du service et refuse une utilisation incorrecte", async () => {
  const { file } = await setup();
  const p = spawn('sh', [WATCH, '-f', file, '-i', '0.1', '--', 'sh', '-c', 'exit 3'], { stdio: 'ignore' });
  assert.equal(await exited(p), 3);

  for (const args of [['--', 'true'], ['-f', file], ['-f', file, '-s', 'NOPE', '--', 'true']]) {
    const bad = spawn('sh', [WATCH, ...args], { stdio: 'ignore' });
    assert.equal(await exited(bad), 2, args.join(' '));
  }
});
