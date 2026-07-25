// Verify #118's dust-fold tx shapes against real Core consensus.
//
// The fold produces three transaction layouts this repo had never broadcast:
//   * 3-output MINT ending in OP_RETURN (vout[3] change dropped)
//   * 3-output TRANSFER (recipient + DD change + OP_RETURN, DGB change folded)
//   * 1-output REDEEM (collateral return only — DD and DGB change both absent)
// Each is built with the shipped digidollar-js builders and submitted to a live
// regtest node via testmempoolaccept, so the pass/fail is Core's opinion, not ours.
//
// Setup — the stand must be FRESH for every run:
//   DGB_BIN=<DigiByte-Qt or digibyted> ./scripts/regtest-stand.sh --keep
//   node apps/wallet/scripts/verify-fold-shapes.mjs
//
// Both owner keys here are constants, so a second run against the same node
// re-mints to a DD token scriptPubKey the chain has already seen and Core
// answers "dd-input-amounts-unknown" on the transfer and redeem. That is the
// driver colliding with itself, not a consensus failure — stop the node and
// re-run scripts/regtest-stand.sh before each run.
//
// The macOS release ships DigiByte-Qt only; it embeds the full node and takes
// the same flags, so DGB_BIN can point straight at
// DigiByte-Qt.app/Contents/MacOS/DigiByte-Qt.
import {
  buildSignedMintTx, buildSignedTransferTx, buildSignedRedeemTx,
  requiredCollateralSats, xOnlyPubKey, ddTokenOutputKey, encodeWitnessAddress,
} from 'digidollar-js';

const RPC = 'http://127.0.0.1:18500';
const WALLET = 'stand';
const HRP = 'dgbrt';
const PRICE = 13_420n;      // matches regtest-stand.sh's mock oracle
const DD_CENTS = 10_000n;   // $100 — the consensus minimum mint
const TIER = '1hour';       // 240-block lock: the only tier a regtest can wait out

let failures = 0;
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

async function rpc(method, params = [], wallet) {
  const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('dd:ddpass').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'fold', method, params }),
  });
  const json = JSON.parse(await res.text());
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

// Deterministic owner keys — A mints/redeems, B only receives a transfer.
const PRIV_A = '11'.repeat(32);
const PRIV_B = '22'.repeat(32);
const ownerA = xOnlyPubKey(PRIV_A);
const ownerB = xOnlyPubKey(PRIV_B);
const addrA = encodeWitnessAddress(HRP, 1, ddTokenOutputKey(ownerA));

const miner = await rpc('getnewaddress', [], WALLET);

/** Fund addrA with an exact sat amount; returns the {txidHex, vout, valueSats} it created. */
async function fund(valueSats) {
  const dgb = (Number(valueSats) / 1e8).toFixed(8);
  const txid = await rpc('sendtoaddress', [addrA, dgb], WALLET);
  await rpc('generatetoaddress', [1, miner], WALLET);
  const raw = await rpc('getrawtransaction', [txid, true]);
  const vout = raw.vout.findIndex((o) => o.scriptPubKey?.address === addrA);
  if (vout < 0) throw new Error('funding output not found');
  return { txidHex: txid, vout, valueSats };
}

/** Ask Core whether it would accept the tx, then mine it in. */
async function accept(label, hex, expectedVouts) {
  const [verdict] = await rpc('testmempoolaccept', [[hex]]);
  ok(`${label} accepted by Core consensus`, verdict.allowed === true, verdict['reject-reason'] || '');
  if (!verdict.allowed) return null;
  const decoded = await rpc('decoderawtransaction', [hex]);
  const types = decoded.vout.map((o) => o.scriptPubKey.type);
  ok(`${label} has exactly ${expectedVouts} output(s)`, decoded.vout.length === expectedVouts,
     `got ${decoded.vout.length}: [${types.join(', ')}]`);
  const txid = await rpc('sendrawtransaction', [hex]);
  await rpc('generatetoaddress', [1, miner], WALLET);
  return { txid, decoded, types };
}

// ---- 1. MINT with change folded → 3 outputs, last one OP_RETURN ----------
const collateral = requiredCollateralSats({ ddCents: DD_CENTS, tierId: TIER, oraclePriceMicroUsd: PRICE });
const MINT_FEE = 12_000_000n;
console.log(`\n— mint: $100 @ ${TIER}, collateral ${collateral} sats`);

