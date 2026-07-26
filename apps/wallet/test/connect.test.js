// Sign-to-derive (#130): pinned protocol vectors + refusal gates + vault
// source records. The pins are CONSENSUS-GRADE (sign-to-derive.md §10): a
// diff in this file means every derived wallet changes for every user — treat
// any red here as an incident, never re-pin to make it green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import {
  S2D_MESSAGE, S2D_VERSION, eip191Digest, canonicalizeEvmSignature, recoverEthAddress,
  verifySolanaSignature, entropyFromSignature, mnemonicFromEntropy, fingerprintOfEntropy,
  shortAddress,
} from '../public/connect.js';
import { createVaultManager } from '../public/vault.js';
import { VaultConflictError } from '../public/keystore.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Fixed test key (32 × 0x07) — the same key the CDP driver's fake wallet uses.
const PRIV = new Uint8Array(32).fill(7);
const ADDR = '0x' + hex(keccak_256(secp256k1.getPublicKey(PRIV, false).subarray(1)).subarray(12));
const signFrozenMessage = () => {
  const rec = secp256k1.sign(eip191Digest(), PRIV, { format: 'recovered', prehash: false });
  return '0x' + hex(rec.subarray(1)) + (27 + rec[0]).toString(16); // wallet form: r‖s‖v
};

test('the frozen v1 message is byte-for-byte the audited one (321 bytes, pinned SHA-256)', async () => {
  const bytes = new TextEncoder().encode(S2D_MESSAGE);
  assert.equal(S2D_VERSION, 1);
  assert.equal(bytes.length, 321);
  assert.ok(S2D_MESSAGE.startsWith('Diginaut sign-to-derive v1\nNetwork: DigiByte testnet\n'));
  assert.ok(!S2D_MESSAGE.endsWith('\n'), 'no trailing newline — it would change the bytes');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  assert.equal(digest, '2666c5f978b46e18c683a5dd6480b596d9266c545cdb73acad12d97b1f42a029');
});

test('pinned pipeline vector: fixed key → fixed signature → fixed mnemonic + fingerprint', async () => {
  const sigHex = signFrozenMessage();
  // RFC 6979 makes the signature itself a constant for this key + message
  assert.equal(sigHex,
    '0x3d6f999dd005ee9ee1cd426fec0bdc1bff0d8b8833a00112de2fabe42537dfdf'
    + '4e6e5a55c56205c0bdedd0ca61847aa71f4695888a554ca5c588b2b48fba27291c');
  const { rs, recid } = canonicalizeEvmSignature(sigHex);
  assert.equal(recoverEthAddress(rs, recid), ADDR);
  const entropy = await entropyFromSignature(rs);
  assert.equal(mnemonicFromEntropy(entropy),
    'creek federal coyote illegal monitor detect silent tag model civil wash cart '
    + 'replace crucial index virus bronze leaf prize disorder very forget net endless');
  assert.equal(await fingerprintOfEntropy(entropy), 'ed5b2a2e');
});

test('re-encodings collapse to one seed: high-s flips back, casing and 0x are presentation', async () => {
  const sigHex = signFrozenMessage();
  const base = canonicalizeEvmSignature(sigHex);
  const N = secp256k1.Point.Fn.ORDER;
  const s = BigInt('0x' + hex(base.rs.subarray(32, 64)));
  const highS = (N - s).toString(16).padStart(64, '0');
  const flippedV = (27 + (base.recid ^ 1)).toString(16);
  const highHex = '0x' + hex(base.rs.subarray(0, 32)) + highS + flippedV;
  const high = canonicalizeEvmSignature(highHex);
  assert.equal(hex(high.rs), hex(base.rs), 'high-s re-encoding canonicalizes to the same r‖s');
  assert.equal(high.recid, base.recid, 'the recovery bit flips back with s');
  const shouty = canonicalizeEvmSignature(sigHex.slice(2).toUpperCase());
  assert.equal(hex(shouty.rs), hex(base.rs), 'uppercase, no-0x input decodes identically');
});

