// Keystore crypto: password-encrypted mnemonic at rest.
// Pure WebCrypto (works in browser and Node ≥20); IndexedDB persistence is a
// thin browser-only layer not covered here — the round-trip is driven in /verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptMnemonic, decryptMnemonic } from '../public/keystore.js';

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
