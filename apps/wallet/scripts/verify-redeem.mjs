// Drive #16: the Redemption flow through the full real stack. Mint → wait out
// the CLTV lock → redeem from the position's button → collateral back in the
// DGB balance. Proves the locked-until state, the no-fee-coin error, the
// confirmation screen before signing, and the position closing. Setup: same
// as verify-mint.mjs.
import { writeFileSync } from 'node:fs';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = new URL('.', import.meta.url).pathname;
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
async function waitFor(expr, label, timeoutMs = 60000) {
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

// ---- Arrange: fresh wallet, mint $10 at the 1-hour tier (240-block lock).
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'redeem flow pass');
await setVal('w-create-pass2', 'redeem flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
const addr0 = await evaluate(text('w-address'));
const miner = await nodeRpc('getnewaddress', [], 'stand');
await nodeRpc('sendtoaddress', [addr0, 8_000], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '8,000'`, 'funded');
await nodeRpc('setmockoracleprice', [13_420]);

await setVal('w-mint-amount', '10');
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'mint confirmation');
await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'mint broadcast');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-positions')}.includes('$10.00')`, 'position visible');

// ---- AC: a still-locked position says so instead of failing opaquely.
const lockedText = await evaluate(text('w-positions'));
check(lockedText.includes('locked until') && /block [\d,]+/.test(lockedText),
  `locked position communicates its state: "${lockedText.slice(0, 110)}…"`);
check(!lockedText.includes('Redeem'), 'no redeem button while the CLTV lock is running');
await shot('70-redeem-locked.png');

// ---- Wait out the lock: 1 hour tier = 240 blocks + 100 confirmation buffer.
await nodeRpc('generatetoaddress', [345, miner], 'stand');
await waitFor(`document.querySelector('#w-positions [data-redeem]') !== null`, 'redeem button appears after expiry');
check(true, 'redeem button appears once the lock expires');

// ---- Error: mint change went to P2WPKH, so there is no DGB fee coin.
await evaluate(`document.querySelector('#w-positions [data-redeem]').click()`);
await waitFor(`${text('w-rd-err')}.includes('no DGB for the fee')`, 'no-fee-coin error');
check((await evaluate(text('w-rd-err'))).includes(addr0), 'no-fee-coin error names the address to top up');

await nodeRpc('sendtoaddress', [addr0, 1], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '1'`, 'fee coin confirmed');

// ---- Confirmation before signing.
await evaluate(`document.querySelector('#w-positions [data-redeem]').click()`);
await waitFor(`document.getElementById('w-redeem-confirm').style.display !== 'none'`, 'redeem confirmation');
check((await evaluate(text('w-rd-c-dd'))) === '10.00', 'confirmation shows the DigiDollar to burn: $10.00');
const cColl = await evaluate(text('w-rd-c-coll'));
check(cColl === '7,526.08', `confirmation shows the returned collateral: ${cColl} DGB`);
check((await evaluate(text('w-rd-c-fee'))) === '0.12', 'confirmation shows the 0.12 DGB fee');
check((await nodeRpc('getrawmempool')).length === 0, 'nothing signed or broadcast at review time');
await shot('71-redeem-confirm.png');

// ---- Redeem: position closes, collateral lands in the DGB balance.
await click('w-rd-go');
await waitFor(`${text('w-rd-out')}.startsWith('Redeemed')`, 'broadcast acknowledged');
const mempool = await nodeRpc('getrawmempool');
check(mempool.length === 1, `client-signed redemption accepted into the mempool: ${mempool[0]?.slice(0, 16)}…`);
// the BLOCK TEMPLATE also drops DD txs on a stale quote (not just mempool
// acceptance) — refresh the mock price or generatetoaddress mines an empty block
await nodeRpc('setmockoracleprice', [13_420]);
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-positions')} === 'No open positions.'`, 'position closed');
check(true, 'position disappears after the redemption confirms');
await waitFor(`${text('w-dd-balance')} === '0.00'`, 'burned DigiDollar gone');
// 7,526.08 collateral + (1 − 0.12) fee change = 7,526.96 — the change is
// visible because the redeem routes it to the watched P2TR, not Core's P2WPKH
await waitFor(`${text('w-balance')} === '7,526.96'`, 'collateral back in the DGB balance');
check(true, `DGB balance = 7,526.96 — full collateral (7,526.08) + fee change returned to view`);
await shot('72-redeem-done.png');

console.log('\nDone.');
ws.close();
