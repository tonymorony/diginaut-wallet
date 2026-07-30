// Lock & Earn protocol templates (src/bond.js): the bond leaf and its taproot
// output, the operator's floor-share arithmetic and chunk planning, the five
// transaction shapes, and the received-bytes verifier with its mutation battery.
//
// Independence rules followed here:
//   - the bond leaf/output-key constants are the ones
//     prototypes/lock-earn/logic.js produces for the same inputs;
//   - the two pinned sighash digests are recomputed by a BIP-341 message
//     constructor written IN THIS FILE from the specification, and the
//     implementation is checked against it before the digest is pinned
//     (test/fixtures/bip341-wallet-vectors.json is what pins the constructor);
//   - the mutation battery re-serializes with a parser/serializer written here,
//     so a doctored transaction is doctored independently of src/txbuild.js.
// Pinned digests are consensus-grade: a red pin is an incident to investigate,
// never a constant to update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bondLeafHex, bondOutputKey, computeFloorShares, planDistributionChunks,
  ddTokenOutputKey, xOnlyPubKey, MIN_DD_OUTPUT_CENTS,
} from 'digidollar-js';

const h2b = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const b2h = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sum = (values) => values.reduce((s, v) => s + v, 0n);
const byKey = (a, b) => (a.outputKeyHex < b.outputKeyHex ? -1 : 1);

// Fixed synthetic keys (the connect.test.js convention) and heights.
export const STAKER_PRIV = '07'.repeat(32);
export const EPHEMERAL_PRIV = '09'.repeat(32);
const STAKER_KEY = xOnlyPubKey(STAKER_PRIV);
const UNLOCK_HEIGHT = 1_060; // prototype genesis 1000 + one 60-block epoch

// ---- the bond leaf and its taproot output (prototype cross-pin) ----

const BOND_LEAF_HEX = `022404b17520${STAKER_KEY}ac`;
const BOND_OUTPUT_KEY = '4fe4fca393537226aabf51567393637a1b060f91c3d3e7c65b71ee89c7668ba5';

test('the bond leaf is <height> CLTV DROP <staker key> CHECKSIG, 39 bytes', () => {
  assert.equal(STAKER_KEY, '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f');
  const leaf = bondLeafHex({ stakerKeyHex: STAKER_KEY, unlockHeight: UNLOCK_HEIGHT });
  assert.equal(leaf, BOND_LEAF_HEX);
  assert.equal(leaf.length / 2, 39);
  // 1060 = 0x0424 → CScriptNum 24 04, pushed with its length byte.
  assert.equal(leaf.slice(0, 6), '022404');
  assert.equal(leaf.slice(6, 10), 'b175');  // OP_CHECKLOCKTIMEVERIFY OP_DROP
  assert.equal(leaf.slice(10, 12), '20');   // push32
  assert.equal(leaf.slice(-2), 'ac');       // OP_CHECKSIG
});

test('the bond output key is the single leaf under the NUMS internal key', () => {
  assert.equal(bondOutputKey({ stakerKeyHex: STAKER_KEY, unlockHeight: UNLOCK_HEIGHT }), BOND_OUTPUT_KEY);
  // Different height, different bond — the height lives only in the leaf.
  assert.notEqual(bondOutputKey({ stakerKeyHex: STAKER_KEY, unlockHeight: UNLOCK_HEIGHT + 1 }), BOND_OUTPUT_KEY);
});

test('the bond leaf rejects a key that is not 32-byte hex', () => {
  assert.throws(() => bondLeafHex({ stakerKeyHex: 'aabb', unlockHeight: UNLOCK_HEIGHT }), /32-byte hex/);
  assert.throws(() => bondLeafHex({ stakerKeyHex: STAKER_KEY, unlockHeight: 0 }), /unlock height/);
});

// ---- computeFloorShares ----
// The prototype's validated carry model, generalized: pro-rata over a pool the
// caller supplies. Carol's case is the one the prototype demonstrates — a stake
// too small to clear the $1 minimum output, so the share becomes a promise
// instead of an output, and pays in a later epoch once it clears.

const key = (label) => ddTokenOutputKey(xOnlyPubKey(label.repeat(32)));
const ALICE = key('a1');
const BOB = key('b2');
const CAROL = key('c3');
const STAKES = [
  { outputKeyHex: ALICE, cents: 25_000n },
  { outputKeyHex: BOB, cents: 190_000n },
  { outputKeyHex: CAROL, cents: 4_000n },
];
const TOTAL_STAKE = 219_000n;
const POOL_AT_150_BPS = (TOTAL_STAKE * 150n) / 10_000n; // 3285c — the escrowed floor

test('a sub-$1 share pays nothing and rolls forward whole (the prototype Carol case)', () => {
  const epoch1 = computeFloorShares({ stakes: STAKES, poolCents: POOL_AT_150_BPS });
  assert.equal(POOL_AT_150_BPS, 3_285n);
  // Carol's floor share is 4000c · 1.5% = 60c — under the $1 minimum DD output
  // (consensus validation.cpp:1756-1758), so no output can exist for it at all.
  assert.deepEqual(epoch1.carryOutCents, { [CAROL]: 60n });
  const paid = Object.fromEntries(epoch1.payouts.map((p) => [p.outputKeyHex, p.cents]));
  assert.deepEqual(paid, { [ALICE]: 375n, [BOB]: 2_850n }); // 1.5% of each stake
  assert.equal(CAROL in paid, false);

  // Epoch 2: a bigger pool puts her floor share at 69c, and 69 + 60 clears $1.
  const epoch2 = computeFloorShares({
    stakes: STAKES,
    poolCents: 3_800n,
    carryInCents: epoch1.carryOutCents,
  });
  const carol = epoch2.payouts.find((p) => p.outputKeyHex === CAROL);
  assert.equal(carol.cents, 129n);
  assert.deepEqual(epoch2.carryOutCents, {});
});

test('payouts come back sorted by output key, whatever order the stakes arrive in', () => {
  const shuffled = [STAKES[2], STAKES[0], STAKES[1]];
  const a = computeFloorShares({ stakes: STAKES, poolCents: 50_000n });
  const b = computeFloorShares({ stakes: shuffled, poolCents: 50_000n });
  assert.deepEqual(a, b);
  const keys = a.payouts.map((p) => p.outputKeyHex);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(keys.length, 3);
});

