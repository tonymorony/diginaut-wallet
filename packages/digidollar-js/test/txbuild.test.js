// Offline differential tests for transfer tx assembly against a real Core-built
// transfer (test/fixtures/transfer-tx.json, txid 9b3069da…): a $30 send with
// $70 DD change, built by senddigidollar on the regtest stand.
// The owner key comes from the mint fixture's OP_RETURN (the DD input being
// spent is the mint's DD token output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransferOutputs, buildRedeemOutputs, serializeTx, ddTokenOutputKey, buildSignedTransferTx, buildSignedRedeemTx, buildSignedMintTx, LOCK_TIERS, MIN_DD_TX_FEE_SATS, STANDARD_FEE_RATE_SATS_PER_KVB } from 'digidollar-js';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/transfer-tx.json', import.meta.url), 'utf8'),
).result;

const OWNER_KEY_HEX = 'c20a139635a064cbfb7ee7c8f1d4362de68f5d6b02e8cf1f6906f0c0e760c034'; // mint fixture owner
const RECIPIENT_OUTPUT_KEY = fixture.vout[0].scriptPubKey.hex.slice(4); // already-tweaked P2TR key

function coreOutputs() {
  return buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 3_000n }],
    ddChangeCents: 7_000n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 1_436_990_756n,
    dgbChangeScriptHex: fixture.vout[2].scriptPubKey.hex,
  });
}

test('rebuilds all four Core transfer outputs byte-for-byte', () => {
  const outputs = coreOutputs();
  assert.equal(outputs.length, 4);
  for (const [i, out] of outputs.entries()) {
    const expected = fixture.vout[i];
    assert.equal(out.valueSats, BigInt(Math.round(expected.value * 1e8)), `vout[${i}] value`);
    assert.equal(
      [...out.script].map((b) => b.toString(16).padStart(2, '0')).join(''),
      expected.scriptPubKey.hex,
      `vout[${i}] script`,
    );
  }
});

test('DD change output key is the tweaked owner key (same as the mint DD token output)', () => {
  // Core reuses CreateDigiDollarP2TR's key-path-only tweak for DD change.
  assert.equal(ddTokenOutputKey(OWNER_KEY_HEX), fixture.vout[1].scriptPubKey.hex.slice(4));
});

test('reserializes the entire Core transfer byte-for-byte (fixture witnesses substituted)', () => {
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const hex = serializeTx({
    version: fixture.version,
    locktime: fixture.locktime,
    inputs: fixture.vin.map((v) => ({ txidHex: v.txid, vout: v.vout, sequence: v.sequence })),
    outputs: coreOutputs(),
    witnesses: fixture.vin.map((v) => v.txinwitness.map(hexToBytes)),
  });
  assert.equal(hex, fixture.hex);
});

// ---- Redeem (test/fixtures/redeem-tx.json, txid b834557b…) ----
// Core redemption of the 1hour-tier mint 4f30aa8f… ($100, lockHeight 1064):
// exact burn — no DD change, no OP_RETURN; collateral returned in full.

const redeemFixture = JSON.parse(
  await readFile(new URL('./fixtures/redeem-tx.json', import.meta.url), 'utf8'),
).result;

function coreRedeemOutputs() {
  return buildRedeemOutputs({
    collateralReturnSats: 7_526_080_476_901n,
    collateralReturnScriptHex: redeemFixture.vout[0].scriptPubKey.hex,
    dgbChangeSats: 1_421_555_756n,
    dgbChangeScriptHex: redeemFixture.vout[1].scriptPubKey.hex,
  });
}

test('rebuilds both Core redeem outputs byte-for-byte (exact burn: no OP_RETURN)', () => {
  const outputs = coreRedeemOutputs();
  assert.equal(outputs.length, 2);
  for (const [i, out] of outputs.entries()) {
    const expected = redeemFixture.vout[i];
    assert.equal(out.valueSats, BigInt(Math.round(expected.value * 1e8)), `vout[${i}] value`);
    assert.equal(
      [...out.script].map((b) => b.toString(16).padStart(2, '0')).join(''),
      expected.scriptPubKey.hex,
      `vout[${i}] script`,
    );
  }
});

