// Drive #38: mint change (P2WPKH by consensus) must stay visible and spendable.
// Proves, against the full real stack (node + ElectrumX + indexer + wallet UI):
//   1. after a mint, the DGB change shows up in the wallet balance (was: ~0 —
//      the wallet only watched P2TR, so thousands of DGB silently vanished);
//   2. the Send flow spends that P2WPKH coin fully client-side (BIP-143),
//      verified by the node: the spend's input IS the mint's change output,
//      its witness is the 2-item v0 stack, and it mines.
// Setup: same as verify-mint.mjs (indexer 8789, wallet 8791,
// headless Chrome CDP on 9224 with a FRESH profile).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = fileURLToPath(new URL('.', import.meta.url));
const RPC = 'http://127.0.0.1:18500';

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

// ---- Expected numbers, computed HERE with Core's formula (not read from the app):
// $10 at the 1hour tier (1000%) at $0.01342 → collateral = ceil(1000¢ ·1e8 ·1000 ·100
// / 13420) then ×101/100 floored; change = 8000 DGB − collateral − 0.12 DGB fee.
const ceilDiv = (n, d) => (n + d - 1n) / d;
const collateralSats = (ceilDiv(1000n * 100_000_000n * 1000n * 100n, 13_420n) * 101n) / 100n;
const expectedChangeSats = 8_000n * 100_000_000n - collateralSats - 12_000_000n;
const fmt = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---- Arrange: fresh wallet; ONE 8000-DGB coin (the mint consumes it whole).
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'p2wpkh change pass');
await setVal('w-create-pass2', 'p2wpkh change pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
await click('w-backup-done'); // skip the backup ceremony overlay (spec §2)
const addr0 = await evaluate(text('w-address'));
const miner = await nodeRpc('getnewaddress', [], 'stand');
await nodeRpc('sendtoaddress', [addr0, 8000], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '8,000'`, 'funding coin confirmed');

// ---- Act 1: mint $10 at 1hour via the UI; the change output is P2WPKH by consensus.
await nodeRpc('setmockoracleprice', [13_420]);
await setVal('w-mint-amount', '10');
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'mint confirmation');
check((await evaluate(text('w-mint-c-coll'))) === fmt(collateralSats),
  `mint confirmation shows the expected collateral: ${fmt(collateralSats)} DGB`);
const mempoolBefore = await nodeRpc('getrawmempool');
await nodeRpc('setmockoracleprice', [13_420]); // fresh quote right before broadcast
await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'mint broadcast');
const mintTxid = (await nodeRpc('getrawmempool')).find((t) => !mempoolBefore.includes(t));
check(!!mintTxid, `mint accepted into the mempool: ${mintTxid?.slice(0, 16)}…`);
const mintTx = await nodeRpc('getrawtransaction', [mintTxid, true]);
check(mintTx.vout[3]?.scriptPubKey.hex.startsWith('0014'),
  'mint change output (vout 3) IS witness-v0 P2WPKH — consensus pins the shape');
await nodeRpc('setmockoracleprice', [13_420]); // and right before mining a DD tx
await nodeRpc('generatetoaddress', [1, miner], 'stand');

// ---- Assert 1 (the #38 regression): the change shows in the balance (was ~0).
await waitFor(`${text('w-balance')} === '${fmt(expectedChangeSats)}'`, 'balance shows the mint change');
check(true, `after the mint, the DGB balance INCLUDES the P2WPKH change: ${fmt(expectedChangeSats)} DGB (before #38 it showed 0)`);
await waitFor(`${text('w-positions')}.includes('$10.00')`, 'position appears');
check((await evaluate(text('w-positions'))).includes('$10.00'), 'the $10.00 position renders alongside');
await shot('60-p2wpkh-change-visible.png');

// ---- Act 2: spend the change via the Send flow — it is the ONLY DGB coin left,
// so the send MUST consume the P2WPKH utxo (BIP-143 signing, client-side).
await click('w-next'); // second receive address = the wallet's own index-1 P2TR
const addr1 = await evaluate(text('w-address'));
check(addr1 !== addr0 && addr1.startsWith('dgbrt1p'), `self-send target is the wallet's second P2TR address: ${addr1.slice(0, 20)}…`);
await setVal('w-send-to', addr1);
await setVal('w-send-amount', '100');
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'send confirmation');
// single p2wpkh input + 2 P2TR outputs: 42+272+344 = 658 wu → 165 vB → 16_500 sats
check((await evaluate(text('w-send-c-fee'))) === '0.000165',
  'send confirmation prices the v0 input correctly (0.000165 DGB = 165 vB)');
const mempoolBefore2 = await nodeRpc('getrawmempool');
await click('w-send-go');
await waitFor(`${text('w-send-out')}.startsWith('Sent')`, 'send broadcast');
const sendTxid = (await nodeRpc('getrawmempool')).find((t) => !mempoolBefore2.includes(t));
check(!!sendTxid, `send accepted into the mempool: ${sendTxid?.slice(0, 16)}…`);

// ---- Assert 2: the node confirms the spend consumed the MINT CHANGE via a
// witness-v0 stack, and the money arrived at the wallet's own second address.
const sendTx = await nodeRpc('getrawtransaction', [sendTxid, true]);
check(sendTx.vin.length === 1 && sendTx.vin[0].txid === mintTxid && sendTx.vin[0].vout === 3,
  'the send spends exactly the mint change output (mint txid, vout 3)');
check(sendTx.vin[0].txinwitness.length === 2,
  'v0 witness stack: [DER signature, compressed pubkey] — BIP-143, not taproot');
check(sendTx.vout.some((o) => o.scriptPubKey.address === addr1 && Math.round(o.value * 1e8) === 100 * 1e8),
  'a 100-DGB output pays the second wallet address');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
const mined = await nodeRpc('getrawtransaction', [sendTxid, true]);
check(mined.confirmations >= 1, 'the v0 spend mines');
// self-send: balance only drops by the fee
const expectedAfter = expectedChangeSats - 16_500n;
await waitFor(`${text('w-balance')} === '${fmt(expectedAfter)}'`, 'balance settles after the self-send');
check(true, `funds arrived: balance is ${fmt(expectedAfter)} DGB (change − fee, nothing lost)`);
await shot('61-p2wpkh-change-spent.png');

console.log('\nDone.');
ws.close();