test('every cent of the pool and of the carry-in is accounted for', () => {
  // Σ payouts + Σ carry-out + the un-allocatable flooring remainder must equal
  // pool + Σ carry-in exactly. Nothing may quietly disappear from a ledger the
  // operator is funding out of revenue.
  const cases = [
    { stakes: STAKES, poolCents: 3_285n, carryInCents: {} },
    { stakes: STAKES, poolCents: 3_800n, carryInCents: { [CAROL]: 60n } },
    { stakes: STAKES, poolCents: 7n, carryInCents: {} },              // everything carries
    { stakes: STAKES, poolCents: 100_003n, carryInCents: { [ALICE]: 5n } },
    { stakes: [{ outputKeyHex: ALICE, cents: 1n }, { outputKeyHex: BOB, cents: 2n }], poolCents: 1_000n, carryInCents: {} },
  ];
  for (const c of cases) {
    const r = computeFloorShares(c);
    const paid = r.payouts.reduce((s, p) => s + p.cents, 0n);
    const carried = Object.values(r.carryOutCents).reduce((s, v) => s + v, 0n);
    const carriedIn = Object.values(c.carryInCents).reduce((s, v) => s + v, 0n);
    assert.equal(paid + carried + r.remainderCents, c.poolCents + carriedIn, JSON.stringify(c.poolCents.toString()));
    assert.ok(r.remainderCents >= 0n && r.remainderCents < BigInt(c.stakes.length), 'remainder is sub-cent dust');
    for (const p of r.payouts) assert.ok(p.cents >= MIN_DD_OUTPUT_CENTS);
    for (const v of Object.values(r.carryOutCents)) assert.ok(v > 0n, 'zero carry entries are dropped');
  }
});

test('carry belonging to someone who did not stake this epoch is not confiscated', () => {
  const absent = key('dd');
  const r = computeFloorShares({ stakes: STAKES, poolCents: 3_285n, carryInCents: { [absent]: 42n } });
  assert.equal(r.carryOutCents[absent], 42n);
});

test('a repeated output key is refused — it is the carry ledger identity', () => {
  assert.throws(
    () => computeFloorShares({ stakes: [...STAKES, { outputKeyHex: ALICE, cents: 1n }], poolCents: 100n }),
    /unique/,
  );
  assert.throws(() => computeFloorShares({ stakes: [], poolCents: 100n }), /at least one stake/);
  assert.throws(() => computeFloorShares({ stakes: STAKES, poolCents: -1n }), /pool/);
});

// ---- planDistributionChunks ----

test('chunks are bounded by the 8-payout product cap', () => {
  const payouts = Array.from({ length: 19 }, (_, i) => ({ outputKeyHex: key((i + 1).toString(16).padStart(2, '0')), cents: 100n + BigInt(i) }))
    .sort(byKey); // planning consumes the canonical ordering, it does not impose it
  const chunks = planDistributionChunks({ payouts });
  assert.deepEqual(chunks.map((c) => c.payouts.length), [8, 8, 3]);
  assert.equal(chunks.reduce((s, c) => s + c.payouts.length, 0), 19);
  for (const c of chunks) {
    assert.equal(c.sumCents, c.payouts.reduce((s, p) => s + p.cents, 0n));
    assert.ok(c.envelopeHex.length / 2 <= 83);
    assert.ok(c.envelopeHex.startsWith('6a02444401' + '02')); // OP_RETURN "DD" <type 2>
  }
  // Every payout survives, in order.
  assert.deepEqual(chunks.flatMap((c) => c.payouts), payouts);
});

test('the 8-payout cap is what binds: no legal envelope can reach 83 bytes', async () => {
  // Both bounds are real, but they no longer BOTH bind at the planner. With the
  // $100,000 per-output maximum enforced (validation.cpp:1761) the largest
  // legal amount is 0x989680, whose top byte has the high bit set — so
  // CScriptNum sign-pads it to 4 bytes, 5 with its length byte. The fattest
  // legal 8-payout envelope is therefore 6 + 8·5 = 46 bytes, comfortably under
  // the 83-byte relay cap (policy.h:74). The byte cap survives in the planner and
  // in the verifier as defence in depth: it bounds the ENCODED envelope, which
  // is the actual relay constraint, rather than trusting that arithmetic.
  const { MAX_DD_OUTPUT_CENTS, buildTransferMetadata } = await import('digidollar-js');
  const payouts = Array.from({ length: 8 }, (_, i) => ({ outputKeyHex: key((i + 1).toString(16).padStart(2, '0')), cents: MAX_DD_OUTPUT_CENTS - BigInt(i) }))
    .sort(byKey);
  const chunks = planDistributionChunks({ payouts });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].envelopeHex.length / 2, 46);
  assert.equal(buildTransferMetadata({ amountsCents: payouts.map((p) => p.cents) }).length / 2, 46);
  // An amount past the maximum is refused before the envelope is ever measured.
  assert.throws(() => planDistributionChunks({
    payouts: [{ outputKeyHex: ALICE, cents: MAX_DD_OUTPUT_CENTS + 1n }],
  }), /\$100,000\.00/);
  // The 83-byte bound itself still has teeth on RECEIVED bytes — see the
  // '84-byte envelope' entry in the mutation battery.
});

test('planning refuses an empty payout list and sub-$1 payouts', () => {
  assert.throws(() => planDistributionChunks({ payouts: [] }), /at least one payout/);
  assert.throws(
    () => planDistributionChunks({ payouts: [{ outputKeyHex: ALICE, cents: 99n }] }),
    /\$1\.00/,
  );
});

// ---- a BIP-341 sighash message constructor, written here from the spec ----
// The library's own taprootSighash is checked against the upstream DigiByte
// Core vectors in txbuild.test.js; this constructor is checked against the
// library. Two independent expressions of the same specification agreeing on a
// digest is what makes the pinned constants below worth pinning.