test('redeem with DD change appends a DD change P2TR and a type-3 OP_RETURN', () => {
  // Layout per Core BuildRedemptionTransaction: collateral return, DD change,
  // OP_RETURN "DD" <3> <change>, then DGB change. Amounts mirror the (fixture-
  // proven) transfer CScriptNum encoding.
  const outputs = buildRedeemOutputs({
    collateralReturnSats: 100n,
    collateralReturnScriptHex: redeemFixture.vout[0].scriptPubKey.hex,
    ddChangeCents: 3_000n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 50n,
    dgbChangeScriptHex: redeemFixture.vout[1].scriptPubKey.hex,
  });
  assert.equal(outputs.length, 4);
  const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(toHex(outputs[1].script), '5120' + ddTokenOutputKey(OWNER_KEY_HEX));
  assert.equal(toHex(outputs[2].script), '6a024444010302b80b');
  assert.equal(outputs[3].valueSats, 50n);
});

test('reserializes the entire Core redeem byte-for-byte (fixture witnesses substituted)', () => {
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const hex = serializeTx({
    version: redeemFixture.version,
    locktime: redeemFixture.locktime,
    inputs: redeemFixture.vin.map((v) => ({ txidHex: v.txid, vout: v.vout, sequence: v.sequence })),
    outputs: coreRedeemOutputs(),
    witnesses: redeemFixture.vin.map((v) => v.txinwitness.map(hexToBytes)),
  });
  assert.equal(hex, redeemFixture.hex);
});

// ---- dust DGB change is folded into the fee (all three DD builders) ----
// The plain-spend builder has folded change below CHANGE_FOLD_SATS since #6.
// The DigiDollar builders did not, so a fee coin worth a hair more than the fee
// produced a dust DGB change output — and the node rejects the whole
// transaction, which means the DigiDollar cannot move at all.
const FOLD_SATS = 100_000n;      // CHANGE_FOLD_SATS, restated so the test is independent
const TEST_KEY = '11'.repeat(32);
const MARKED_CHANGE_SCRIPT = '0014' + 'cd'.repeat(20); // recognisable in the serialized tx

/** Number of outputs in a serialized segwit tx whose inputs all have empty scriptSig. */
function voutCount(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4; // version
  assert.deepEqual([...b.subarray(o, o + 2)], [0x00, 0x01], 'segwit marker+flag');
  o += 2;
  const varint = () => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    assert.equal(v, 0xfd, 'compact varint only');
    const n = b.readUInt16LE(o + 1); o += 3; return n;
  };
  const nIn = varint();
  o += nIn * 41; // txid(32) + vout(4) + scriptSig len 0x00(1) + sequence(4)
  return varint();
}

test('transfer folds dust DGB change into the fee instead of emitting it', () => {
  const feeSats = 12_000_000n;
  const args = {
    ddUtxo: { txidHex: 'ab'.repeat(32), vout: 1, ddCents: 10_000n },
    privKeyHex: TEST_KEY,
    recipients: [{ outputKeyHex: ddTokenOutputKey(OWNER_KEY_HEX), cents: 10_000n }],
    feeSats,
    dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
  };
  // 1 sat under the fold threshold: dust, must not become an output
  const dust = buildSignedTransferTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.dgbChangeSats, 0n);
  assert.ok(!dust.hex.includes(MARKED_CHANGE_SCRIPT), 'dust change output must be absent');
  assert.equal(voutCount(dust.hex), 2); // recipient DD + OP_RETURN

  // exactly at the threshold: still worth an output, nothing changes
  const kept = buildSignedTransferTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS },
  });
  assert.equal(kept.dgbChangeSats, FOLD_SATS);
  assert.ok(kept.hex.includes(MARKED_CHANGE_SCRIPT));
  assert.equal(voutCount(kept.hex), 3);
});

test('redeem folds dust DGB change into the fee, leaving the collateral return as the DGB output', () => {
  const feeSats = 16_000_000n;
  const args = {
    collateralUtxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 500_000_000n, lockHeight: 200, ddCents: 10_000n },
    ddUtxos: [{ txidHex: 'ef'.repeat(32), vout: 1, ddCents: 10_000n }],
    privKeyHex: TEST_KEY,
    feeSats,
    dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
  };
  const dust = buildSignedRedeemTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.dgbChangeSats, 0n);
  assert.ok(!dust.hex.includes(MARKED_CHANGE_SCRIPT));
  // Only the collateral return is left — and that is what satisfies Core's
  // "bad-redeem-no-dgb-output" check (digidollar/validation.cpp:2154), which
  // wants any output with nValue > 0, not the change specifically.
  assert.equal(voutCount(dust.hex), 1);

  const kept = buildSignedRedeemTx({
    ...args,
    feeUtxo: { txidHex: 'cd'.repeat(32), vout: 0, valueSats: feeSats + FOLD_SATS },
  });
  assert.equal(kept.dgbChangeSats, FOLD_SATS);
  assert.equal(voutCount(kept.hex), 2);
});