// Fund with a DUST remainder (50k sats, under the 100k fold threshold) so the
// fold is what drops vout[3]. Funding exactly would leave changeSats at 0 on its
// own and the test would pass with the fold removed.
const utxo1 = await fund(collateral + MINT_FEE + 50_000n);
let tip = await rpc('getblockcount', []);
const mint1 = buildSignedMintTx({
  utxo: utxo1, privKeyHex: PRIV_A, ddCents: DD_CENTS, tierId: TIER,
  oraclePriceMicroUsd: PRICE, tipHeight: tip, feeSats: MINT_FEE,
});
ok('mint folded its change (changeSats === 0)', mint1.changeSats === 0n, `changeSats=${mint1.changeSats}`);
const mintRes1 = await accept('3-output mint', mint1.hex, 3);
if (mintRes1) {
  ok('mint\'s last output is the OP_RETURN metadata',
     mintRes1.types.at(-1) === 'nulldata', `last=${mintRes1.types.at(-1)}`);
}

// ---- 2. TRANSFER with DGB change folded → 3 outputs ----------------------
console.log('\n— transfer: $40 of the $100 token to B, DGB change folded');
const TRANSFER_FEE = 12_000_000n;
// fee coin worth just under fee+fold-threshold, so the 50k-sat remainder folds
const feeUtxo1 = await fund(TRANSFER_FEE + 50_000n);
const transfer = buildSignedTransferTx({
  ddUtxo: { txidHex: mintRes1.txid, vout: 1, ddCents: DD_CENTS },
  feeUtxo: feeUtxo1,
  privKeyHex: PRIV_A,
  recipients: [{ outputKeyHex: ddTokenOutputKey(ownerB), cents: 4_000n }],
  feeSats: TRANSFER_FEE,
});
ok('transfer folded its DGB change', transfer.dgbChangeSats === 0n, `dgbChange=${transfer.dgbChangeSats}`);
await accept('3-output transfer', transfer.hex, 3);

// ---- 3. REDEEM with both changes absent → 1 output -----------------------
console.log('\n— redeem: full burn of a second position, DD and DGB change both absent');
const utxo2 = await fund(collateral + MINT_FEE + 50_000n);
tip = await rpc('getblockcount', []);
const mint2 = buildSignedMintTx({
  utxo: utxo2, privKeyHex: PRIV_A, ddCents: DD_CENTS, tierId: TIER,
  oraclePriceMicroUsd: PRICE, tipHeight: tip, feeSats: MINT_FEE,
});
const mintRes2 = await accept('second mint (redeem fixture)', mint2.hex, 3);

const REDEEM_FEE = 16_000_000n;
const feeUtxo2 = await fund(REDEEM_FEE + 50_000n);

// Wait out the 1-hour tier: 240 lock blocks + the 100-block confirmation buffer.
console.log(`  mining past unlock height ${mint2.unlockHeight}…`);
const need = mint2.unlockHeight - (await rpc('getblockcount', []));
if (need > 0) await rpc('generatetoaddress', [need, miner], WALLET);

const redeem = buildSignedRedeemTx({
  collateralUtxo: {
    txidHex: mintRes2.txid, vout: 0, valueSats: mint2.collateralSats,
    lockHeight: mint2.unlockHeight, ddCents: DD_CENTS,
  },
  ddUtxos: [{ txidHex: mintRes2.txid, vout: 1, ddCents: DD_CENTS }],
  feeUtxo: feeUtxo2,
  privKeyHex: PRIV_A,
  feeSats: REDEEM_FEE,
});
ok('redeem has no DD change (full burn)', redeem.ddChangeCents === 0n, `ddChange=${redeem.ddChangeCents}`);
ok('redeem folded its DGB change', redeem.dgbChangeSats === 0n, `dgbChange=${redeem.dgbChangeSats}`);
const redeemRes = await accept('1-output redeem', redeem.hex, 1);
if (redeemRes) {
  ok('redeem\'s single output is the collateral return (nValue > 0)',
     redeemRes.decoded.vout[0].value > 0, `value=${redeemRes.decoded.vout[0].value}`);
}

console.log(failures === 0 ? '\nall green' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