const { taggedHash } = schnorr.utils;
const cat = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
};
const u32le = (n) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u64le = (v) => {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const compact = (n) => (n < 0xfd ? Uint8Array.from([n]) : Uint8Array.from([0xfd, n & 0xff, n >>> 8]));
const scriptField = (hex) => cat(compact(hex.length / 2), h2b(hex));
const outpoint = (i) => cat(h2b(i.txidHex).reverse(), u32le(i.vout));

/**
 * BIP-341 "Common signature message" + the tapscript extension, transcribed
 * from the BIP: epoch 0x00 ‖ hash_type ‖ nVersion ‖ nLockTime ‖ [four input
 * digests unless ANYONECANPAY] ‖ sha_outputs ‖ spend_type ‖ [this input's
 * outpoint/amount/scriptPubKey/nSequence if ANYONECANPAY, else input_index] ‖
 * [tapleaf_hash ‖ key_version ‖ codesep_pos].
 */
function bip341Sighash({ hashType, version, locktime, inputs, outputs, inputIndex, leafHashHex }) {
  const acp = (hashType & 0x80) !== 0;
  const self = inputs[inputIndex];
  const parts = [Uint8Array.from([hashType]), u32le(version), u32le(locktime)];
  if (!acp) {
    parts.push(
      sha256(cat(...inputs.map(outpoint))),
      sha256(cat(...inputs.map((i) => u64le(i.valueSats)))),
      sha256(cat(...inputs.map((i) => scriptField(i.scriptPubKeyHex)))),
      sha256(cat(...inputs.map((i) => u32le(i.sequence)))),
    );
  }
  parts.push(sha256(cat(...outputs.map((o) => cat(u64le(o.valueSats), scriptField(o.scriptHex))))));
  parts.push(Uint8Array.from([leafHashHex ? 0x02 : 0x00])); // spend_type = ext_flag·2 + annex
  parts.push(acp
    ? cat(outpoint(self), u64le(self.valueSats), scriptField(self.scriptPubKeyHex), u32le(self.sequence))
    : u32le(inputIndex));
  if (leafHashHex) parts.push(h2b(leafHashHex), Uint8Array.from([0x00]), u32le(0xffffffff));
  return b2h(taggedHash('TapSighash', cat(Uint8Array.from([0x00]), ...parts)));
}

// ---- the five transaction shapes ----

const FEE_PRIV = '0f'.repeat(32);
const FEE_KEY = xOnlyPubKey(FEE_PRIV);
const FEE_SATS = 12_000_000n;
const FEE_UTXO = { txidHex: 'b2'.repeat(32), vout: 1, valueSats: 100_000_000n };
const BOND_CENTS = 2_500n;
const TRANSFER_VERSION = 0x02000770; // buildDDVersion('transfer')

test('the lock is an ordinary transfer paying the bond output key, plus its record', async () => {
  const { buildSignedBondLockTx, parseTx } = await import('digidollar-js');
  const { hex, bond, ddChangeCents, dgbChangeSats } = buildSignedBondLockTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 10_000n },
    feeUtxo: FEE_UTXO,
    privKeyHex: STAKER_PRIV,
    cents: BOND_CENTS,
    unlockHeight: UNLOCK_HEIGHT,
    stakerKeyHex: STAKER_KEY,
    feeSats: FEE_SATS,
  });
  assert.deepEqual(bond, {
    stakerKeyHex: STAKER_KEY,
    unlockHeight: UNLOCK_HEIGHT,
    cents: BOND_CENTS,
    leafHex: BOND_LEAF_HEX,
    outputKeyHex: BOND_OUTPUT_KEY,
  });
  assert.equal(ddChangeCents, 7_500n);
  assert.equal(dgbChangeSats, 88_000_000n);
  const tx = parseTx(hex);
  assert.equal(tx.version, TRANSFER_VERSION);
  assert.equal(tx.locktime, 0);
  assert.equal(tx.outputs[0].scriptHex, `5120${BOND_OUTPUT_KEY}`);
  assert.equal(tx.outputs[0].valueSats, 0n);
  // The bond record is the whole recovery story: unlockHeight lives only in the
  // unrevealed leaf, so a seed alone cannot rediscover this output.
  assert.equal(bondOutputKey(bond), tx.outputs[0].scriptHex.slice(4));
});

// The unlock's fixed shape, pinned below. Everything the digest depends on is
// stated here rather than left to a builder default.
const BOND_UTXO = { txidHex: 'a1'.repeat(32), vout: 0 };
const BOND_RECORD = {
  stakerKeyHex: STAKER_KEY,
  unlockHeight: UNLOCK_HEIGHT,
  cents: BOND_CENTS,
  leafHex: BOND_LEAF_HEX,
  outputKeyHex: BOND_OUTPUT_KEY,
};
const DGB_CHANGE_SCRIPT = `0014${'cd'.repeat(20)}`;

// CONSENSUS-GRADE PIN — the script-path (tapscript) sighash of the bond-unlock
// transaction below, SIGHASH_DEFAULT with the tapleaf extension. A red pin here
// is an incident to investigate, never a constant to update.
const BOND_UNLOCK_SIGHASH = '76e4f26c1584d0302d030d58bd8112693c71a32c748414960192ea34c798dafb';

test('the unlock spends the bond leaf, pinned digest and all', async () => {
  const { buildSignedBondUnlockTx, parseTx, bondControlBlockHex } = await import('digidollar-js');
  const { hex, ddChangeCents, dgbChangeSats } = buildSignedBondUnlockTx({
    bondUtxo: { ...BOND_UTXO, bond: BOND_RECORD },
    feeUtxo: FEE_UTXO,
    stakerPrivKeyHex: STAKER_PRIV,
    feePrivKeyHex: FEE_PRIV,
    feeSats: FEE_SATS,
    dgbChangeScriptHex: DGB_CHANGE_SCRIPT,
  });
  assert.equal(ddChangeCents, 0n); // the whole bond comes back by default
  assert.equal(dgbChangeSats, 88_000_000n);

  const tx = parseTx(hex);
  assert.equal(tx.version, TRANSFER_VERSION);
  assert.equal(tx.locktime, UNLOCK_HEIGHT, 'nLockTime is the CLTV height');
  assert.equal(tx.inputs[0].sequence, 0xfffffffe, 'CLTV needs a non-final input');
  assert.equal(tx.inputs[1].sequence, 0xffffffff);
  // Witness: [64-byte signature, the revealed leaf, the 33-byte control block].
  assert.equal(tx.witnesses[0].length, 3);
  assert.equal(tx.witnesses[0][0].length / 2, 64);
  assert.equal(tx.witnesses[0][1], BOND_LEAF_HEX);
  assert.equal(tx.witnesses[0][2], bondControlBlockHex(BOND_RECORD));
  assert.equal(tx.witnesses[0][2].length / 2, 33);
  assert.equal(tx.witnesses[1].length, 1);
  // The staker gets the DigiDollar back on their own key-path output.
  assert.equal(tx.outputs[0].scriptHex, `5120${ddTokenOutputKey(STAKER_KEY)}`);

  const inputs = [
    { ...BOND_UTXO, valueSats: 0n, scriptPubKeyHex: `5120${BOND_OUTPUT_KEY}`, sequence: 0xfffffffe },
    { ...FEE_UTXO, scriptPubKeyHex: `5120${ddTokenOutputKey(FEE_KEY)}`, sequence: 0xffffffff },
  ];
  const digest = bip341Sighash({
    hashType: 0x00, version: tx.version, locktime: tx.locktime,
    inputs, outputs: tx.outputs, inputIndex: 0,
    leafHashHex: b2h(sha256Tagged('TapLeaf', BOND_LEAF_HEX)),
  });
  assert.equal(digest, BOND_UNLOCK_SIGHASH);
  // The leaf's CHECKSIG verifies the RAW staker key — a tapscript CHECKSIG
  // never applies the taproot tweak. Signing the tweaked key here would produce
  // a transaction the network rejects.
  assert.ok(schnorr.verify(h2b(tx.witnesses[0][0]), h2b(digest), h2b(STAKER_KEY)));
  assert.equal(schnorr.verify(h2b(tx.witnesses[0][0]), h2b(digest), h2b(ddTokenOutputKey(STAKER_KEY))), false);
  // …while the fee input is an ordinary key-path spend of the TWEAKED key.
  const feeDigest = bip341Sighash({
    hashType: 0x00, version: tx.version, locktime: tx.locktime,
    inputs, outputs: tx.outputs, inputIndex: 1,
  });
  assert.ok(schnorr.verify(h2b(tx.witnesses[1][0]), h2b(feeDigest), h2b(ddTokenOutputKey(FEE_KEY))));
});