test('mint folds dust change into the fee rather than emitting a dust (or zero-value) output', () => {
  const feeSats = 12_000_000n;
  const base = {
    privKeyHex: TEST_KEY,
    ddCents: 10_000n,
    tierId: LOCK_TIERS[0].id,
    oraclePriceMicroUsd: 13_400n,
    tipHeight: 1_000,
    feeSats,
  };
  const probe = buildSignedMintTx({ ...base, utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n } });
  const collateralSats = probe.collateralSats;

  const dust = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats + FOLD_SATS - 1n },
  });
  assert.equal(dust.changeSats, 0n);
  assert.equal(voutCount(dust.hex), 3); // collateral + DD token + OP_RETURN

  // Exact funding used to emit a ZERO-value P2WPKH output, non-standard on its own.
  const exact = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats },
  });
  assert.equal(exact.changeSats, 0n);
  assert.equal(voutCount(exact.hex), 3);

  const kept = buildSignedMintTx({
    ...base,
    utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: collateralSats + feeSats + FOLD_SATS },
  });
  assert.equal(kept.changeSats, FOLD_SATS);
  assert.equal(voutCount(kept.hex), 4);
});

// ---- every DD output of a transfer is checked against the $1 minimum ----
// Consensus checks all of them, change included: the loop at
// digidollar/validation.cpp:1743 rejects with "transfer-dd-amount-below-minimum".
// Only the recipient was ever validated (app.js), so spending $10.00 out of a
// $10.50 coin built a transfer with 50c of change that the network refuses.
test('transfer refuses to build sub-$1 DD change', () => {
  const build = (ddChangeCents) => buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 3_000n }],
    ddChangeCents,
    changeOwnerKeyHex: OWNER_KEY_HEX,
    dgbChangeSats: 1_436_990_756n,
    dgbChangeScriptHex: fixture.vout[2].scriptPubKey.hex,
  });
  assert.throws(() => build(99n), /\$1\.00/);      // 1 cent under: rejected
  assert.equal(build(100n).length, 4);             // exactly $1.00: legal
  assert.equal(build(0n).length, 3);               // no change output at all
});

test('transfer refuses a sub-$1 RECIPIENT too, not just change', () => {
  // Wider than the reported finding, and correct: consensus does not
  // distinguish. No in-repo caller sends sub-$1, but buildTransferOutputs is
  // publicly re-exported, so an embedder gets the same guard.
  assert.throws(() => buildTransferOutputs({
    recipients: [{ outputKeyHex: RECIPIENT_OUTPUT_KEY, cents: 50n }],
    ddChangeCents: 0n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
  }), /\$1\.00/);
});

test('redeem still builds sub-$1 DD change — Core accepts it, and refusing would strand the position', () => {
  // The redemption scan (validation.cpp:2107-2149) enforces only "at most one
  // DD change output" plus a serialization bound; it never calls
  // ValidateOutputAmount. Full redemption is all-or-nothing, so a builder that
  // refused here would leave a user with no way to free their collateral.
  const outputs = buildRedeemOutputs({
    collateralReturnSats: 500_000_000n,
    collateralReturnScriptHex: '5120' + ddTokenOutputKey(OWNER_KEY_HEX),
    ddChangeCents: 50n,
    changeOwnerKeyHex: OWNER_KEY_HEX,
  });
  assert.equal(outputs.length, 3); // collateral + DD change P2TR + OP_RETURN
});

