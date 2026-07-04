// Offline differential tests for transfer tx assembly against a real Core-built
// transfer (test/fixtures/transfer-tx.json, txid 9b3069da…): a $30 send with
// $70 DD change, built by senddigidollar on the regtest stand.
// The owner key comes from the mint fixture's OP_RETURN (the DD input being
// spent is the mint's DD token output).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransferOutputs, buildRedeemOutputs, serializeTx, ddTokenOutputKey } from 'digidollar-js';

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