/** BIP-341 tapleaf hash of a 0xc0 leaf, from its hex — spelled out here. */
function sha256Tagged(tag, scriptHex) {
  const script = h2b(scriptHex);
  return taggedHash(tag, cat(Uint8Array.from([0xc0, script.length]), script));
}

test('the unlock refuses a private key that is not the bond leaf key', async () => {
  const { buildSignedBondUnlockTx } = await import('digidollar-js');
  assert.throws(() => buildSignedBondUnlockTx({
    bondUtxo: { ...BOND_UTXO, bond: BOND_RECORD },
    feeUtxo: FEE_UTXO,
    stakerPrivKeyHex: FEE_PRIV, // not the key in the leaf
    feePrivKeyHex: FEE_PRIV,
  }), /staker key/);
});

// ---- escrow split + distribution ----

const CHUNK = planDistributionChunks({
  payouts: computeFloorShares({ stakes: STAKES, poolCents: POOL_AT_150_BPS }).payouts,
})[0];
const ESCROW_UTXO = { txidHex: 'e5'.repeat(32), vout: 2, cents: CHUNK.sumCents };
const EPHEMERAL_KEY = xOnlyPubKey(EPHEMERAL_PRIV);

// CONSENSUS-GRADE PIN — the key-path SIGHASH_ALL|ANYONECANPAY digest of the
// distribution transaction below. Same rule: a red pin is an incident.
const DISTRIBUTION_SIGHASH = '4e917f40af2a0ee0568288edb5794b64c04adafed9942e0f766a6e174b792c78';

test('the escrow split pays one ephemeral-key output per chunk', async () => {
  const { buildSignedEscrowSplitTx, parseTx } = await import('digidollar-js');
  const chunks = planDistributionChunks({
    payouts: Array.from({ length: 11 }, (_, i) => ({ outputKeyHex: key((i + 1).toString(16).padStart(2, '0')), cents: 100n + BigInt(i) })).sort(byKey),
  });
  assert.equal(chunks.length, 2);
  const { hex, escrows } = buildSignedEscrowSplitTx({
    ddUtxos: [{ txidHex: 'aa'.repeat(32), vout: 0, ddCents: 500_000n }],
    feeUtxo: FEE_UTXO,
    operatorPrivKeyHex: '0e'.repeat(32),
    ephemeralKeyHex: EPHEMERAL_KEY,
    chunks,
    feeSats: FEE_SATS,
  });
  assert.deepEqual(escrows, chunks.map((c, i) => ({ vout: i, cents: c.sumCents })));
  const tx = parseTx(hex);
  // One escrow output per chunk, all to the same ephemeral key, then DD change.
  for (const [i, c] of chunks.entries()) {
    assert.equal(tx.outputs[i].scriptHex, `5120${ddTokenOutputKey(EPHEMERAL_KEY)}`);
    assert.ok(c.sumCents > 0n);
  }
  assert.equal(sum(escrows.map((e) => e.cents)), sum(chunks.map((c) => c.sumCents)));
});

test('the escrow split refuses more chunks than one transfer can carry', async () => {
  const { buildSignedEscrowSplitTx } = await import('digidollar-js');
  const chunks = Array.from({ length: 9 }, (_, i) => ({ payouts: [], sumCents: 100n + BigInt(i), envelopeHex: '' }));
  assert.throws(() => buildSignedEscrowSplitTx({
    ddUtxos: [{ txidHex: 'aa'.repeat(32), vout: 0, ddCents: 500_000n }],
    feeUtxo: FEE_UTXO,
    operatorPrivKeyHex: '0e'.repeat(32),
    ephemeralKeyHex: EPHEMERAL_KEY,
    chunks,
  }), /8 chunks/);
});

test('the distribution is one ACP input, payouts and envelope — nothing else', async () => {
  const { buildSignedDistributionTx, parseTx } = await import('digidollar-js');
  const { hex, chunkRecord } = buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO,
    ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK,
    lockTimeHeight: UNLOCK_HEIGHT,
  });
  assert.deepEqual(chunkRecord, {
    v: 1,
    txHex: hex,
    escrow: { txidHex: ESCROW_UTXO.txidHex, vout: ESCROW_UTXO.vout, cents: ESCROW_UTXO.cents },
    payouts: CHUNK.payouts,
    lockTimeHeight: UNLOCK_HEIGHT,
  });

  const tx = parseTx(hex);
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.inputs[0].sequence, 0xfffffffe);
  assert.equal(tx.locktime, UNLOCK_HEIGHT);
  assert.equal(tx.outputs.length, CHUNK.payouts.length + 1); // payouts + envelope
  assert.equal(tx.outputs.every((o) => o.valueSats === 0n), true, 'no valued output at all');
  assert.equal(tx.outputs.at(-1).scriptHex, CHUNK.envelopeHex);

  // 65 bytes: 64-byte Schnorr signature ‖ the hash-type byte. Its presence is
  // what makes the signature survive a stranger appending a fee input.
  const sig = tx.witnesses[0][0];
  assert.equal(sig.length / 2, 65);
  assert.equal(sig.slice(-2), '81', 'trailing SIGHASH_ALL|ANYONECANPAY byte');

  const digest = bip341Sighash({
    hashType: 0x81, version: tx.version, locktime: tx.locktime,
    inputs: [{
      txidHex: ESCROW_UTXO.txidHex, vout: ESCROW_UTXO.vout, valueSats: 0n,
      scriptPubKeyHex: `5120${ddTokenOutputKey(EPHEMERAL_KEY)}`, sequence: 0xfffffffe,
    }],
    outputs: tx.outputs, inputIndex: 0,
  });
  assert.equal(digest, DISTRIBUTION_SIGHASH);
  assert.ok(schnorr.verify(h2b(sig.slice(0, -2)), h2b(digest), h2b(ddTokenOutputKey(EPHEMERAL_KEY))));
});

