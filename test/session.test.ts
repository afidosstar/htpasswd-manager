import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/auth/session.ts';

test('création, lecture, destruction', () => {
  const s = new SessionStore();
  const t = s.create('admin');
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.get(t), 'admin');
  assert.equal(s.get('inconnu'), null);
  assert.equal(s.get(null), null);
  assert.equal(s.destroy(t), true);
  assert.equal(s.get(t), null);
});

test('expiration par inactivité et durée maximale', () => {
  let now = 0;
  const s = new SessionStore({ idleMs: 100, maxAgeMs: 250, now: () => now });
  const t = s.create('admin');
  now = 90; assert.equal(s.get(t), 'admin'); // prolonge
  now = 180; assert.equal(s.get(t), 'admin');
  now = 260; assert.equal(s.get(t), null); // durée maximale dépassée
  const u = s.create('admin');
  now = 400; assert.equal(s.get(u), null); // inactivité
});

test('nombre de sessions borné', () => {
  const s = new SessionStore({ maxSessions: 2 });
  const a = s.create('a');
  s.create('b');
  s.create('c');
  assert.equal(s.size, 2);
  assert.equal(s.get(a), null);
});
