// Standard (non-DD) DGB spend: coin selection + fee planning, then full
// client-side assembly/signing (issue #6). Expected fee values are hand-computed
// from BIP-141 weights — NOT from the implementation:
//   overhead: 10 vB ·4 = 40 wu + 2 wu (marker/flag) = 42 wu
//   key-path P2TR input: 41 vB ·4 = 164 wu + 66 wu witness (1+1+64) = 230 wu
//   P2TR output (8+1+34 = 43 vB): 172 wu
//   fee = ceil(weight · rate / 4000), rate = 100_000 sats/kvB (DGB relay fee 0.001/kvB)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planSpend, buildSignedSpendTx, serializeTx, scriptPubKeyFromAddress, xOnlyPubKey, ddTokenOutputKey } from 'digidollar-js';

// Minimal independent segwit-tx parser (test-only, so assertions about the
// produced hex do not lean on the library's own serializer).
function parseTx(hex) {
  const buf = Buffer.from(hex, 'hex');
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return v; };
  const varint = () => { const v = buf[o]; assert.ok(v < 0xfd, 'compact varint only'); o += 1; return v; };
  const take = (n) => { const v = buf.subarray(o, o + n); o += n; return v; };
  const version = u32();
  assert.deepEqual([...take(2)], [0x00, 0x01], 'segwit marker+flag');
  const vin = Array.from({ length: varint() }, () => ({
    txidHex: Buffer.from(take(32)).reverse().toString('hex'),
    vout: u32(),
    scriptLen: varint(),
    sequence: u32(),
  }));
  const vout = Array.from({ length: varint() }, () => ({
    valueSats: u64(),
    scriptHex: take(varint()).toString('hex'),
  }));
  const witnesses = vin.map(() => Array.from({ length: varint() }, () => take(varint()).toString('hex')));
  const locktime = u32();
  assert.equal(o, buf.length, 'trailing bytes');
  return { version, vin, vout, witnesses, locktime };
}

const utxo = (valueSats, i = 0) => ({ txidHex: 'ab'.repeat(32), vout: i, valueSats });

test('planSpend picks a single large UTXO and computes the 1-in-2-out fee', () => {
  // 42 + 230 + 2·172 = 616 wu → 616·100000/4000 = 15_400 sats
  const plan = planSpend({
    utxos: [utxo(3_000_000n, 1), utxo(5_000_000n, 2), utxo(1_000_000n, 3)],
    amountSats: 4_000_000n,
  });
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.inputs[0].valueSats, 5_000_000n);
  assert.equal(plan.feeSats, 15_400n);
  assert.equal(plan.changeSats, 5_000_000n - 4_000_000n - 15_400n);
});

test('planSpend accumulates UTXOs largest-first and re-prices the fee per input', () => {
  // 2 inputs: 42 + 2·230 + 2·172 = 846 wu → vsize ceil(846/4)=212 vB → 21_200 sats.
  // Core rounds weight→vsize BEFORE pricing (GetVirtualTransactionSize); the
  // regtest node rejected 21_150 with "min relay fee not met, 21150 < 21200".
  const plan = planSpend({
    utxos: [utxo(3_000_000n, 1), utxo(5_000_000n, 2), utxo(1_000_000n, 3)],
    amountSats: 7_000_000n,
  });
  assert.deepEqual(plan.inputs.map((u) => u.valueSats), [5_000_000n, 3_000_000n]);
  assert.equal(plan.feeSats, 21_200n);
  assert.equal(plan.changeSats, 8_000_000n - 7_000_000n - 21_200n);
});

test('buildSignedSpendTx assembles a plain v2 spend across two addresses', () => {
  // Two inputs owned by DIFFERENT derivation keys (multi-address wallet),
  // paying a third key's P2TR address, change back to the first key.
  const keyA = '11'.repeat(32);
  const keyB = '22'.repeat(32);
  const recipientScriptHex = '5120' + ddTokenOutputKey(xOnlyPubKey('33'.repeat(32)));
  const changeScriptHex = '5120' + ddTokenOutputKey(xOnlyPubKey(keyA));

  const { hex, changeSats } = buildSignedSpendTx({
    utxos: [
      { txidHex: 'aa'.repeat(32), vout: 1, valueSats: 5_000_000n, privKeyHex: keyA },
      { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 3_000_000n, privKeyHex: keyB },
    ],
    recipientScriptHex,
    amountSats: 7_000_000n,
    changeScriptHex,
    feeSats: 21_200n,
  });
  assert.equal(changeSats, 8_000_000n - 7_000_000n - 21_200n);

  const tx = parseTx(hex);
  assert.equal(tx.version, 2); // standard spend — NOT a DD-marked version
  assert.equal(tx.locktime, 0);
  assert.deepEqual(tx.vin.map((v) => [v.txidHex, v.vout]),
    [['aa'.repeat(32), 1], ['bb'.repeat(32), 0]]);
  assert.deepEqual(tx.vout, [
    { valueSats: 7_000_000n, scriptHex: recipientScriptHex },
    { valueSats: changeSats, scriptHex: changeScriptHex },
  ]);
  // key-path taproot spends: exactly one 64-byte Schnorr signature per input
  for (const w of tx.witnesses) {
    assert.equal(w.length, 1);
    assert.equal(w[0].length, 128);
  }
});

