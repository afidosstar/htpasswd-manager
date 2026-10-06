// Vecteurs de référence générés avec `openssl passwd` (OpenSSL 3.0) et la spécification de Drepper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { md5crypt, shacrypt, sha1Apache, ssha, hashPassword, detectAlgorithm, ALGORITHMS } from '../src/hash.js';

test('MD5-crypt $1$', () => {
  assert.equal(md5crypt('Hello world!', '$1$', 'saltsalt'), '$1$saltsalt$le8lFSqqnPaRFOlmAZpvH1');
});

test('APR1 $apr1$ (ASCII et UTF-8)', () => {
  assert.equal(md5crypt('Hello world!', '$apr1$', 'abcd1234'), '$apr1$abcd1234$OfvxZwcFIAqTvPP0G69mR1');
  assert.equal(md5crypt('pâssw0rd:€', '$apr1$', 'xxxxxxxx'), '$apr1$xxxxxxxx$lX3tbcPWaZau6PS1iqlgO1');
});

test('SHA-256 crypt $5$', () => {
  assert.equal(shacrypt('Hello world!', 'sha256', { salt: 'saltstring' }), '$5$saltstring$5B8vYYiY.CVt1RlTTf8KbXBH3hsxY/GNooZaBBGWEc5');
  assert.equal(shacrypt('Hello world!', 'sha256', { salt: 'saltstringsaltst', rounds: 10000 }),
    '$5$rounds=10000$saltstringsaltst$3xv.VbSHBb41AL9AvLeujZkZRBAwqFMz2.opqey6IcA');
});

test('SHA-512 crypt $6$', () => {
  assert.equal(shacrypt('Hello world!', 'sha512', { salt: 'saltstring' }),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
});

test('{SHA}', () => {
  assert.equal(sha1Apache('password'), '{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=');
});

test('{SSHA} = base64(sha1(pw + sel) + sel)', () => {
  const salt = Buffer.from('0123abcd', 'hex');
  const decoded = Buffer.from(ssha('secret', salt).slice(6), 'base64');
  assert.deepEqual(decoded.subarray(20), salt);
  assert.deepEqual(decoded.subarray(0, 20), createHash('sha1').update('secret').update(salt).digest());
});

test('Bcrypt $2y$ / $2a$ vérifiables', async () => {
  for (const id of ['bcrypt-2y', 'bcrypt-2a']) {
    const h = await hashPassword('s3cret', id, { bcryptCost: 4 });
    assert.match(h, id === 'bcrypt-2y' ? /^\$2y\$04\$/ : /^\$2a\$04\$/);
    assert.ok(bcrypt.compareSync('s3cret', h.replace(/^\$2y\$/, '$2b$')));
  }
});

test('Chaque algorithme est détecté sur sa propre sortie', async () => {
  for (const id of Object.keys(ALGORITHMS)) {
    const h = await hashPassword('Pa55word', id, { bcryptCost: 4 });
    assert.equal(detectAlgorithm(h).id, id, `${id} -> ${h}`);
  }
});

test('Sels aléatoires : deux hachages successifs diffèrent', async () => {
  for (const id of ['bcrypt-2y', 'sha512', 'sha256', 'apr1', 'md5', 'ssha']) {
    assert.notEqual(await hashPassword('x', id, { bcryptCost: 4 }), await hashPassword('x', id, { bcryptCost: 4 }));
  }
});