// ---- the flexible DGB leg: any wallet key, key-path P2TR or P2WPKH ----
// Mint change is P2WPKH by construction (buildSignedMintTx emits it), and every
// DigiDollar flow used to refuse a P2WPKH coin for its DGB leg — so minting
// with your only coin left change that could fund nothing. Consensus never
// required that: this repo's own Core captures show both shapes, redeem-tx.json
// vin[3] (a [71, 33] fee witness) and mint-tx.json vin[0] (the same, funding a
// mint). Signatures carry schnorr aux randomness and variable-length DER, so
// these pins compare the transaction BODY and the witness SHAPES, never bytes.

const FEE_KEY = '22'.repeat(32); // a second wallet key, distinct from TEST_KEY

/** Every witness stack of a serialized segwit tx (all scriptSigs empty). */
function witnessStacks(hex) {
  const b = Buffer.from(hex, 'hex');
  assert.deepEqual([...b.subarray(4, 6)], [0x00, 0x01], 'segwit marker+flag');
  let o = 6;
  const varint = () => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    assert.equal(v, 0xfd, 'compact varint only');
    const n = b.readUInt16LE(o + 1); o += 3; return n;
  };
  const nIn = varint();
  o += nIn * 41; // txid + vout + empty scriptSig + sequence
  const nOut = varint();
  for (let i = 0; i < nOut; i++) { o += 8; const len = varint(); o += len; } // value, then script
  const stacks = [];
  for (let i = 0; i < nIn; i++) {
    const items = [];
    for (let n = varint(); n > 0; n--) { const len = varint(); items.push(b.subarray(o, o + len)); o += len; }
    stacks.push(items);
  }
  return stacks;
}

/** Hex prefix covering everything before the witness section. */
function txBodyPrefix(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 6;
  const varint = () => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    const n = b.readUInt16LE(o + 1); o += 3; return n;
  };
  const nIn = varint();
  o += nIn * 41;
  const nOut = varint();
  for (let i = 0; i < nOut; i++) { o += 8; const len = varint(); o += len; }
  return hex.slice(0, o * 2);
}

const shapesOf = (hex) => witnessStacks(hex).map((s) => s.map((i) => i.length));

/** BIP-141 weight of a serialized tx: witness bytes ·1, everything else ·4. */
function txWeight(hex) {
  const total = BigInt(hex.length / 2);
  // the body prefix covers version + marker/flag + inputs + outputs; marker and
  // flag are witness data, and the trailing locktime is not
  const nonWitness = BigInt(txBodyPrefix(hex).length / 2) - 2n + 4n;
  return nonWitness * 4n + (total - nonWitness);
}

/** A stack that spends a P2WPKH: [lowS DER sig + SIGHASH_ALL, compressed pubkey]. */
function assertP2wpkhStack(stack, label) {
  assert.equal(stack.length, 2, `${label}: [DER sig, pubkey]`);
  assert.equal(stack[0][0], 0x30, `${label}: DER sequence tag`);
  assert.equal(stack[0][stack[0].length - 1], 0x01, `${label}: SIGHASH_ALL byte`);
  assert.ok(stack[0].length >= 71 && stack[0].length <= 73, `${label}: DER length ${stack[0].length}`);
  assert.equal(stack[1].length, 33, `${label}: compressed pubkey`);
  assert.ok(stack[1][0] === 0x02 || stack[1][0] === 0x03, `${label}: pubkey prefix`);
}

const FEE_COIN = { txidHex: 'cd'.repeat(32), vout: 0, valueSats: 20_000_000n };
const TRANSFER_ARGS = {
  ddUtxo: { txidHex: 'ab'.repeat(32), vout: 1, ddCents: 10_000n },
  privKeyHex: TEST_KEY,
  recipients: [{ outputKeyHex: ddTokenOutputKey(OWNER_KEY_HEX), cents: 10_000n }],
  feeSats: 12_000_000n,
  dgbChangeScriptHex: MARKED_CHANGE_SCRIPT, // pin the outputs so only the leg varies
};
const REDEEM_ARGS = {
  collateralUtxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 500_000_000n, lockHeight: 200, ddCents: 10_000n },
  ddUtxos: [{ txidHex: 'ef'.repeat(32), vout: 1, ddCents: 6_000n }, { txidHex: 'ef'.repeat(32), vout: 2, ddCents: 4_000n }],
  privKeyHex: TEST_KEY,
  feeSats: 16_000_000n,
  dgbChangeScriptHex: MARKED_CHANGE_SCRIPT,
};
const MINT_ARGS = {
  privKeyHex: TEST_KEY,
  ddCents: 10_000n,
  tierId: LOCK_TIERS[0].id,
  oraclePriceMicroUsd: 13_400n,
  tipHeight: 1_000,
  feeSats: 12_000_000n,
};

