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

// ---- witness-v0 inputs (#38): mint change is P2WPKH by consensus ----
// Hand-computed weights (BIP-141), NOT taken from the implementation:
//   p2wpkh input: 41 vB non-witness ·4 = 164 wu; witness ≤ 1 count + 1+72 sig
//   (max lowS DER 71 + 1 hashtype byte) + 1+33 pubkey = 108 wu → 272 wu budget.
//   (271 wu assumes a 71-byte sig — a coin-flip; budgeting the max never
//   under-pays, and the node rejects under-payment.)

test('planSpend prices a single p2wpkh input: 42 + 272 + 344 = 658 wu → 165 vB', () => {
  const plan = planSpend({
    utxos: [{ txidHex: 'ab'.repeat(32), vout: 0, valueSats: 5_000_000n, type: 'p2wpkh' }],
    amountSats: 4_000_000n,
  });
  assert.equal(plan.feeSats, 16_500n); // 165 vB · 100 sats/vB
  assert.equal(plan.changeSats, 5_000_000n - 4_000_000n - 16_500n);
});

test('planSpend prices mixed p2tr + p2wpkh inputs per type: 888 wu → 222 vB', () => {
  // 42 + 230 (p2tr) + 272 (p2wpkh) + 2·172 = 888 wu → ceil(888/4) = 222 vB → 22_200 sats
  const plan = planSpend({
    utxos: [
      { txidHex: 'ab'.repeat(32), vout: 1, valueSats: 5_000_000n }, // default p2tr
      { txidHex: 'ab'.repeat(32), vout: 2, valueSats: 3_000_000n, type: 'p2wpkh' },
    ],
    amountSats: 7_000_000n,
  });
  assert.equal(plan.inputs.length, 2);
  assert.equal(plan.feeSats, 22_200n);
  assert.equal(plan.changeSats, 8_000_000n - 7_000_000n - 22_200n);
});

test('buildSignedSpendTx signs a mixed p2tr + p2wpkh spend with a valid BIP-143 witness', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { ripemd160 } = await import('@noble/hashes/legacy.js');
  const keyA = '11'.repeat(32); // p2tr owner
  const keyB = '22'.repeat(32); // p2wpkh owner (mint-change key)
  const recipientScriptHex = '5120' + ddTokenOutputKey(xOnlyPubKey('33'.repeat(32)));
  const changeScriptHex = '5120' + ddTokenOutputKey(xOnlyPubKey(keyA));
  const utxos = [
    { txidHex: 'aa'.repeat(32), vout: 1, valueSats: 5_000_000n, privKeyHex: keyA },
    { txidHex: 'bb'.repeat(32), vout: 0, valueSats: 3_000_000n, privKeyHex: keyB, type: 'p2wpkh' },
  ];
  const { hex, changeSats } = buildSignedSpendTx({
    utxos,
    recipientScriptHex,
    amountSats: 7_000_000n,
    changeScriptHex,
    feeSats: 22_200n,
  });
  assert.equal(changeSats, 8_000_000n - 7_000_000n - 22_200n);

  const tx = parseTx(hex);
  assert.equal(tx.version, 2);
  // input 0 (p2tr): single 64-byte Schnorr sig; input 1 (p2wpkh): [DER sig|01, pubkey]
  assert.equal(tx.witnesses[0].length, 1);
  assert.equal(tx.witnesses[0][0].length, 128);
  const [sigHex, pkHex] = tx.witnesses[1];
  assert.equal(tx.witnesses[1].length, 2);
  const pubkey = secp256k1.getPublicKey(Buffer.from(keyB, 'hex'), true);
  assert.equal(pkHex, Buffer.from(pubkey).toString('hex'), 'compressed pubkey of the p2wpkh key');
  assert.equal(sigHex.slice(0, 2), '30', 'DER signature');
  assert.equal(sigHex.slice(-2), '01', 'SIGHASH_ALL hashtype byte');

  // Verify the ECDSA signature against a sighash computed HERE from the
  // BIP-143 spec text — independent of the library's signer.
  const h256 = (b) => sha256(sha256(b));
  const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const outpoint = (u) => Buffer.concat([Buffer.from(u.txidHex, 'hex').reverse(), le32(u.vout)]);
  const hash160 = ripemd160(sha256(pubkey));
  const scriptCode = Buffer.concat([Buffer.from([0x19, 0x76, 0xa9, 0x14]), hash160, Buffer.from([0x88, 0xac])]);
  const outputsSer = Buffer.concat(tx.vout.map((o) => Buffer.concat([
    le64(o.valueSats), Buffer.from([o.scriptHex.length / 2]), Buffer.from(o.scriptHex, 'hex'),
  ])));
  const preimage = Buffer.concat([
    le32(2), // nVersion
    h256(Buffer.concat(utxos.map(outpoint))), // hashPrevouts
    h256(Buffer.concat(tx.vin.map((v) => le32(v.sequence)))), // hashSequence
    outpoint(utxos[1]), scriptCode, le64(utxos[1].valueSats), le32(tx.vin[1].sequence),
    h256(outputsSer), // hashOutputs
    le32(0), // nLockTime
    le32(1), // SIGHASH_ALL
  ]);
  const sighash = h256(preimage);
  const ok = secp256k1.verify(
    Buffer.from(sigHex.slice(0, -2), 'hex'),
    sighash, pubkey, { prehash: false, format: 'der' },
  );
  assert.ok(ok, 'ECDSA signature verifies against the independently computed BIP-143 sighash');
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

// ---- Consensus DD transaction limits (public-testnet finding) ----
// Values transcribed from DigiByte v9.26.4 src/consensus/digidollar.h defaults
// (min $100 mint, max $100k, min $1 output) and src/kernel/chainparams.cpp
// regtest overrides (1 cent min, $1000 max). The live testnet26 node rejected
// a $1 mint with bad-dd-mint-amount — the wallet must know these BEFORE signing.
test('DD_TX_LIMITS mirror Core consensus params per network', async () => {
  const { DD_TX_LIMITS } = await import('digidollar-js');
  assert.deepEqual(DD_TX_LIMITS.mainnet, { minMintCents: 10_000n, maxMintCents: 10_000_000n, minOutputCents: 100n });
  assert.deepEqual(DD_TX_LIMITS.testnet, { minMintCents: 10_000n, maxMintCents: 10_000_000n, minOutputCents: 100n });
  assert.deepEqual(DD_TX_LIMITS.regtest, { minMintCents: 1n, maxMintCents: 100_000n, minOutputCents: 100n });
  for (const net of Object.values(DD_TX_LIMITS)) assert.ok(Object.isFrozen(net));
});