test('buildSignedSpendTx folds sub-0.001-DGB change into the fee (no dust output)', () => {
  const keyA = '11'.repeat(32);
  const { hex, changeSats } = buildSignedSpendTx({
    utxos: [{ txidHex: 'aa'.repeat(32), vout: 0, valueSats: 1_000_000n, privKeyHex: keyA }],
    recipientScriptHex: '5120' + ddTokenOutputKey(xOnlyPubKey('33'.repeat(32))),
    amountSats: 980_000n,
    changeScriptHex: '5120' + ddTokenOutputKey(xOnlyPubKey(keyA)),
    feeSats: 15_400n, // leaves 4_600 sats — dust-risk, must not become an output
  });
  assert.equal(changeSats, 0n);
  assert.equal(parseTx(hex).vout.length, 1);
});

test('planSpend throws when the balance cannot cover amount + fee', () => {
  assert.throws(
    () => planSpend({ utxos: [utxo(1_000_000n)], amountSats: 995_000n }),
    /insufficient funds/,
  );
});

// DGB fee change on transfers/redeems defaults to Core's P2WPKH convention,
// but the wallet needs it on a WATCHED address (its P2TR) — the builders
// accept an explicit change script for that (#16).
test('transfer and redeem route DGB change to an explicit script when given', async () => {
  const { buildSignedTransferTx, buildSignedRedeemTx } = await import('digidollar-js');
  const key = '11'.repeat(32);
  const changeScriptHex = '5120' + ddTokenOutputKey(xOnlyPubKey(key)); // owner's own P2TR
  const transfer = buildSignedTransferTx({
    ddUtxo: { txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n },
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
    privKeyHex: key,
    recipients: [{ outputKeyHex: ddTokenOutputKey(xOnlyPubKey('22'.repeat(32))), cents: 2_000n }],
    dgbChangeScriptHex: changeScriptHex,
  });
  // vout: recipient DD, DD change, DGB change, OP_RETURN — DGB change is index 2
  const tOut = parseTx(transfer.hex).vout[2];
  assert.equal(tOut.scriptHex, changeScriptHex);
  assert.equal(tOut.valueSats, transfer.dgbChangeSats);

  const redeem = buildSignedRedeemTx({
    collateralUtxo: { txidHex: 'cc'.repeat(32), vout: 0, valueSats: 500_000_000n, lockHeight: 1000, ddCents: 5_000n },
    ddUtxos: [{ txidHex: 'aa'.repeat(32), vout: 1, ddCents: 5_000n }],
    feeUtxo: { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 100_000_000n },
    privKeyHex: key,
    feeSats: 12_000_000n,
    dgbChangeScriptHex: changeScriptHex,
  });
  // exact burn: vout = [collateral return, DGB change]
  const rOut = parseTx(redeem.hex).vout[1];
  assert.equal(rOut.scriptHex, changeScriptHex);
  assert.equal(rOut.valueSats, redeem.dgbChangeSats);
});

// ---- Known-good fixture (test/fixtures/spend-tx.json, txid 496dda24…) ----
// A 2-DGB spend with change, built by this library, ACCEPTED AND MINED by the
// Core v9.26.4 regtest node — the node's decoded view is the reference.

test('reserializes the Core-mined spend byte-for-byte (fixture witnesses substituted)', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/spend-tx.json', import.meta.url), 'utf8'),
  ).result;
  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
  const hex = serializeTx({
    version: fixture.version,
    locktime: fixture.locktime,
    inputs: fixture.vin.map((v) => ({ txidHex: v.txid, vout: v.vout, sequence: v.sequence })),
    // outputs rebuilt from the node's ADDRESSES + values, not its script hexes
    outputs: fixture.vout.map((v) => ({
      valueSats: BigInt(Math.round(v.value * 1e8)),
      script: hexToBytes(scriptPubKeyFromAddress(v.scriptPubKey.address)),
    })),
    witnesses: fixture.vin.map((v) => v.txinwitness.map(hexToBytes)),
  });
  assert.equal(hex, fixture.hex);
  assert.equal(fixture.version, 2);
});