test('the distribution refuses an escrow that does not equal the payout sum', async () => {
  const { buildSignedDistributionTx } = await import('digidollar-js');
  for (const cents of [CHUNK.sumCents - 1n, CHUNK.sumCents + 1n]) {
    assert.throws(() => buildSignedDistributionTx({
      escrowUtxo: { ...ESCROW_UTXO, cents },
      ephemeralPrivKeyHex: EPHEMERAL_PRIV,
      chunk: CHUNK,
      lockTimeHeight: UNLOCK_HEIGHT,
    }), /exactly/);
  }
});

// ---- fee attachment ----

test('any staker can append a fee input without disturbing the escrow signature', async () => {
  const { buildSignedDistributionTx, attachDistributionFee, parseTx } = await import('digidollar-js');
  const { chunkRecord } = buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO,
    ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK,
    lockTimeHeight: UNLOCK_HEIGHT,
  });
  const before = parseTx(chunkRecord.txHex);
  const { hex } = attachDistributionFee({
    chunkRecord,
    escrowKeyHex: EPHEMERAL_KEY,
    lockTimeHeight: UNLOCK_HEIGHT,
    feeUtxo: { txidHex: 'f1'.repeat(32), vout: 0, valueSats: 15_000_000n },
    feePrivKeyHex: FEE_PRIV,
  });
  const after = parseTx(hex);
  assert.equal(after.inputs.length, 2);
  assert.equal(after.inputs[1].sequence, 0xfffffffe);
  assert.deepEqual(after.outputs, before.outputs, 'ALL|ACP pins the outputs: none may change');
  assert.deepEqual(after.witnesses[0], before.witnesses[0], 'the escrow signature is untouched');
  assert.equal(after.witnesses[1][0].length / 2, 64, 'the fee input signs SIGHASH_DEFAULT');

  // The attached coin is spent IN FULL: with the output set pinned there is no
  // room for a change output, so the whole coin becomes fee.
  assert.equal(sum(after.outputs.map((o) => o.valueSats)), 0n);

  const feeDigest = bip341Sighash({
    hashType: 0x00, version: after.version, locktime: after.locktime,
    inputs: [
      { txidHex: ESCROW_UTXO.txidHex, vout: ESCROW_UTXO.vout, valueSats: 0n, scriptPubKeyHex: `5120${ddTokenOutputKey(EPHEMERAL_KEY)}`, sequence: 0xfffffffe },
      { txidHex: 'f1'.repeat(32), vout: 0, valueSats: 15_000_000n, scriptPubKeyHex: `5120${ddTokenOutputKey(FEE_KEY)}`, sequence: 0xfffffffe },
    ],
    outputs: after.outputs, inputIndex: 1,
  });
  assert.ok(schnorr.verify(h2b(after.witnesses[1][0]), h2b(feeDigest), h2b(ddTokenOutputKey(FEE_KEY))));
});

test('fee attachment refuses a coin below the DD fee floor or above the burn cap', async () => {
  const { buildSignedDistributionTx, attachDistributionFee, MAX_ATTACHED_FEE_SATS } = await import('digidollar-js');
  const { chunkRecord } = buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO,
    ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK,
    lockTimeHeight: UNLOCK_HEIGHT,
  });
  const attach = (valueSats, maxBurnSats) => attachDistributionFee({
    chunkRecord,
    escrowKeyHex: EPHEMERAL_KEY,
    lockTimeHeight: UNLOCK_HEIGHT,
    feeUtxo: { txidHex: 'f1'.repeat(32), vout: 0, valueSats },
    feePrivKeyHex: FEE_PRIV,
    maxBurnSats,
  });
  assert.equal(MAX_ATTACHED_FEE_SATS, 50_000_000n); // 0.5 DGB
  assert.throws(() => attach(9_999_999n), /spent in full/);      // under the 0.1 DGB DD floor
  assert.throws(() => attach(50_000_001n), /spent in full/);     // over the default burn cap
  assert.ok(attach(50_000_000n).hex);                            // exactly at the cap
  assert.throws(() => attach(20_000_000n, 15_000_000n), /spent in full/); // caller-tightened cap
});

test('every new shape survives a parse/serialize round trip', async () => {
  const lib = await import('digidollar-js');
  const lock = lib.buildSignedBondLockTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 10_000n },
    feeUtxo: FEE_UTXO, privKeyHex: STAKER_PRIV, cents: BOND_CENTS,
    unlockHeight: UNLOCK_HEIGHT, stakerKeyHex: STAKER_KEY, feeSats: FEE_SATS,
  }).hex;
  const unlock = lib.buildSignedBondUnlockTx({
    bondUtxo: { ...BOND_UTXO, bond: BOND_RECORD }, feeUtxo: FEE_UTXO,
    stakerPrivKeyHex: STAKER_PRIV, feePrivKeyHex: FEE_PRIV, feeSats: FEE_SATS,
  }).hex;
  const split = lib.buildSignedEscrowSplitTx({
    ddUtxos: [{ txidHex: 'aa'.repeat(32), vout: 0, ddCents: 500_000n }],
    feeUtxo: FEE_UTXO, operatorPrivKeyHex: '0e'.repeat(32),
    ephemeralKeyHex: EPHEMERAL_KEY, chunks: [CHUNK], feeSats: FEE_SATS,
  }).hex;
  const dist = lib.buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO, ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK, lockTimeHeight: UNLOCK_HEIGHT,
  }).hex;
  for (const hex of [lock, unlock, split, dist]) {
    const tx = lib.parseTx(hex);
    const again = lib.serializeTx({
      version: tx.version, locktime: tx.locktime, inputs: tx.inputs,
      outputs: tx.outputs.map((o) => ({ valueSats: o.valueSats, script: h2b(o.scriptHex) })),
      witnesses: tx.witnesses.map((w) => w.map(h2b)),
    });
    assert.equal(again, hex);
  }
});

