// End-to-end differential gate for Transfer (issue #11): fully client-side-built
// and -signed DigiDollar transfers must be accepted by a real Core regtest node,
// for BOTH a fresh (mint-created) DD output and a previously-transferred one —
// proving the recipient can spend what they received (round-trip).
//
// Requires a running regtest stand (scripts/regtest-stand.sh --keep) and env:
//   DD_E2E_RPC=http://user:pass@127.0.0.1:18500
// Skipped otherwise, so `npm test` stays fast and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedMintTx,
  buildSignedTransferTx,
  parseTransferMetadata,
  xOnlyPubKey,
  encodeWitnessAddress,
  ddTokenOutputKey,
} from 'digidollar-js';

const RPC_URL = process.env.DD_E2E_RPC;

async function rpc(method, params = [], wallet) {
  const url = new URL(RPC_URL);
  const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
  const target = `${url.origin}/${wallet ? `wallet/${wallet}` : ''}`;
  const res = await fetch(target, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const sats = (btc) => BigInt(Math.round(btc * 1e8));

/** Send DGB from the stand wallet to this owner key's P2TR address and mine it. */
async function fundOwner(ownerKey, amountDgb, minerAddr) {
  const address = encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(ownerKey));
  const txid = await rpc('sendtoaddress', [address, amountDgb], 'stand');
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.address === address);
  assert.notEqual(vout, -1, 'funding output not found');
  return { txidHex: txid, vout, valueSats: sats(tx.vout[vout].value) };
}

async function broadcastAndMine(hex, minerAddr) {
  await rpc('setmockoracleprice', [13_420]); // keep the oracle quote fresh (mempool policy)
  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const mined = await rpc('getrawtransaction', [txid, true]);
  assert.ok(mined.confirmations >= 1); // >=1: parallel test files may mine extra blocks
  return mined;
}

test('JS transfer round-trip: fresh mint output, then re-transfer by the recipient', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const senderKey = 'a1'.repeat(32);
  const recipientKey = 'b2'.repeat(32);
  const thirdKey = 'c3'.repeat(32);
  const senderOwner = xOnlyPubKey(senderKey);
  const recipientOwner = xOnlyPubKey(recipientKey);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  // --- Arrange: JS-mint $100 so the sender holds a fresh DD token output.
  await rpc('setmockoracleprice', [13_420]);
  const mintFunding = await fundOwner(senderOwner, 50_000, minerAddr);
  const tipHeight = await rpc('getblockcount');
  const { hex: mintHex } = buildSignedMintTx({
    utxo: mintFunding,
    privKeyHex: senderKey,
    ddCents: 10_000n, // $100
    tierId: '6months',
    oraclePriceMicroUsd: 13_420n,
    tipHeight,
  });
  const mint = await broadcastAndMine(mintHex, minerAddr);
  // vout[1] is the DD token output (value 0, key-path P2TR of the sender).

  // --- Act 1: transfer $30 of the FRESH mint output to the recipient.
  const senderFee = await fundOwner(senderOwner, 10, minerAddr);
  const { hex: t1Hex, ddChangeCents } = buildSignedTransferTx({
    ddUtxo: { txidHex: mint.txid, vout: 1, ddCents: 10_000n },
    feeUtxo: senderFee,
    privKeyHex: senderKey,
    recipients: [{ outputKeyHex: ddTokenOutputKey(recipientOwner), cents: 3_000n }],
  });
  const t1 = await broadcastAndMine(t1Hex, minerAddr);

  assert.equal(t1.version >>> 0, 0x02000770); // DD transfer marker
  assert.equal(ddChangeCents, 7_000n);
  assert.equal(t1.vout[0].scriptPubKey.hex.slice(4), ddTokenOutputKey(recipientOwner));
  assert.equal(sats(t1.vout[0].value), 0n);
  const t1Meta = t1.vout.find((o) => o.scriptPubKey.type === 'nulldata');
  assert.deepEqual(parseTransferMetadata(t1Meta.scriptPubKey.hex).amountsCents, [3_000n, 7_000n]);

  // --- Act 2: the recipient re-transfers $10 of the PREVIOUSLY-TRANSFERRED
  // output to a third key — proving received DD is spendable client-side.
  const recipientFee = await fundOwner(recipientOwner, 10, minerAddr);
  const { hex: t2Hex } = buildSignedTransferTx({
    ddUtxo: { txidHex: t1.txid, vout: 0, ddCents: 3_000n },
    feeUtxo: recipientFee,
    privKeyHex: recipientKey,
    recipients: [{ outputKeyHex: ddTokenOutputKey(xOnlyPubKey(thirdKey)), cents: 1_000n }],
  });
  const t2 = await broadcastAndMine(t2Hex, minerAddr);

  assert.equal(t2.version >>> 0, 0x02000770);
  assert.equal(t2.vout[0].scriptPubKey.hex.slice(4), ddTokenOutputKey(xOnlyPubKey(thirdKey)));
  const t2Meta = t2.vout.find((o) => o.scriptPubKey.type === 'nulldata');
  assert.deepEqual(parseTransferMetadata(t2Meta.scriptPubKey.hex).amountsCents, [1_000n, 2_000n]);

  console.log(`  transfer: ${t1.txid} | re-transfer: ${t2.txid}`);
});

test('JS transfer with no DD change (exact-amount send)', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const senderKey = 'd4'.repeat(32);
  const recipientKey = 'e5'.repeat(32);
  const senderOwner = xOnlyPubKey(senderKey);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  await rpc('setmockoracleprice', [13_420]);
  const mintFunding = await fundOwner(senderOwner, 100_000, minerAddr); // 1hour tier needs 1000% collateral
  const tipHeight = await rpc('getblockcount');
  const { hex: mintHex } = buildSignedMintTx({
    utxo: mintFunding,
    privKeyHex: senderKey,
    ddCents: 10_000n,
    tierId: '1hour',
    oraclePriceMicroUsd: 13_420n,
    tipHeight,
  });
  const mint = await broadcastAndMine(mintHex, minerAddr);

  // Send the entire $100 — no DD change output, single amount in OP_RETURN.
  const senderFee = await fundOwner(senderOwner, 10, minerAddr);
  const { hex, ddChangeCents } = buildSignedTransferTx({
    ddUtxo: { txidHex: mint.txid, vout: 1, ddCents: 10_000n },
    feeUtxo: senderFee,
    privKeyHex: senderKey,
    recipients: [{ outputKeyHex: ddTokenOutputKey(xOnlyPubKey(recipientKey)), cents: 10_000n }],
  });
  assert.equal(ddChangeCents, 0n);
  const mined = await broadcastAndMine(hex, minerAddr);
  const meta = mined.vout.find((o) => o.scriptPubKey.type === 'nulldata');
  assert.deepEqual(parseTransferMetadata(meta.scriptPubKey.hex).amountsCents, [10_000n]);
});
