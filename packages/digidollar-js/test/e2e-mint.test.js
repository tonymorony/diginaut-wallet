// End-to-end differential gate (ADR-0001): a fully client-side-built and
// -signed mint transaction must be accepted by a real DigiByte Core regtest
// node and mined into a block.
//
// Requires a running regtest stand (scripts/regtest-stand.sh --keep) and env:
//   DD_E2E_RPC=http://user:pass@127.0.0.1:18500
// Skipped otherwise, so `npm test` stays fast and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedMintTx, xOnlyPubKey, encodeWitnessAddress, ddTokenOutputKey } from 'digidollar-js';

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

test('JS-built mint is accepted by Core and mined (differential gate)', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const privKeyHex = '7'.repeat(64); // deterministic harness key
  const ownerKey = xOnlyPubKey(privKeyHex);
  const fundingAddress = encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(ownerKey));

  // Differential check: the node must agree our bech32m address is valid.
  const check = await rpc('validateaddress', [fundingAddress]);
  assert.equal(check.isvalid, true);

  await rpc('setmockoracleprice', [13_420]); // keep the oracle quote fresh

  // Fund the JS-controlled key and confirm it.
  const fundTxid = await rpc('sendtoaddress', [fundingAddress, 50_000], 'stand');
  const minerAddr = await rpc('getnewaddress', [], 'stand');
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const fundTx = await rpc('getrawtransaction', [fundTxid, true]);
  const voutIndex = fundTx.vout.findIndex((o) => o.scriptPubKey.address === fundingAddress);
  assert.notEqual(voutIndex, -1, 'funding output not found');
  const valueSats = BigInt(Math.round(fundTx.vout[voutIndex].value * 1e8));

  // Build + sign the mint entirely client-side.
  const price = await rpc('getoracleprice');
  const tipHeight = await rpc('getblockcount');
  const { hex, collateralSats, unlockHeight } = buildSignedMintTx({
    utxo: { txidHex: fundTxid, vout: voutIndex, valueSats },
    privKeyHex,
    ddCents: 10_000n, // $100
    tierId: '6months',
    oraclePriceMicroUsd: BigInt(price.price_micro_usd),
    tipHeight,
  });

  // THE gate: Core's mempool validation accepts the client-built transaction…
  const mintTxid = await rpc('sendrawtransaction', [hex]);
  assert.match(mintTxid, /^[0-9a-f]{64}$/);

  // …and it gets mined.
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const mined = await rpc('getrawtransaction', [mintTxid, true]);
  assert.equal(mined.confirmations, 1);
  assert.equal(mined.version >>> 0, 0x01000770); // DD mint marker
  assert.equal(BigInt(Math.round(mined.vout[0].value * 1e8)), collateralSats);

  console.log(`  minted: ${mintTxid} | collateral ${collateralSats} sats | unlock @ ${unlockHeight}`);
});

test('JS-built mints are accepted across all ten lock tiers', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const { LOCK_TIERS } = await import('digidollar-js');
  const privKeyHex = '8'.repeat(64);
  const ownerKey = xOnlyPubKey(privKeyHex);
  const fundingAddress = encodeWitnessAddress('dgbrt', 1, ddTokenOutputKey(ownerKey));
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  for (const tier of LOCK_TIERS) {
    await rpc('setmockoracleprice', [13_420]);
    const fundTxid = await rpc('sendtoaddress', [fundingAddress, 200_000], 'stand');
    await rpc('generatetoaddress', [1, minerAddr], 'stand');
    const fundTx = await rpc('getrawtransaction', [fundTxid, true]);
    const voutIndex = fundTx.vout.findIndex((o) => o.scriptPubKey.address === fundingAddress);
    const valueSats = BigInt(Math.round(fundTx.vout[voutIndex].value * 1e8));
    const tipHeight = await rpc('getblockcount');

    const { hex } = buildSignedMintTx({
      utxo: { txidHex: fundTxid, vout: voutIndex, valueSats },
      privKeyHex,
      ddCents: 10_000n,
      tierId: tier.id,
      oraclePriceMicroUsd: 13_420n,
      tipHeight,
    });
    const txid = await rpc('sendrawtransaction', [hex]);
    await rpc('generatetoaddress', [1, minerAddr], 'stand');
    const mined = await rpc('getrawtransaction', [txid, true]);
    assert.equal(mined.confirmations, 1, `tier ${tier.id} not mined`);
  }
});