// ---- the received-bytes verifier and its mutation battery ----
// Every transaction below is serialized and signed BY THIS FILE, so a doctored
// chunk is doctored independently of src/txbuild.js. Each mutation must flip a
// specific NAMED check — the assertions are on the exact set of failures, so a
// check that stops firing, or one that starts firing on the wrong thing, is a
// test failure rather than a silent loss of coverage.

/** Minimal segwit serializer (test-only), the mirror of the parser in spend.test.js. */
function serialize({ version, locktime, inputs, outputs, witnesses }) {
  const parts = [u32le(version), Uint8Array.from([0x00, 0x01]), compact(inputs.length)];
  for (const i of inputs) {
    const scriptSig = i.scriptSigHex ?? '';
    parts.push(h2b(i.txidHex).reverse(), u32le(i.vout), compact(scriptSig.length / 2));
    if (scriptSig) parts.push(h2b(scriptSig));
    parts.push(u32le(i.sequence));
  }
  parts.push(compact(outputs.length));
  for (const o of outputs) parts.push(u64le(o.valueSats), compact(o.scriptHex.length / 2), h2b(o.scriptHex));
  for (const w of witnesses) {
    parts.push(compact(w.length));
    for (const item of w) parts.push(compact(item.length / 2), h2b(item));
  }
  parts.push(u32le(locktime));
  return b2h(cat(...parts));
}

/** BIP-341/386 key-path signature, tweak included — written here, not imported. */
async function signKeyPath(digestHex, privHex, hashType) {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const n = secp256k1.Point.CURVE().n;
  const d0 = BigInt(`0x${privHex}`);
  const P = secp256k1.Point.BASE.multiply(d0).toAffine();
  const d = (P.y & 1n) === 0n ? d0 : n - d0; // even-Y normalization
  const t = BigInt(`0x${b2h(taggedHash('TapTweak', h2b(P.x.toString(16).padStart(64, '0'))))}`);
  const sig = schnorr.sign(h2b(digestHex), h2b((((d + t) % n)).toString(16).padStart(64, '0')));
  return b2h(sig) + (hashType === 0x00 ? '' : hashType.toString(16).padStart(2, '0'));
}

const ESCROW_PREVOUT = { txidHex: ESCROW_UTXO.txidHex, vout: ESCROW_UTXO.vout };

/**
 * Forge a chunk record to order. Every mutation in the battery is one field of
 * this description; the signature is recomputed over whatever it produces, so a
 * mutation isolates its own check instead of merely breaking the signature.
 */
async function forge({
  payouts = CHUNK.payouts, recordPayouts, escrowCents, prevout = ESCROW_PREVOUT, recordPrevout, lockTime = UNLOCK_HEIGHT,
  version = TRANSFER_VERSION, sequence = 0xfffffffe, envelopeAmounts, mangleSig, v = 1,
  scriptSigHex = '', extraDDOutput = false, outputAfterEnvelope = false,
} = {}) {
  const { buildTransferMetadata } = await import('digidollar-js');
  const envelopeHex = buildTransferMetadata({ amountsCents: envelopeAmounts ?? payouts.map((p) => p.cents) });
  const stray = { valueSats: 0n, scriptHex: `5120${key('ee')}` };
  const outputs = [
    ...payouts.map((p) => ({ valueSats: 0n, scriptHex: `5120${p.outputKeyHex}` })),
    ...(extraDDOutput ? [stray] : []),
    { valueSats: 0n, scriptHex: envelopeHex },
    ...(outputAfterEnvelope ? [stray] : []),
  ];
  const inputs = [{
    txidHex: prevout.txidHex, vout: prevout.vout, sequence, scriptSigHex,
    valueSats: 0n, scriptPubKeyHex: `5120${ddTokenOutputKey(EPHEMERAL_KEY)}`,
  }];
  const digest = bip341Sighash({ hashType: 0x81, version, locktime: lockTime, inputs, outputs, inputIndex: 0 });
  let sig = await signKeyPath(digest, EPHEMERAL_PRIV, 0x81);
  if (mangleSig) sig = mangleSig(sig);
  const published = recordPayouts ?? payouts;
  return {
    v,
    txHex: serialize({ version, locktime: lockTime, inputs, outputs, witnesses: [[sig]] }),
    escrow: { ...(recordPrevout ?? prevout), cents: escrowCents ?? sum(published.map((p) => p.cents)) },
    payouts: published,
    lockTimeHeight: lockTime,
  };
}

const EXPECT = { escrowKeyHex: EPHEMERAL_KEY, lockTimeHeight: UNLOCK_HEIGHT };
const failedNames = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

test('a well-formed chunk passes every check, signature verification included', async () => {
  const { verifyDistributionChunk, buildSignedDistributionTx } = await import('digidollar-js');
  // The real builder's record…
  const { chunkRecord } = buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO, ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK, lockTimeHeight: UNLOCK_HEIGHT,
  });
  const real = verifyDistributionChunk({ chunkRecord, expect: EXPECT });
  assert.ok(real.ok, JSON.stringify(real.checks.filter((c) => !c.ok)));
  assert.ok(real.checks.some((c) => c.name === 'acp-signature' && c.ok));
  assert.deepEqual(real.checks.map((c) => c.name), [
    'record-version', 'record-shape',
    'parse', 'scriptsig-empty', 'dd-marker', 'output-shapes', 'envelope-present',
    'envelope-pairing', 'envelope-exact', 'envelope-size', 'dd-minimum', 'dd-maximum',
    'dd-conservation', 'dd-outputs-match', 'valued-outputs-match', 'locktime',
    'input-count', 'escrow-prevout', 'sequence-non-final', 'record-locktime',
    'no-valued-output', 'payout-count', 'payout-sum', 'acp-signature',
  ]);
  // …and this file's own forgery of the same chunk, which must agree.
  assert.ok(verifyDistributionChunk({ chunkRecord: await forge(), expect: EXPECT }).ok);

  // The staker's own diligence question: am I actually paid by this chunk?
  const mine = verifyDistributionChunk({
    chunkRecord,
    expect: { ...EXPECT, payoutsMustInclude: [{ outputKeyHex: CHUNK.payouts[0].outputKeyHex, cents: CHUNK.payouts[0].cents }] },
  });
  assert.ok(mine.ok);
  const notMine = verifyDistributionChunk({
    chunkRecord,
    expect: { ...EXPECT, payoutsMustInclude: [{ outputKeyHex: 'ab'.repeat(32) }] },
  });
  assert.deepEqual(failedNames(notMine), ['payouts-include']);
});

