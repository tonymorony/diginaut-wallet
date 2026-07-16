// Keystore crypto: password-encrypted mnemonic at rest, plus the keystore
// file export/import envelope (spec §4).
// Pure WebCrypto (works in browser and Node ≥20); IndexedDB persistence is a
// thin browser-only layer not covered here — the round-trip is driven in /verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptMnemonic, decryptMnemonic,
  encryptJson, encryptJsonWithKey, decryptJsonWithKey,
  buildKeystoreFile, parseKeystoreFile, decryptKeystoreFile, keystoreFileName,
} from '../public/keystore.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('encrypt → decrypt round-trips the mnemonic with the right password', async () => {
  const blob = await encryptMnemonic(MNEMONIC, 'correct horse battery staple');
  const back = await decryptMnemonic(blob, 'correct horse battery staple');
  assert.equal(back, MNEMONIC);
});

test('wrong password is rejected, not silently garbled', async () => {
  const blob = await encryptMnemonic(MNEMONIC, 'right password');
  await assert.rejects(() => decryptMnemonic(blob, 'wrong password'));
});

test('the stored blob is plain JSON and contains no plaintext or password', async () => {
  const blob = await encryptMnemonic(MNEMONIC, 'hunter2');
  const json = JSON.stringify(blob);
  assert.equal(typeof json, 'string');
  assert.ok(!json.includes('abandon'), 'mnemonic words must not appear in the blob');
  assert.ok(!json.includes('hunter2'), 'password must not appear in the blob');
  // decrypts after a JSON round-trip (what IndexedDB/structured clone implies)
  assert.equal(await decryptMnemonic(JSON.parse(json), 'hunter2'), MNEMONIC);
});

test('two encryptions of the same mnemonic differ (fresh salt + IV)', async () => {
  const a = await encryptMnemonic(MNEMONIC, 'pw');
  const b = await encryptMnemonic(MNEMONIC, 'pw');
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('encryptJsonWithKey echoes the record kdf it was given — never the current constant', async () => {
  const { blob, key } = await encryptJson({ hello: 1 }, 'pw');
  // a vault written before a future PBKDF2 iteration bump: the stored kdf
  // (salt AND iterations) is what the held key was derived with, and a
  // re-encryption that stamped the new constant instead would make every
  // later password unlock derive a different key — permanent lockout
  const olderKdf = { ...blob.kdf, iterations: 310_000 };
  const out = await encryptJsonWithKey({ hello: 2 }, key, olderKdf);
  assert.equal(out.kdf.iterations, 310_000);
  assert.equal(out.kdf.salt, blob.kdf.salt);
  assert.equal(out.kdf.name, blob.kdf.name);
  assert.deepEqual(await decryptJsonWithKey(out, key), { hello: 2 });
});

// ---- Keystore file envelope (spec §4) ----

test('keystore file: build → parse → decrypt round-trips the mnemonic', async () => {
  const env = await buildKeystoreFile({ name: 'Trading', network: 'testnet', mnemonic: MNEMONIC, password: 'hunter22' });
  assert.equal(env.format, 'diginaut-keystore');
  assert.equal(env.v, 1);
  assert.equal(env.name, 'Trading');
  assert.equal(env.network, 'testnet');
  assert.ok(!Number.isNaN(Date.parse(env.exportedAt)), 'exportedAt must be a parseable timestamp');
  // the file travels as JSON text — parse validates exactly what came off disk
  const parsed = parseKeystoreFile(JSON.stringify(env));
  assert.equal(await decryptKeystoreFile(parsed, 'hunter22'), MNEMONIC);
  await assert.rejects(() => decryptKeystoreFile(parsed, 'wrong password'));
});

test('keystore file: no plaintext in the envelope; salt + IV fresh per export', async () => {
  const a = await buildKeystoreFile({ name: 'W', network: null, mnemonic: MNEMONIC, password: 'pw' });
  const b = await buildKeystoreFile({ name: 'W', network: null, mnemonic: MNEMONIC, password: 'pw' });
  assert.ok(!JSON.stringify(a).includes('abandon'), 'mnemonic words must not appear in the file');
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.equal(a.network, null); // no chain known → null, per the format
});

test('parseKeystoreFile rejects wrong format/version/damage with clear errors', async () => {
  assert.throws(() => parseKeystoreFile('not json {'), /not valid JSON/);
  assert.throws(() => parseKeystoreFile('{"format":"other-wallet","v":1}'), /not a diginaut keystore/);
  const env = await buildKeystoreFile({ name: 'W', network: null, mnemonic: MNEMONIC, password: 'pw' });
  assert.throws(() => parseKeystoreFile(JSON.stringify({ ...env, v: 99 })), /version/);
  assert.throws(() => parseKeystoreFile(JSON.stringify({ ...env, cipher: {} })), /damaged/);
});

test('keystore filename follows diginaut-<name-slug>-<yyyymmdd>.keystore.json', () => {
  const when = new Date('2026-07-15T12:00:00Z');
  assert.equal(keystoreFileName('My Trading Wallet #2!', when), 'diginaut-my-trading-wallet-2-20260715.keystore.json');
  assert.equal(keystoreFileName('™©', when), 'diginaut-wallet-20260715.keystore.json'); // nothing sluggable → generic
});
