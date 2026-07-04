// End-to-end differential gate for Redemption (issue #12): a fully client-side
// -built and -signed redemption — script-path spend of the collateral via the
// Normal tapscript leaf (expired CLTV + owner signature; NO oracle signatures,
// per the discovery findings) — must be accepted by a real Core regtest node.
//
// Covers: active-lock rejection, expired-lock exact-burn redemption (collateral
// returned to the user key), and a redemption with DD change (type-3 OP_RETURN).
//
// Requires a running regtest stand (scripts/regtest-stand.sh --keep) and env:
//   DD_E2E_RPC=http://user:pass@127.0.0.1:18500
// Skipped otherwise, so `npm test` stays fast and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedMintTx,
  buildSignedRedeemTx,
  parseRedeemMetadata,
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
  await rpc('setmockoracleprice', [13_420]);
  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, minerAddr], 'stand');
  const mined = await rpc('getrawtransaction', [txid, true]);
  assert.ok(mined.confirmations >= 1); // >=1: parallel test files may mine extra blocks
  return mined;
}

/** JS-mint at the 1hour tier and return the position's redeem inputs. */
async function mintPosition(privKeyHex, ddCents, fundDgb, minerAddr) {
  await rpc('setmockoracleprice', [13_420]);
  const funding = await fundOwner(xOnlyPubKey(privKeyHex), fundDgb, minerAddr);
  const tipHeight = await rpc('getblockcount');
  const { hex, collateralSats, unlockHeight } = buildSignedMintTx({
    utxo: funding,
    privKeyHex,
    ddCents,
    tierId: '1hour', // 240 blocks — the fast path to an expired lock on regtest
    oraclePriceMicroUsd: 13_420n,
    tipHeight,
  });
  const mined = await broadcastAndMine(hex, minerAddr);
  return {
    collateralUtxo: { txidHex: mined.txid, vout: 0, valueSats: collateralSats, lockHeight: unlockHeight, ddCents },
    ddUtxo: { txidHex: mined.txid, vout: 1, ddCents },
    unlockHeight,
  };
}

test('JS redemption: active lock rejected, expired lock returns the collateral', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const ownerKey = 'f6'.repeat(32);
  const owner = xOnlyPubKey(ownerKey);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  const pos = await mintPosition(ownerKey, 10_000n, 100_000, minerAddr); // $100
  const feeUtxo = await fundOwner(owner, 10, minerAddr);

  const { hex, ddChangeCents } = buildSignedRedeemTx({
    collateralUtxo: pos.collateralUtxo,
    ddUtxos: [pos.ddUtxo],
    feeUtxo,
    privKeyHex: ownerKey,
  });
  assert.equal(ddChangeCents, 0n);

  // Active lock: nLockTime = unlockHeight is in the future — Core must refuse.
  await rpc('setmockoracleprice', [13_420]);
  await assert.rejects(() => rpc('sendrawtransaction', [hex]), /non-final|timelock/i);

  // Mature the lock (240-block tier + 100-block buffer) and redeem.
  const tip = await rpc('getblockcount');
  await rpc('generatetoaddress', [pos.unlockHeight - tip, minerAddr], 'stand');
  const mined = await broadcastAndMine(hex, minerAddr);

  assert.equal(mined.version >>> 0, 0x03000770); // DD redeem marker
  assert.equal(mined.locktime, pos.unlockHeight);
  // Round-trip: the full collateral came back to the user's own key-path P2TR.
  assert.equal(sats(mined.vout[0].value), pos.collateralUtxo.valueSats);
  assert.equal(mined.vout[0].scriptPubKey.hex.slice(4), ddTokenOutputKey(owner));
  // Exact burn: no DD outputs, no OP_RETURN.
  assert.equal(mined.vout.some((o) => o.scriptPubKey.type === 'nulldata'), false);

  console.log(`  redeemed: ${mined.txid} | collateral ${pos.collateralUtxo.valueSats} sats back at height >= ${pos.unlockHeight}`);
});

test('JS redemption with DD change carries the type-3 OP_RETURN', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const ownerKey = 'e7'.repeat(32);
  const owner = xOnlyPubKey(ownerKey);
  const minerAddr = await rpc('getnewaddress', [], 'stand');

  // Two positions minted back-to-back: redeem B ($50) burning B's and C's DD
  // ($50 + $30) — $30 comes back as DD change.
  const posB = await mintPosition(ownerKey, 5_000n, 50_000, minerAddr);
  const posC = await mintPosition(ownerKey, 3_000n, 30_000, minerAddr);
  const feeUtxo = await fundOwner(owner, 10, minerAddr);

  const tip = await rpc('getblockcount');
  await rpc('generatetoaddress', [posB.unlockHeight - tip, minerAddr], 'stand');

  const { hex, ddChangeCents } = buildSignedRedeemTx({
    collateralUtxo: posB.collateralUtxo,
    ddUtxos: [posB.ddUtxo, posC.ddUtxo],
    feeUtxo,
    privKeyHex: ownerKey,
  });
  assert.equal(ddChangeCents, 3_000n);
  const mined = await broadcastAndMine(hex, minerAddr);

  assert.equal(sats(mined.vout[0].value), posB.collateralUtxo.valueSats);
  assert.equal(mined.vout[1].scriptPubKey.hex.slice(4), ddTokenOutputKey(owner)); // DD change
  const meta = mined.vout.find((o) => o.scriptPubKey.type === 'nulldata');
  assert.deepEqual(parseRedeemMetadata(meta.scriptPubKey.hex), { ddChangeCents: 3_000n });
});