test('mutation battery: every doctored chunk flips its own named check', async () => {
  const { verifyDistributionChunk } = await import('digidollar-js');
  const check = async (name, description, expectedFailures) => {
    const record = await forge(description);
    assert.deepEqual(failedNames(verifyDistributionChunk({ chunkRecord: record, expect: EXPECT })), expectedFailures, name);
  };
  const [first, second] = CHUNK.payouts;

  // 1. The DigiDollar marker stripped out of nVersion: consensus stops seeing a
  //    transfer at all, and the payouts silently cease to be DigiDollar.
  await check('marker stripped', { version: 2 }, ['dd-marker']);
  // 2. Envelope amounts reordered against the outputs they pair with.
  await check('envelope reordered', { envelopeAmounts: [second.cents, first.cents] }, ['dd-outputs-match']);
  // 3. An extra amount push — Core's exact-count rule (validation.cpp:1744/1769).
  //    It breaks conservation too: the envelope now claims 100c the escrow
  //    never funded, which is the reason the count rule exists.
  await check('extra envelope push', { envelopeAmounts: [first.cents, second.cents, 100n] }, ['dd-conservation', 'envelope-pairing']);
  // 4. A payout below the $1.00 consensus minimum for a DigiDollar output.
  await check('sub-$1 payout', {
    payouts: [{ ...first, cents: 50n }, second],
    escrowCents: 50n + second.cents,
  }, ['dd-minimum']);
  // 5. Nine payouts — over the product cap the 83-byte envelope enforces.
  const nine = Array.from({ length: 9 }, (_, i) => ({ outputKeyHex: key((i + 1).toString(16).padStart(2, '0')), cents: 100n + BigInt(i) }));
  await check('nine payouts', { payouts: nine }, ['payout-count']);
  // 6. An envelope over the 83-byte relay cap (policy.h:74).
  const fat = Array.from({ length: 7 }, (_, i) => ({ outputKeyHex: key((i + 1).toString(16).padStart(2, '0')), cents: 2n ** 80n + BigInt(i) }));
  //     (Such amounts are also over the $100,000 maximum — an envelope that fat
  //     is unreachable with legal amounts, so both checks fire.)
  await check('84-byte envelope', { payouts: fat }, ['dd-maximum', 'envelope-size']);
  // 7. nLockTime off by one: broadcastable a block early.
  await check('locktime off by one', { lockTime: UNLOCK_HEIGHT - 1 }, ['locktime', 'record-locktime']);
  // 8. The published record still names me, but the BYTES pay someone else —
  //    the exact attack the verifier exists to catch. The signature is valid
  //    over the tampered outputs, so only re-deriving from the bytes finds it.
  await check('tampered payout key', {
    payouts: [{ outputKeyHex: key('ee'), cents: first.cents }, second],
    recordPayouts: CHUNK.payouts,
  }, ['dd-outputs-match']);
  // 9-10. Signature shape: the hash-type byte is what makes it ANYONECANPAY.
  await check('truncated 64-byte signature', { mangleSig: (s) => s.slice(0, -2) }, ['acp-signature']);
  await check('wrong hash-type byte', { mangleSig: (s) => `${s.slice(0, -2)}01` }, ['acp-signature']);
  await check('flipped signature byte', { mangleSig: (s) => `${s.slice(0, 2) === 'ff' ? '00' : 'ff'}${s.slice(2)}` }, ['acp-signature']);
  // 11. A final input disables nLockTime entirely.
  await check('final sequence', { sequence: 0xffffffff }, ['sequence-non-final']);
  // 12. The transaction spends an escrow the record does not name.
  await check('wrong escrow prevout', { prevout: { txidHex: 'de'.repeat(32), vout: 7 }, recordPrevout: ESCROW_PREVOUT }, ['escrow-prevout']);
  // 13. The record's escrow does not fund its own payouts.
  await check('payout sum mismatch', { escrowCents: CHUNK.sumCents + 1n }, ['dd-conservation', 'payout-sum']);
  // 14. An injected scriptSig: no signature commits to it, so the bytes still
  //     verify while carrying a txid nobody checked.
  await check('injected scriptSig', { scriptSigHex: '51' }, ['scriptsig-empty']);
  // 15. An extra zero-value P2TR output the record does not mention — an
  //     unannounced payee riding along with the ones that were verified.
  await check('extra DD output', { extraDDOutput: true }, ['dd-outputs-match', 'envelope-pairing']);
  // 16. The envelope is no longer the last output (Core's TransferTxBuilder
  //     order, and the order every Lock & Earn shape is built in).
  await check('output after the envelope', { outputAfterEnvelope: true }, ['envelope-present']);
  // 17. A payout above the $100,000 per-output maximum (validation.cpp:1761).
  await check('payout over $100,000', {
    payouts: [{ ...first, cents: 10_000_001n }, second],
    escrowCents: 10_000_001n + second.cents,
  }, ['dd-maximum']);
  // 18. A future record version: refuse before trusting any field.
  const v2 = await forge({ v: 2 });
  const verdict = verifyDistributionChunk({ chunkRecord: v2, expect: EXPECT });
  assert.deepEqual(failedNames(verdict), ['record-version']);
  assert.equal(verdict.checks.length, 1, 'nothing past the version is trusted');
});

test('the verifier reports malformed input instead of throwing', async () => {
  const { verifyDistributionChunk } = await import('digidollar-js');
  for (const chunkRecord of [undefined, null, {}, { v: 1 }, { v: '1' }]) {
    const r = verifyDistributionChunk({ chunkRecord, expect: EXPECT });
    assert.equal(r.ok, false);
    assert.ok(r.checks.length >= 1);
  }
  const broken = verifyDistributionChunk({
    chunkRecord: { v: 1, txHex: 'zz', escrow: { txidHex: 'aa'.repeat(32), vout: 0, cents: 100n }, payouts: [{ outputKeyHex: ALICE, cents: 100n }], lockTimeHeight: 1 },
    expect: EXPECT,
  });
  assert.equal(broken.ok, false);
  assert.deepEqual(failedNames(broken), ['parse']);

  // A record that has been through JSON cannot carry BigInt cents. Mixing those
  // with ours throws deep inside the arithmetic — which must still surface as a
  // named failure, because this function's callers render a list.
  const record = await forge();
  const fromJson = { ...record, payouts: record.payouts.map((p) => ({ ...p, cents: Number(p.cents) })) };
  const verdict = verifyDistributionChunk({ chunkRecord: fromJson, expect: EXPECT });
  assert.equal(verdict.ok, false);
  assert.ok(failedNames(verdict).includes('verifier-error'), 'named verifier-error, not an exception');
});

