// Offline differential tests for transfer tx assembly against a real Core-built
// transfer (test/fixtures/transfer-tx.json, txid 9b3069da…): a $30 send with
// $70 DD change, built by senddigidollar on the regtest stand.
// The owner key comes from the mint fixture's OP_RETURN (the DD input being
// spent is the mint's DD token output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransferOutputs, buildRedeemOutputs, serializeTx, ddTokenOutputKey, buildSignedTransferTx, buildSignedRedeemTx, buildSignedMintTx, LOCK_TIERS } from 'digidollar-js';

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