test('the fee/funding params default to the legacy single-key anatomy', () => {
  const transfer = buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: FEE_COIN });
  for (const variant of [
    buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: FEE_COIN, feePrivKeyHex: TEST_KEY }),
    buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: { ...FEE_COIN, type: 'p2tr' } }),
  ]) {
    assert.equal(txBodyPrefix(variant.hex), txBodyPrefix(transfer.hex), 'transfer body');
    assert.deepEqual(shapesOf(variant.hex), shapesOf(transfer.hex), 'transfer witness shapes');
  }
  assert.deepEqual(shapesOf(transfer.hex), [[64], [64]], 'DD token leg + key-path fee leg');

  const redeem = buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: FEE_COIN });
  for (const variant of [
    buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: FEE_COIN, feePrivKeyHex: TEST_KEY }),
    buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: { ...FEE_COIN, type: 'p2tr' } }),
  ]) {
    assert.equal(txBodyPrefix(variant.hex), txBodyPrefix(redeem.hex), 'redeem body');
    assert.deepEqual(shapesOf(variant.hex), shapesOf(redeem.hex), 'redeem witness shapes');
  }
  assert.deepEqual(shapesOf(redeem.hex), [[64, 44, 65], [64], [64], [64]], 'script-path collateral, two burns, fee');

  const utxo = { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n };
  const mint = buildSignedMintTx({ ...MINT_ARGS, utxo });
  const mintTagged = buildSignedMintTx({ ...MINT_ARGS, utxo: { ...utxo, type: 'p2tr' } });
  assert.equal(txBodyPrefix(mintTagged.hex), txBodyPrefix(mint.hex), 'mint body');
  assert.deepEqual(shapesOf(mint.hex), [[64]], 'key-path funding leg');
});

test('transfer signs a P2WPKH fee coin per BIP-143, leaving the DD leg key-path', () => {
  const { hex } = buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: { ...FEE_COIN, type: 'p2wpkh' } });
  const [ddLeg, feeLeg] = witnessStacks(hex);
  assert.deepEqual(ddLeg.map((i) => i.length), [64], 'DD token leg stays key-path schnorr');
  assertP2wpkhStack(feeLeg, 'transfer fee leg');
});

test('redeem signs a P2WPKH fee coin per BIP-143 at the bookkept index', () => {
  const { hex } = buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: { ...FEE_COIN, type: 'p2wpkh' } });
  const stacks = witnessStacks(hex);
  assert.equal(stacks.length, 4, 'collateral + two burn legs + fee');
  assert.equal(stacks[0].length, 3, 'collateral: script-path [sig, leaf, control block]');
  assert.deepEqual(stacks[1].map((i) => i.length), [64], 'burn leg 1');
  assert.deepEqual(stacks[2].map((i) => i.length), [64], 'burn leg 2');
  assertP2wpkhStack(stacks[3], 'redeem fee leg'); // index 1 + ddUtxos.length
});

test('mint funds from a P2WPKH coin — the shape its own change lands in (#38)', () => {
  const probe = buildSignedMintTx({ ...MINT_ARGS, utxo: { txidHex: 'ab'.repeat(32), vout: 0, valueSats: 10n ** 14n } });
  const utxo = {
    txidHex: 'ab'.repeat(32), vout: 0,
    valueSats: probe.collateralSats + MINT_ARGS.feeSats + 500_000_000n,
    type: 'p2wpkh',
  };
  const { hex, changeSats } = buildSignedMintTx({ ...MINT_ARGS, utxo });
  const stacks = witnessStacks(hex);
  assert.equal(stacks.length, 1);
  assertP2wpkhStack(stacks[0], 'mint funding leg');
  assert.equal(changeSats, 500_000_000n);
  assert.equal(voutCount(hex), 4); // collateral + DD token + OP_RETURN + P2WPKH change
});