test('a transaction with no outputs at all still fails by name', async () => {
  const { verifyDistributionChunk } = await import('digidollar-js');
  const empty = serialize({ version: TRANSFER_VERSION, locktime: UNLOCK_HEIGHT, inputs: [{ txidHex: ESCROW_PREVOUT.txidHex, vout: 0, sequence: 0xfffffffe }], outputs: [], witnesses: [[]] });
  const r = verifyDistributionChunk({
    chunkRecord: { v: 1, txHex: empty, escrow: { ...ESCROW_PREVOUT, cents: 100n }, payouts: [{ outputKeyHex: ALICE, cents: 100n }], lockTimeHeight: UNLOCK_HEIGHT },
    expect: EXPECT,
  });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'envelope-present' && !c.ok));
});

// ---- block-height bounds (BIP-65 LOCKTIME_THRESHOLD) ----

test('a bond refuses an unlock height that CLTV cannot compare as a height', async () => {
  const { buildSignedDistributionTx } = await import('digidollar-js');
  // Two distinct failures, one bound. At or above 500,000,000 (BIP-65
  // LOCKTIME_THRESHOLD) CLTV compares the leaf value against the block TIME, so
  // a "height" up there is really a 1985 timestamp and the lock is a no-op.
  // At or above 2^32 the leaf keeps a 5-byte CScriptNum while nLockTime is a
  // uint32 that truncates — the comparison can then NEVER succeed, and with a
  // single leaf under NUMS there is no other way to spend the bond: it is
  // permanently unspendable.
  for (const h of [500_000_000, 500_000_001, 2 ** 32, 2 ** 32 + 5]) {
    assert.throws(() => bondLeafHex({ stakerKeyHex: STAKER_KEY, unlockHeight: h }), /500,000,000|block height/);
  }
  assert.ok(bondLeafHex({ stakerKeyHex: STAKER_KEY, unlockHeight: 499_999_999 }));

  // The distribution's nLockTime is the same comparison, on the other side.
  assert.throws(() => buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO, ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK, lockTimeHeight: 500_000_000,
  }), /500,000,000|block height/);
});

test('the gate catches a bond unlock whose nLockTime was edited to zero', async () => {
  const { buildSignedBondUnlockTx } = await import('digidollar-js');
  const { checkBuiltDDTx } = await import('../src/txbuild.js');
  const { hex } = buildSignedBondUnlockTx({
    bondUtxo: { ...BOND_UTXO, bond: BOND_RECORD },
    feeUtxo: FEE_UTXO, stakerPrivKeyHex: STAKER_PRIV, feePrivKeyHex: FEE_PRIV,
    feeSats: FEE_SATS, dgbChangeScriptHex: DGB_CHANGE_SCRIPT,
  });
  // nLockTime is the last four bytes. Zeroing it makes the CLTV unsatisfiable
  // while leaving every output, amount and envelope byte untouched.
  const zeroed = `${hex.slice(0, -8)}00000000`;
  const expect = {
    type: 'transfer', ddInCents: BOND_CENTS,
    ddOutputs: [{ outputKeyHex: ddTokenOutputKey(STAKER_KEY), cents: BOND_CENTS }],
    valuedOutputs: [{ scriptHex: DGB_CHANGE_SCRIPT, valueSats: 88_000_000n }],
    locktime: UNLOCK_HEIGHT,
    sequences: [0xfffffffe, 0xffffffff],
  };
  assert.ok(checkBuiltDDTx({ txHex: hex, expect }).ok);
  assert.deepEqual(
    checkBuiltDDTx({ txHex: zeroed, expect }).checks.filter((c) => !c.ok).map((c) => c.name),
    ['locktime'],
  );
  // And a finalized bond input, which disables nLockTime altogether.
  assert.deepEqual(
    checkBuiltDDTx({ txHex: hex, expect: { ...expect, sequences: [0xffffffff, 0xffffffff] } })
      .checks.filter((c) => !c.ok).map((c) => c.name),
    ['input-sequences'],
  );
});

// ---- fee attachment certifies against the CALLER's height ----

test('fee attachment verifies against the height the caller knows, not the record', async () => {
  const { buildSignedDistributionTx, attachDistributionFee } = await import('digidollar-js');
  // A record that says its own nLockTime is 99,000,000 and is internally
  // consistent about it. Checking the record against itself certifies nothing;
  // the staker knows the epoch's real height independently.
  const { chunkRecord } = buildSignedDistributionTx({
    escrowUtxo: ESCROW_UTXO, ephemeralPrivKeyHex: EPHEMERAL_PRIV,
    chunk: CHUNK, lockTimeHeight: 99_000_000,
  });
  assert.throws(() => attachDistributionFee({
    chunkRecord,
    escrowKeyHex: EPHEMERAL_KEY,
    lockTimeHeight: UNLOCK_HEIGHT, // what the epoch actually says
    feeUtxo: { txidHex: 'f1'.repeat(32), vout: 0, valueSats: 15_000_000n },
    feePrivKeyHex: FEE_PRIV,
  }), /locktime/);
});

// ---- canonical ordering, carry validation, the split cap ----

test('planning refuses payouts that are not in the canonical order', async () => {
  const { planDistributionChunks: plan } = await import('digidollar-js');
  const [a, b] = [{ outputKeyHex: ALICE, cents: 100n }, { outputKeyHex: BOB, cents: 200n }].sort(byKey);
  assert.equal(plan({ payouts: [a, b] }).length, 1);
  assert.throws(() => plan({ payouts: [b, a] }), /ascending/);
  assert.throws(() => plan({ payouts: [a, a] }), /ascending/); // strict: no duplicates
});

test('carry-in entries are validated before they can break the ledger', () => {
  assert.throws(() => computeFloorShares({ stakes: STAKES, poolCents: 3_285n, carryInCents: { [CAROL]: -1n } }), /carry/);
  assert.throws(() => computeFloorShares({ stakes: STAKES, poolCents: 3_285n, carryInCents: { [CAROL]: 60 } }), /carry/);
  assert.throws(() => computeFloorShares({ stakes: STAKES, poolCents: 3_285n, carryInCents: { nope: 60n } }), /32-byte hex/);
});

test('the escrow-split cap is its own constant, named for what it bounds', async () => {
  const { MAX_CHUNKS_PER_SPLIT, MAX_PAYOUTS_PER_CHUNK: perChunk } = await import('digidollar-js');
  assert.equal(MAX_CHUNKS_PER_SPLIT, 8);
  assert.equal(MAX_CHUNKS_PER_SPLIT * perChunk, 64); // the pilot's paid-staker ceiling
});
