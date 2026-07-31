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
  S2D_MESSAGE, S2D_VERSION, S2D_MESSAGE_MAIN, S2D_VERSION_MAIN,
  S2D_MESSAGE_TESTNET2, S2D_VERSION_TESTNET2, S2D_MESSAGE_MAIN2, S2D_VERSION_MAIN2,
  LEGACY_S2D_HOSTS, LEGACY_HOST_MOVED_TO, s2dForChain, s2dForVersion, s2dOriginHost,
  eip191Digest, canonicalizeEvmSignature, recoverEthAddress,
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

test('the frozen v2 mainnet message is byte-for-byte pinned (331 bytes, pinned SHA-256)', async () => {
  // Same treatment as v1, for the same reason: these bytes ARE the wallet. A
  // diff here re-derives every mainnet user's keys, so it must never be a
  // silent edit — this pin is the tripwire.
  const bytes = new TextEncoder().encode(S2D_MESSAGE_MAIN);
  assert.equal(S2D_VERSION_MAIN, 2);
  assert.equal(bytes.length, 331);
  assert.ok(S2D_MESSAGE_MAIN.startsWith('Diginaut sign-to-derive v2\nNetwork: DigiByte mainnet\n'));
  assert.ok(!S2D_MESSAGE_MAIN.endsWith('\n'), 'no trailing newline — it would change the bytes');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  assert.equal(digest, 'efd237737852aef965742854516e7f8af61c7cc26e8f6cc6dc7222972a335b40');
});

test('the frozen v3 testnet.diginaut.space message is pinned (333 bytes, pinned SHA-256)', async () => {
  // Minted by ADR 0006 for the domain move. The pin exists from the day the
  // bytes are written, not from the day someone derives against them: the
  // moment this ships, every diginaut.space wallet is a function of these
  // exact bytes and they can never be edited again.
  const bytes = new TextEncoder().encode(S2D_MESSAGE_TESTNET2);
  assert.equal(S2D_VERSION_TESTNET2, 3);
  assert.equal(bytes.length, 333);
  assert.ok(S2D_MESSAGE_TESTNET2.startsWith('Diginaut sign-to-derive v3\nNetwork: DigiByte testnet\n'));
  assert.ok(!S2D_MESSAGE_TESTNET2.endsWith('\n'), 'no trailing newline — it would change the bytes');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  assert.equal(digest, 'be8ffbacb1a05219a0d6bc83cbb77cbdb998212d1d6afd1c3bf37b2f90122a7e');
});

test('the frozen v4 diginaut.space mainnet message is pinned (317 bytes, pinned SHA-256)', async () => {
  const bytes = new TextEncoder().encode(S2D_MESSAGE_MAIN2);
  assert.equal(S2D_VERSION_MAIN2, 4);
  assert.equal(bytes.length, 317);
  assert.ok(S2D_MESSAGE_MAIN2.startsWith('Diginaut sign-to-derive v4\nNetwork: DigiByte mainnet\n'));
  assert.ok(!S2D_MESSAGE_MAIN2.endsWith('\n'), 'no trailing newline — it would change the bytes');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  assert.equal(digest, '51b9fe9bce073a9d2910292fcdb694bb46bd9684492f3dfc9d88fbb4768ced61');
});

test('all four frozen messages are pairwise distinct — four wallets, never a collision', () => {
  const all = [S2D_MESSAGE, S2D_MESSAGE_MAIN, S2D_MESSAGE_TESTNET2, S2D_MESSAGE_MAIN2];
  assert.equal(new Set(all).size, 4);
  assert.equal(new Set([S2D_VERSION, S2D_VERSION_MAIN, S2D_VERSION_TESTNET2, S2D_VERSION_MAIN2]).size, 4);
  // the two risk sentences are byte-identical across all four ON PURPOSE — a
  // reader who has seen one recognises the next, and nothing but the network
  // and origin lines is allowed to differ
  const RISK = 'This signature generates the private keys of your DigiByte wallet.\n'
    + 'Anyone who obtains this signature can steal your DigiByte funds.';
  for (const m of all) assert.ok(m.includes(RISK), 'the shared risk sentences must not drift');
});