test('a fee leg on another wallet key is signed by THAT key, and only that leg', async () => {
  // The input scriptPubKeys never reach the wire (scriptSig is empty), so the
  // proof that the right key signed the right leg is the witness itself: a
  // witness-v0 stack carries the pubkey it must hash to.
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const compressed = (k) => Buffer.from(secp256k1.getPublicKey(Buffer.from(k, 'hex'), true)).toString('hex');
  const feePubkey = compressed(FEE_KEY);
  assert.notEqual(feePubkey, compressed(TEST_KEY), 'the two keys are genuinely different');

  const crossFee = { ...FEE_COIN, type: 'p2wpkh' };
  const redeem = buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: crossFee, feePrivKeyHex: FEE_KEY });
  const redeemStacks = witnessStacks(redeem.hex);
  assert.equal(Buffer.from(redeemStacks[3][1]).toString('hex'), feePubkey, 'redeem fee leg carries the fee key');
  assert.deepEqual(redeemStacks[1].map((i) => i.length), [64], 'burn legs untouched');
  assert.ok(redeem.hex.includes(MARKED_CHANGE_SCRIPT), 'DGB change still goes where the caller said');

  const transfer = buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: crossFee, feePrivKeyHex: FEE_KEY });
  const transferStacks = witnessStacks(transfer.hex);
  assert.equal(Buffer.from(transferStacks[1][1]).toString('hex'), feePubkey, 'transfer fee leg carries the fee key');
  assert.deepEqual(transferStacks[0].map((i) => i.length), [64], 'DD token leg untouched');
  assert.ok(transfer.hex.includes(MARKED_CHANGE_SCRIPT));
});

test('a borrowed fee key never becomes the default DGB change destination', async () => {
  // Deliberate divergence from the fork this mechanism came from, which moved
  // the default change script to the fee key: the DGB change belongs to the
  // DigiDollar owner, and lending the fee leg must not redirect it.
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { ripemd160 } = await import('@noble/hashes/legacy.js');
  const p2wpkhOf = (k) => '0014' + Buffer.from(
    ripemd160(sha256(secp256k1.getPublicKey(Buffer.from(k, 'hex'), true))),
  ).toString('hex');
  const args = { ...TRANSFER_ARGS, dgbChangeScriptHex: undefined }; // let the default speak
  const { hex } = buildSignedTransferTx({ ...args, feeUtxo: FEE_COIN, feePrivKeyHex: FEE_KEY });
  assert.ok(hex.includes(p2wpkhOf(TEST_KEY)), 'change stays on the sender key');
  assert.ok(!hex.includes(p2wpkhOf(FEE_KEY)), 'change does not follow the fee key');
});

test('the heavier P2WPKH leg stays inside the weight budget and the DD fee floor', () => {
  // The weight model budgets 272 wu for a witness-v0 input against 230 for a
  // key-path P2TR one — restated here so the pin does not lean on the
  // implementation (derivation: spend.test.js). The real growth is 40–42 wu
  // because the DER signature is 70–72 bytes and the model budgets the maximum.
  // For a DigiDollar transaction the flat 0.1 DGB floor absorbs it outright:
  // priced per-vbyte at the relay rate these transactions cost under a
  // hundredth of the floor, so no DD builder needs a fee bump for the v0 leg.
  const P2TR_INPUT_WU = 230n;
  const P2WPKH_INPUT_WU = 272n;
  const budget = P2WPKH_INPUT_WU - P2TR_INPUT_WU;
  for (const [label, build] of [
    ['transfer', (type) => buildSignedTransferTx({ ...TRANSFER_ARGS, feeUtxo: { ...FEE_COIN, type } })],
    ['redeem', (type) => buildSignedRedeemTx({ ...REDEEM_ARGS, feeUtxo: { ...FEE_COIN, type } })],
  ]) {
    const heavy = txWeight(build('p2wpkh').hex);
    const grew = heavy - txWeight(build(undefined).hex);
    assert.ok(grew > 0n && grew <= budget, `${label}: leg grew ${grew} wu, budget ${budget} wu`);
    const vsize = (heavy + 3n) / 4n; // Core's GetVirtualTransactionSize
    const relayMin = (vsize * STANDARD_FEE_RATE_SATS_PER_KVB + 999n) / 1000n;
    assert.ok(relayMin * 100n < MIN_DD_TX_FEE_SATS, `${label}: relay minimum ${relayMin} vs floor ${MIN_DD_TX_FEE_SATS}`);
  }
});
