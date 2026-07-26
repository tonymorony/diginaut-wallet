// Drive #13: DigiDollar positions in the wallet UI through the full real stack
// (regtest node + ElectrumX + indexer + wallet app). The driver restores a KNOWN
// mnemonic in the UI, mints $100 client-side against the wallet's first address,
// and asserts the UI renders the open position (amount, tier, collateral,
// expiry) distinctly from the DGB balance. Setup: same as verify-send.mjs.
import { writeFileSync } from 'node:fs';
import {
  mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS,
  buildSignedMintTx, scriptPubKeyFromAddress,
} from 'digidollar-js';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = new URL('.', import.meta.url).pathname;
const RPC = 'http://127.0.0.1:18500';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function nodeRpc(method, params = [], wallet) {
  const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('dd:ddpass').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'drv', method, params }),
  });
  const json = JSON.parse(await res.text());
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
const cdp = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await cdp('Page.enable', {}, sessionId);
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error('page threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  return result.value;
}
async function waitFor(expr, label, timeoutMs = 40000) {
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout: ' + label);
}
async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(OUT + name, Buffer.from(data, 'base64'));
  console.log('  [screenshot]', name);
}
const text = (id) => `document.getElementById('${id}').textContent`;
const setVal = (id, v) => evaluate(`{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input',{bubbles:true})); }`);
const click = (id) => evaluate(`document.getElementById('${id}').click()`);
let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

// ---- Arrange (node side): the wallet's first key, funded, with a $100 mint.
const seed = mnemonicToSeed(MNEMONIC);
const d0 = deriveTaprootAddress(seed, { ...HD_NETWORKS.regtest, index: 0 });
const miner = await nodeRpc('getnewaddress', [], 'stand');
// the regtest chain is long-lived — earlier runs may have left open positions
const fetchPositions = async () =>
  (await (await fetch(`http://127.0.0.1:8789/api/address/${d0.address}/positions`)).json()).positions ?? [];
const before = await fetchPositions();
const fundTxid = await nodeRpc('sendtoaddress', [d0.address, 50_000], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
const fundTx = await nodeRpc('getrawtransaction', [fundTxid, true]);
const fundVout = fundTx.vout.findIndex((o) => o.scriptPubKey.address === d0.address);
await nodeRpc('setmockoracleprice', [13_420]); // mempool rejects mints on a stale quote
const tipHeight = await nodeRpc('getblockcount');
const { hex: mintHex, collateralSats, unlockHeight } = buildSignedMintTx({
  utxo: { txidHex: fundTxid, vout: fundVout, valueSats: BigInt(Math.round(fundTx.vout[fundVout].value * 1e8)) },
  privKeyHex: d0.privKeyHex,
  ddCents: 10_000n, // $100
  tierId: '6months',
  oraclePriceMicroUsd: 13_420n,
  tipHeight,
});
const mintTxid = await nodeRpc('sendrawtransaction', [mintHex]);
await nodeRpc('generatetoaddress', [1, miner], 'stand');
check(true, `minted $100 (6 months) client-side: ${mintTxid.slice(0, 16)}…, collateral ${collateralSats} sats, unlock ${unlockHeight}`);

// indexer must report the new position before we even open the UI
// (poll briefly: ElectrumX indexes the fresh block asynchronously)
let positions = [];
for (let i = 0; i < 40 && !positions.some((p) => p.txid === mintTxid); i++) {
  await new Promise((r) => setTimeout(r, 500));
  positions = await fetchPositions();
}
const pos = positions.find((p) => p.txid === mintTxid);
check(positions.length === before.length + 1 && pos?.ddCents === '10000' && pos?.tierId === '6months'
  && pos?.unlockHeight === unlockHeight && pos?.collateralSats === String(collateralSats),
  `indexer reports the new open position (${before.length} pre-existing + 1)`);
const totalCents = positions.reduce((n, p) => n + Number(p.ddCents), 0);

// ---- Act: restore the wallet in the UI and let the money poller render it.
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC);
await setVal('w-create-pass', 'positions flow pass');
await setVal('w-create-pass2', 'positions flow pass');
await click('w-restore-go');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
check(await evaluate(text('w-address')) === d0.address, 'UI derives the same first address as the driver');

// ---- Assert: the position renders with amount, tier, collateral, expiry date.
await waitFor(`${text('w-positions')}.includes('block ${unlockHeight.toLocaleString('en-US')}')`, 'new position rendered');
const posText = await evaluate(text('w-positions'));
check(posText.includes('$100.00'), `position shows the minted amount: "${posText.slice(0, 90)}…"`);
check(posText.includes('6 months'), 'position shows the lock tier');
check(posText.includes(Math.round(Number(collateralSats) / 1e8).toLocaleString('en-US').slice(0, 3)), 'position shows the locked collateral in DGB');
// The card says "locked until ≈ <date>"; this asserted "unlocks ≈ <date>",
// a wording that is nowhere in app.js. What matters is a real expiry DATE
// next to the unlock block, so accept either verb rather than pin the copy.
check(/(?:unlocks|locked until) ≈ \d{4}-\d{2}-\d{2}/.test(posText) && posText.includes(`block ${unlockHeight.toLocaleString('en-US')}`),
  'position shows an expiry DATE and the unlock block');
check(await evaluate(text('w-dd-total')) === '$' + (totalCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }),
  'DigiDollar total shown next to the positions header');

// AC: DGB balance and DD positions clearly distinguished — separate rows, and
// the locked collateral is NOT counted into the spendable DGB balance.
const balance = await evaluate(text('w-balance'));
check(Number(balance.replace(/,/g, '')) < Number(collateralSats) / 1e8,
  `DGB balance (${balance}) excludes the locked collateral — positions are a separate section`);
await shot('40-positions.png');

console.log('\nDone.');
ws.close();