test('the two networks derive from DIFFERENT bytes — no cross-network replay (ADR 0005)', () => {
  // The security property, asserted rather than assumed: a signature made on
  // one network cannot be replayed against the other's funds, because the
  // signer never saw those bytes.
  assert.notEqual(S2D_MESSAGE, S2D_MESSAGE_MAIN);
  assert.ok(S2D_MESSAGE.includes('DigiByte testnet') && !S2D_MESSAGE.includes('mainnet'));
  assert.ok(S2D_MESSAGE_MAIN.includes('DigiByte mainnet') && !S2D_MESSAGE_MAIN.includes('testnet'));
  // each message points at its OWN origin, including the refuse-elsewhere line
  assert.ok(S2D_MESSAGE.includes('Only sign this message on https://dgb.ludere.space.'));
  assert.ok(S2D_MESSAGE_MAIN.includes('Only sign this message on https://diginaut.ludere.space.'));
});

test('the era-2 messages are network-disjoint too — the ADR 0005 property survives the move', () => {
  assert.notEqual(S2D_MESSAGE_TESTNET2, S2D_MESSAGE_MAIN2);
  assert.ok(S2D_MESSAGE_TESTNET2.includes('DigiByte testnet') && !S2D_MESSAGE_TESTNET2.includes('mainnet'));
  assert.ok(S2D_MESSAGE_MAIN2.includes('DigiByte mainnet') && !S2D_MESSAGE_MAIN2.includes('testnet'));
  // each message points at its OWN origin, including the refuse-elsewhere line
  assert.ok(S2D_MESSAGE_TESTNET2.includes('Only sign this message on https://testnet.diginaut.space.'));
  assert.ok(S2D_MESSAGE_MAIN2.includes('Only sign this message on https://diginaut.space.'));
  // and neither era's bytes mention the other era's domain at all
  for (const m of [S2D_MESSAGE, S2D_MESSAGE_MAIN]) assert.ok(!m.includes('diginaut.space'));
  for (const m of [S2D_MESSAGE_TESTNET2, S2D_MESSAGE_MAIN2]) assert.ok(!m.includes('ludere.space'));
});

test('s2dForChain picks the era by SERVING HOSTNAME, network within it (ADR 0006)', () => {
  // The legacy allow-list is permanent: these two hosts hold every wallet ever
  // derived from the v1/v2 bytes, and removing one would silently start
  // deriving DIFFERENT wallets at an address that still serves the old vaults.
  assert.deepEqual([...LEGACY_S2D_HOSTS].sort(), ['dgb.ludere.space', 'diginaut.ludere.space']);
  for (const host of LEGACY_S2D_HOSTS) {
    for (const c of ['main', 'mainnet']) {
      assert.equal(s2dForChain(c, host).message, S2D_MESSAGE_MAIN, `${host}/${c} -> v2`);
      assert.equal(s2dForChain(c, host).version, 2);
    }
    for (const c of ['test', 'testnet', 'regtest', null, undefined, '', 'MAIN', 'bogus']) {
      assert.equal(s2dForChain(c, host).message, S2D_MESSAGE, `${host}/${c} -> v1`);
      assert.equal(s2dForChain(c, host).version, 1);
    }
  }
  // Everything else is the CURRENT era — the new domains, a dev localhost, a
  // self-host, and the no-`location` case (this test process). The unknown
  // hostname must land here, not on v1: a self-host falling to v1 would ask for
  // a signature under an origin line naming a site it is not.
  for (const host of ['diginaut.space', 'testnet.diginaut.space', 'localhost', '127.0.0.1',
    'wallet.example.org', undefined, null, '']) {
    for (const c of ['main', 'mainnet']) {
      assert.equal(s2dForChain(c, host).message, S2D_MESSAGE_MAIN2, `${host}/${c} -> v4`);
      assert.equal(s2dForChain(c, host).version, 4);
    }
    // allow-list, never deny-list: an unrecognised chain falls to the TESTNET
    // message of the SELECTED era, which cannot touch mainnet funds
    for (const c of ['test', 'testnet', 'regtest', null, undefined, '', 'MAIN', 'bogus']) {
      assert.equal(s2dForChain(c, host).message, S2D_MESSAGE_TESTNET2, `${host}/${c} -> v3`);
      assert.equal(s2dForChain(c, host).version, 3);
    }
  }
  // no `location` in node: the default argument must resolve, not throw
  assert.equal(s2dForChain('main').message, S2D_MESSAGE_MAIN2);
  assert.equal(s2dForChain('test').message, S2D_MESSAGE_TESTNET2);
});

