// End-to-end differential gate for witness-v0 spends (issue #38): mint change
// is P2WPKH by consensus, so the wallet must spend v0 coins. A mixed spend —
// one key-path P2TR input + one P2WPKH input of a DIFFERENT key — built and
// signed fully client-side must be accepted and mined by a real Core regtest
// node, which also acts as the oracle for the address→script mapping and the
// planSpend fee floor.
//
// Requires a running regtest stand and env:
//   DD_E2E_RPC=http://user:pass@127.0.0.1:18500
// Skipped otherwise, so `npm test` stays fast and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSpend,
  buildSignedSpendTx,
  scriptPubKeyFromAddress,
  decodeWitnessAddress,
  xOnlyPubKey,
  encodeWitnessAddress,
  ddTokenOutputKey,
  p2wpkhAddress,
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
const p2trAddress = (privKeyHex) => encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(xOnlyPubKey(privKeyHex)));

/** Send DGB from the stand wallet to `address` and mine it. */
async function fund(address, amountDgb, minerAddr) {
  const txid = await rpc('sendtoaddress', [address, amountDgb], 'stand');
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.address === address);
  assert.notEqual(vout, -1, 'funding output not found');
  return { txidHex: txid, vout, valueSats: sats(tx.vout[vout].value), scriptHex: tx.vout[vout].scriptPubKey.hex };
}

test('JS v0 spend: P2TR + P2WPKH inputs of different keys spent together, node-verified', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const keyA = '71'.repeat(32); // p2tr owner
  const keyB = '72'.repeat(32); // p2wpkh owner (plays the mint-change key)
  const recipientKey = '73'.repeat(32);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  // The node is the oracle for the address→script mapping: funding the v0
  // address must produce a 0014<hash160> scriptPubKey whose program is what
  // our address encoder claims.
  const v0Address = p2wpkhAddress(keyB, 'dgbrt');
  const utxoTr = { ...(await fund(p2trAddress(keyA), 5, minerAddr)), privKeyHex: keyA };
  const utxoV0 = { ...(await fund(v0Address, 3, minerAddr)), privKeyHex: keyB, type: 'p2wpkh' };
  assert.equal(utxoV0.scriptHex, '0014' + decodeWitnessAddress(v0Address).programHex,
    'node maps the p2wpkh address to OP_0 <hash160>');

  const recipientAddress = p2trAddress(recipientKey);
  const amountSats = 7_50_000_000n; // 7.5 DGB — forces BOTH inputs in
  const plan = planSpend({ utxos: [utxoTr, utxoV0], amountSats });
  assert.equal(plan.inputs.length, 2);

  const { hex, changeSats } = buildSignedSpendTx({
    utxos: plan.inputs,
    recipientScriptHex: scriptPubKeyFromAddress(recipientAddress),
    amountSats,
    changeScriptHex: scriptPubKeyFromAddress(p2trAddress(keyA)),
    feeSats: plan.feeSats,
  });

  // Node acceptance is the differential check for BOTH the BIP-143 signature
  // and the planSpend fee floor (min relay fee) on the mixed-weight tx.
  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const mined = await rpc('getrawtransaction', [txid, true]);
  assert.ok(mined.confirmations >= 1);

  assert.equal(mined.version, 2);
  assert.equal(mined.vout[0].scriptPubKey.address, recipientAddress);
  assert.equal(sats(mined.vout[0].value), amountSats);
  assert.equal(sats(mined.vout[1].value), changeSats);
  // the v0 input's witness is [DER sig, pubkey] — 2 items, unlike taproot's 1
  const v0Vin = mined.vin.find((v) => v.txid === utxoV0.txidHex);
  assert.equal(v0Vin.txinwitness.length, 2);
  console.log(`  v0 spend: ${txid} fee=${plan.feeSats} change=${changeSats}`);
});
