// End-to-end differential gate for standard DGB spends (issue #6): a plain v2
// P2TR key-path spend built and signed fully client-side must be accepted by a
// real Core regtest node — multi-input, cross-key, with change.
//
// Requires a running regtest stand (scripts/regtest-stand.sh --keep) and env:
//   DD_E2E_RPC=http://user:pass@127.0.0.1:18500
// Skipped otherwise, so `npm test` stays fast and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSpend,
  buildSignedSpendTx,
  scriptPubKeyFromAddress,
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
const p2trAddress = (privKeyHex) => encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(xOnlyPubKey(privKeyHex)));

/** Send DGB from the stand wallet to this key's P2TR address and mine it. */
async function fundKey(privKeyHex, amountDgb, minerAddr) {
  const address = p2trAddress(privKeyHex);
  const txid = await rpc('sendtoaddress', [address, amountDgb], 'stand');
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const tx = await rpc('getrawtransaction', [txid, true]);
  const vout = tx.vout.findIndex((o) => o.scriptPubKey.address === address);
  assert.notEqual(vout, -1, 'funding output not found');
  return { txidHex: txid, vout, valueSats: sats(tx.vout[vout].value), privKeyHex };
}

test('JS standard spend: two inputs from different keys, paid to a third, change back', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const keyA = '61'.repeat(32);
  const keyB = '62'.repeat(32);
  const recipientKey = '63'.repeat(32);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  // Two wallet UTXOs under different derivation keys (multi-address wallet).
  const utxoA = await fundKey(keyA, 5, minerAddr);
  const utxoB = await fundKey(keyB, 3, minerAddr);

  const recipientAddress = p2trAddress(recipientKey);
  const amountSats = 6_00_000_000n; // 6 DGB — forces both inputs in
  const plan = planSpend({ utxos: [utxoA, utxoB], amountSats });
  assert.equal(plan.inputs.length, 2);

  const { hex, changeSats } = buildSignedSpendTx({
    utxos: plan.inputs,
    recipientScriptHex: scriptPubKeyFromAddress(recipientAddress),
    amountSats,
    changeScriptHex: scriptPubKeyFromAddress(p2trAddress(keyA)),
    feeSats: plan.feeSats,
  });

  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const mined = await rpc('getrawtransaction', [txid, true]);
  assert.ok(mined.confirmations >= 1);

  assert.equal(mined.version, 2);
  assert.equal(mined.vout[0].scriptPubKey.address, recipientAddress);
  assert.equal(sats(mined.vout[0].value), amountSats);
  assert.equal(sats(mined.vout[1].value), changeSats);
  console.log(`  spend: ${txid} fee=${plan.feeSats} change=${changeSats}`);
});