test('s2dForVersion resolves every minted version, and only by the stored number', () => {
  // re-derive picks by the version stored on the source record, never by the
  // chain or the origin — the bytes that made a wallet are the bytes that
  // reproduce it
  assert.deepEqual(s2dForVersion(1), { version: 1, message: S2D_MESSAGE });
  assert.deepEqual(s2dForVersion(2), { version: 2, message: S2D_MESSAGE_MAIN });
  assert.deepEqual(s2dForVersion(3), { version: 3, message: S2D_MESSAGE_TESTNET2 });
  assert.deepEqual(s2dForVersion(4), { version: 4, message: S2D_MESSAGE_MAIN2 });
  assert.equal(s2dForVersion('4').message, S2D_MESSAGE_MAIN2, 'a stringy record number still resolves');
  assert.equal(s2dForVersion(undefined).message, S2D_MESSAGE, 'legacy record with no msgVersion is v1');
  assert.equal(s2dForVersion(99).message, S2D_MESSAGE, 'an unknown version is v1, never a throw');
});

test('every legacy host has a move target and every move target has a legacy host', () => {
  // One list, two consumers: s2dForChain reads LEGACY_S2D_HOSTS for the era,
  // app.js reads LEGACY_HOST_MOVED_TO for the "we've moved" notice. A host added
  // to one and not the other keeps its old bytes but silently loses its notice
  // (or points somewhere with no vault), so the key sets are pinned both ways.
  assert.deepEqual([...LEGACY_HOST_MOVED_TO.keys()].sort(), [...LEGACY_S2D_HOSTS].sort());
  // and the destinations are the era-2 origins themselves, not a third copy
  assert.equal(LEGACY_HOST_MOVED_TO.get('dgb.ludere.space'), 'https://testnet.diginaut.space');
  assert.equal(LEGACY_HOST_MOVED_TO.get('diginaut.ludere.space'), 'https://diginaut.space');
  // and the pairing is per NETWORK: whichever era-1 message pins this host, the
  // target is the era-2 message of the SAME network — never the other one's.
  const SAME_NETWORK = [[S2D_MESSAGE, S2D_MESSAGE_TESTNET2], [S2D_MESSAGE_MAIN, S2D_MESSAGE_MAIN2]];
  for (const [host, target] of LEGACY_HOST_MOVED_TO) {
    const pair = SAME_NETWORK.find(([era1]) => s2dOriginHost(era1) === host);
    assert.ok(pair, `${host} must be the origin a v1/v2 message pins`);
    assert.equal(target, `https://${s2dOriginHost(pair[1])}`, `${host} moves to its own network's home`);
    assert.ok(!target.includes(host), `${host} must not point at itself`);
  }
});

test('s2dOriginHost reads the host OUT of the frozen bytes (ceremony checkbox)', () => {
  // The checkbox sentence is rendered from this, so a message and the host
  // beside it can never disagree — which is exactly what shipped on mainnet
  // ("only dgb.ludere.space may ever ask", over the v2 message).
  assert.equal(s2dOriginHost(S2D_MESSAGE), 'dgb.ludere.space');
  assert.equal(s2dOriginHost(S2D_MESSAGE_MAIN), 'diginaut.ludere.space');
  assert.equal(s2dOriginHost(S2D_MESSAGE_TESTNET2), 'testnet.diginaut.space');
  assert.equal(s2dOriginHost(S2D_MESSAGE_MAIN2), 'diginaut.space');
  // every host it returns is the one the refuse-elsewhere line names
  for (const m of [S2D_MESSAGE, S2D_MESSAGE_MAIN, S2D_MESSAGE_TESTNET2, S2D_MESSAGE_MAIN2]) {
    assert.ok(m.includes(`Only sign this message on https://${s2dOriginHost(m)}.`));
  }
  assert.throws(() => s2dOriginHost('no origin line here'), /Origin line/);
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

test('findSource prefers the exact fingerprint when one account backs several wallets', async () => {
  const storage = memStorage();
  const v = createVaultManager(storage);
  await v.createVault(PW, { name: 'First', mnemonic: M1, source: SRC });
  const first = v.meta().wallets[0].id;
  // the sanctioned save-drifted-signature-as-NEW path: same (kind, address), new fp
  const drifted = { ...SRC, fp: 'deadbeef' };
  const { id: second } = await v.addWallet({ name: 'Second', mnemonic: M2, source: drifted });
  assert.equal(v.findSource('evm', ADDR, 'deadbeef').id, second, 'exact fp wins');
  assert.equal(v.findSource('evm', ADDR, SRC.fp).id, first, 'the original still resolves by its fp');
  assert.equal(v.findSource('evm', ADDR, '00000000'), null, 'fp given but absent → null, no fallback');
  assert.ok(v.findSource('evm', ADDR), 'no fp → any-match still answers the routing question');
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
