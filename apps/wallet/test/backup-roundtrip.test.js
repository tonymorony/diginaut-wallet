// M2: the encrypted backup file must actually restore the wallet it came from.
// The pieces had coverage — keystore.test.js builds/parses/decrypts an envelope,
// vault.test.js exercises the vault — but nothing proved the LIFECYCLE a user
// bets funds on: create → export → the browser profile dies → import → the same
// addresses. This drives the real switcher path (buildKeystoreFile → JSON text →
// parseKeystoreFile → decryptKeystoreFile → vault) over real WebCrypto and real
// digidollar-js derivation, so "same wallet" here means the same keys, not the
// same metadata. Storage is the injected in-memory stand-in (vault.js §Storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultManager } from '../public/vault.js';
import { buildKeystoreFile, parseKeystoreFile, decryptKeystoreFile, VaultConflictError } from '../public/keystore.js';
import { mnemonicToSeed, deriveTaprootAddress, validateMnemonic, HD_NETWORKS } from 'digidollar-js';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'; // BIP39 vector #2
const PW = 'correct horse battery staple';
const NET = 'testnet';

// Same in-memory CAS stand-in as vault.test.js, deliberately duplicated: a
// shared helper under test/ would itself be run as a test file by `node --test`.
function memStorage() {
  const db = new Map();
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  return {
    db,
    async loadKeystoreAny() {
      return { vault: clone(db.get('vault')), primary: clone(db.get('primary')) };
    },
    async saveVaultRecord(record, baseRev) {
      const cur = db.get('vault');
      if ((cur?.rev ?? 0) !== baseRev) throw new VaultConflictError();
      const next = { ...clone(record), id: 'vault', rev: baseRev + 1 };
      db.set('vault', next);
      return clone(next);
    },
    async deleteVaultRecord(baseRev) {
      const cur = db.get('vault');
      if ((cur?.rev ?? 0) !== baseRev) throw new VaultConflictError();
      db.delete('vault');
    },
    async deleteKeystore() {
      db.delete('primary');
    },
  };
}

// What app.js actually shows: openWallet() seeds once from the mnemonic, then
// renderAddress()/receiveAddressAt() derive per index on the node's network.
// Public artifacts only — privKeyHex must never land in an assertion diff.
function addressesAt(mnemonic, index) {
  const { path, address, p2wpkhAddress } = deriveTaprootAddress(
    mnemonicToSeed(mnemonic), { ...HD_NETWORKS[NET], index },
  );
  return { path, address, p2wpkhAddress };
}

async function rejection(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected the decryption to reject');
}

// One vault, one export, one password for the whole file. PBKDF2 at 600k is
// intentionally ~0.5 s a run; rebuilding this per test buys no coverage. Only
// the round-trip test below touches `store`/`vault` — the failure tests read
// the envelope, which nothing mutates.
const store = memStorage();
const vault = createVaultManager(store);
const walletId = await vault.createVault(PW, { name: 'Trading', mnemonic: MNEMONIC });
// The switcher export verbatim (app.js: requireReauth → buildKeystoreFile →
// downloadKeystoreFile), down to the JSON text the Blob carries to disk.
const envelope = await buildKeystoreFile({
  name: vault.meta().wallets[0].name,
  network: NET,
  mnemonic: vault.getMnemonic(walletId),
  password: PW,
});
const fileText = JSON.stringify(envelope, null, 2);

test('create → export → wipe the profile → import restores the same keys', async () => {
  // Index 3, not just 0: a restore that only reproduced the first key would
  // still lose every address the receive chain has already handed out.
  const before = [0, 3].map((i) => addressesAt(MNEMONIC, i));
  assert.ok(before[0].address.startsWith(`${HD_NETWORKS[NET].hrp}1p`), 'index 0 must be a testnet taproot address');
  assert.notEqual(before[0].address, before[1].address); // the comparison below must not be vacuous

  // The file is about to be the only copy — it had better carry no plaintext.
  assert.ok(!fileText.includes('legal'), 'no mnemonic word may appear in the exported file');
  assert.ok(!fileText.includes(PW), 'the password may not appear in the exported file');

  // The browser profile dies: cleared IndexedDB, new machine, reinstalled OS.
  store.db.clear();
  const fresh = createVaultManager(store);
  assert.equal(await fresh.load(), 'none');

  // The import path: file text → parse → the FILE's password → validate → vault.
  const parsed = parseKeystoreFile(fileText);
  assert.equal(parsed.name, 'Trading');
  assert.equal(parsed.network, NET);
  const mnemonic = await decryptKeystoreFile(parsed, PW);
  assert.ok(validateMnemonic(mnemonic), 'the decrypted text must be a valid BIP39 phrase');

  // createWalletEntry's no-vault branch (app.js): with the profile wiped there
  // is no session key to ride, so the import re-creates the vault. An import
  // proves the password, not the words — the wallet stays backedUp:false and
  // keeps nagging for the seed quiz.
  const restoredId = await fresh.createVault(PW, { name: parsed.name, mnemonic, backedUp: false });
  assert.equal(fresh.status, 'unlocked');
  assert.equal(fresh.meta().wallets[0].backedUp, false);

  const after = [0, 3].map((i) => addressesAt(fresh.getMnemonic(restoredId), i));
  assert.deepEqual(after, before);
});

test('a wrong password and a tampered ciphertext fail identically — no decryption oracle', async () => {
  const parsed = parseKeystoreFile(fileText);
  const wrong = await rejection(() => decryptKeystoreFile(parsed, `${PW}!`));
  assert.equal(wrong.name, 'OperationError'); // app.js maps exactly this to "wrong password for this file"

  // Flip a byte INSIDE the ciphertext body rather than the trailing GCM tag:
  // what must be caught is an edit to the encrypted seed, not merely a mangled
  // tag. AES-GCM authenticates both, and a file that decrypted to a *different*
  // seed would silently hand the user a wallet that is not theirs.
  const bytes = Uint8Array.from(atob(envelope.cipher.data), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  const tampered = parseKeystoreFile(JSON.stringify({
    ...envelope,
    cipher: { ...envelope.cipher, data: btoa(String.fromCharCode(...bytes)) },
  }));
  // parseKeystoreFile still accepts it — the rejection has to come from GCM
  // authentication, not from a structural check that happened to fire first.
  const err = await rejection(() => decryptKeystoreFile(tampered, PW));
  assert.equal(err.name, 'OperationError');
  // Indistinguishable from the wrong-password failure: no oracle that tells an
  // attacker holding the file whether a guessed password was the right one.
  assert.equal(err.message, wrong.message);
});
