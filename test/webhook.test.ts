// Tests du webhook de rechargement contre un vrai serveur HTTP local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReloadWebhook, type WebhookConfig } from '../src/reload/webhook.ts';

interface Hit { method: string; headers: http.IncomingHttpHeaders; body: string }

/** Serveur qui répond avec les codes donnés, dans l'ordre (le dernier se répète). */
async function receiver(codes: number[]) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method ?? '', headers: req.headers, body });
      res.statusCode = codes[Math.min(hits.length - 1, codes.length - 1)] ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { hits, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const config = (url: string, extra: Partial<WebhookConfig> = {}): WebhookConfig => ({
  url, method: 'POST', headers: {}, body: null, delayMs: 50, timeoutMs: 1000, retryDelaysMs: [20, 20], ...extra,
});

async function until(check: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('regroupe les modifications rapprochées en un seul appel, avec en-têtes et corps JSON', async () => {
  const r = await receiver([200]);
  const ok: number[] = [];
  const hook = new ReloadWebhook(config(r.url, { headers: { 'x-api-key': 'secret' } }), '/data/passwords', { onSuccess: (s) => ok.push(s) });
  hook.schedule(); hook.schedule(); hook.schedule();
  assert.equal(hook.status.state, 'pending');
  await until(() => ok.length === 1);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]?.method, 'POST');
  assert.equal(r.hits[0]?.headers['x-api-key'], 'secret');
  assert.deepEqual(Object.keys(JSON.parse(r.hits[0]?.body ?? '{}')), ['event', 'file', 'ts']);
  assert.equal(hook.status.state, 'ok');
  await hook.close(); await r.close();
});

test('réessaie après un échec puis réussit', async () => {
  const r = await receiver([503, 200]);
  const ok: Array<[number, number]> = [];
  const hook = new ReloadWebhook(config(r.url), '/f', { onSuccess: (s, n) => ok.push([s, n]) });
  hook.schedule();
  await until(() => ok.length === 1);
  assert.deepEqual(ok[0], [200, 2]);
  await hook.close(); await r.close();
});

test('abandonne après les tentatives et signale l\'erreur', async () => {
  const r = await receiver([500]);
  const failed: Array<[string, number]> = [];
  const hook = new ReloadWebhook(config(r.url), '/f', { onFailure: (e, n) => failed.push([e, n]) });
  hook.schedule();
  await until(() => failed.length === 1);
  assert.deepEqual(failed[0], ['HTTP 500', 3]);
  assert.equal(hook.status.state, 'failed');
  assert.equal(hook.status.error, 'HTTP 500');
  await hook.close(); await r.close();
});

test('serveur injoignable : cause réseau lisible', async () => {
  const r = await receiver([200]);
  await r.close();
  const failed: string[] = [];
  const hook = new ReloadWebhook(config(r.url, { retryDelaysMs: [] }), '/f', { onFailure: (e) => failed.push(e) });
  hook.schedule();
  await until(() => failed.length === 1);
  assert.match(failed[0] ?? '', /ECONNREFUSED/);
  await hook.close();
});

test('une modification pendant l\'envoi déclenche un nouvel appel ensuite', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++;
    req.resume();
    if (calls === 1) await gate;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const ok: number[] = [];
  const hook = new ReloadWebhook(config(url), '/f', { onSuccess: (s) => ok.push(s) });
  hook.schedule();
  await until(() => calls === 1);
  hook.schedule();
  release();
  await until(() => ok.length === 2);
  assert.equal(calls, 2);
  await hook.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