test('structural refusals: wrong length, bad recid, out-of-range scalars, junk', () => {
  const sigHex = signFrozenMessage();
  assert.throws(() => canonicalizeEvmSignature('0x1234'), /65 bytes/);
  assert.throws(() => canonicalizeEvmSignature('0x' + '00'.repeat(64)), /65 bytes/); // ERC-4337-ish blob
  assert.throws(() => canonicalizeEvmSignature(sigHex + '02'), /65 bytes/); // Loopring-style suffix
  assert.throws(() => canonicalizeEvmSignature(sigHex.slice(0, -2) + '05'), /recovery id/);
  assert.throws(() => canonicalizeEvmSignature('0x' + '00'.repeat(65)), /out of range|recovery id/);
  assert.throws(() => canonicalizeEvmSignature('0xzz' + sigHex.slice(4)), /hex/);
  // a different key's signature recovers to a DIFFERENT address (ecrecover gate)
  const other = secp256k1.sign(eip191Digest(), new Uint8Array(32).fill(9), { format: 'recovered', prehash: false });
  const otherHex = '0x' + hex(other.subarray(1)) + (27 + other[0]).toString(16);
  const { rs, recid } = canonicalizeEvmSignature(otherHex);
  assert.notEqual(recoverEthAddress(rs, recid), ADDR);
});

test('Phantom path: strict Ed25519 verify against the connected pubkey', () => {
  const sk = new Uint8Array(32).fill(9);
  const pub = base58.encode(ed25519.getPublicKey(sk));
  const msg = new TextEncoder().encode(S2D_MESSAGE);
  const sig = ed25519.sign(msg, sk);
  assert.equal(verifySolanaSignature(sig, pub), true);
  assert.equal(verifySolanaSignature(sig.subarray(0, 63), pub), false, 'wrong length');
  assert.equal(verifySolanaSignature(sig, base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(1)))), false, 'wrong key');
  assert.equal(verifySolanaSignature(sig, 'not-base58-0OIl'), false, 'garbage pubkey');
});

test('fingerprint is domain-tagged, 4 bytes, and not a prefix of the raw hash', async () => {
  const entropy = await entropyFromSignature(canonicalizeEvmSignature(signFrozenMessage()).rs);
  const fp = await fingerprintOfEntropy(entropy);
  assert.match(fp, /^[0-9a-f]{8}$/);
  const raw = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', entropy)).subarray(0, 4));
  assert.notEqual(fp, raw, 'the diginaut-s2d-fp: tag must separate the domains');
  assert.equal(shortAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), '0xd8da…6045');
});

// ---- vault source records (encrypted-side custody of the origin, #129) ----

function memStorage() {
  const db = new Map();
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  return {
    async loadKeystoreAny() { return { vault: clone(db.get('vault')), primary: clone(db.get('primary')) }; },
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
    async deleteKeystore() { db.delete('primary'); },
    raw: () => db.get('vault'),
  };
}
const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SRC = { kind: 'evm', rdns: 'io.metamask', brand: 'MetaMask', address: ADDR, msgVersion: 1, fp: 'ed5b2a2e' };
const PW = 'correct horse battery staple';

test('source rides encrypted: cleartext meta gets only derived:true, record round-trips', async () => {
  const storage = memStorage();
  const v = createVaultManager(storage);
  await v.createVault(PW, { name: 'Native', mnemonic: M1 });
  const { id } = await v.addWallet({ name: 'MetaMask wallet', mnemonic: M2, source: SRC });
  const row = v.meta().wallets.find((w) => w.id === id);
  assert.equal(row.derived, true);
  // the wallet NAME may echo the brand (it's user-visible and renamable); the
  // source linkage — account address, fingerprint, rdns — must stay encrypted
  const cleartext = JSON.stringify(storage.raw().meta);
  assert.ok(!cleartext.includes(ADDR) && !cleartext.includes('io.metamask') && !cleartext.includes('ed5b2a2e'),
    'source linkage must never appear in the cleartext meta (#129)');
  assert.deepEqual(v.getSource(id), SRC);
  assert.equal(v.getSource(v.meta().wallets[0].id), null, 'native wallets have no source');
  assert.deepEqual(v.findSource('evm', ADDR.toUpperCase()), { id, source: SRC }); // case-insensitive
  assert.equal(v.findSource('sol', ADDR), null, 'kind is part of the identity');
  // removal prunes the source record along with the mnemonic
  await v.removeWallet(id);
  assert.equal(v.findSource('evm', ADDR), null);
});

test('a source survives a lock/unlock cycle and unrelated writes', async () => {
  const storage = memStorage();
  const v = createVaultManager(storage);
  await v.createVault(PW, { name: 'MetaMask wallet', mnemonic: M2, source: SRC });
  const id = v.meta().wallets[0].id;
  await v.addWallet({ name: 'Native', mnemonic: M1 }); // an unrelated write must not drop sources
  await v.renameWallet(id, 'Renamed');
  v.lock();
  assert.throws(() => v.getSource(id), /locked/);
  await v.unlock(PW);
  assert.deepEqual(v.getSource(id), SRC);
});
