// Drive #14: the Mint flow in the wallet UI through the full real stack.
// Proves: mint section on by default (#17 removed the flag), confirmation
// screen (collateral / oracle price / expiry) BEFORE signing, client-signed
// broadcast, the position appearing in the wallet, and DISTINCT actionable
// errors for stale-oracle, insufficient and fragmented funds. Setup: same as
// verify-send.mjs.
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

// ---- Arrange: fresh wallet; two 500-DGB coins (fragmented on purpose).
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'mint flow pass');
await setVal('w-create-pass2', 'mint flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
check(await evaluate(`document.getElementById('w-mint').style.display !== 'none'`), 'mint section visible by default — no feature flag (#17, ADR-0002)');
check(await evaluate(`document.getElementById('w-transfer').style.display !== 'none'`), 'transfer section visible by default too (ADR-0002: never mint alone)');
const addr0 = await evaluate(text('w-address'));
const miner = await nodeRpc('getnewaddress', [], 'stand');
await nodeRpc('sendtoaddress', [addr0, 500], 'stand');
await nodeRpc('sendtoaddress', [addr0, 500], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '1,000'`, 'both coins confirmed');
await nodeRpc('setmockoracleprice', [13_420]);

// ---- Error 1: insufficient funds — distinct message with the exact numbers.
// $1,000 is the regtest consensus MAXIMUM (DD_TX_LIMITS.regtest), so it passes
// the wallet's pre-sign limit check yet still needs ~753k DGB at $0.01342.
await setVal('w-mint-amount', '1000');
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('insufficient funds')`, 'insufficient error');
const errInsufficient = await evaluate(text('w-mint-err'));
check(errInsufficient.includes('you have 1,000') && errInsufficient.includes('DGB'),
  `insufficient-funds error is specific: "${errInsufficient.slice(0, 100)}…"`);

// ---- Error 2: fragmented funds — actionable (points at self-send consolidation).
// $1 at 1hour tier: 1000% collateral ≈ 752.6 DGB + fee — more than either
// 500-DGB coin, less than the 1000 total.
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await setVal('w-mint-amount', '1');
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('no single coin')`, 'fragmented error');
const errFragmented = await evaluate(text('w-mint-err'));
check(errFragmented.includes('consolidate') && errFragmented.includes('own address'),
  `fragmented-funds error is actionable: "${errFragmented.slice(0, 110)}…"`);
await shot('50-mint-errors.png');

// ---- Error 3: stale oracle. The regtest MOCK oracle re-signs on every query,
// so a genuinely stale quote is unproducible here — instead the driver stubs
// the RPC response at the page boundary, which is exactly the input the UI's
// error branch consumes on a real network.
await evaluate(`{
  window.__origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (url === '/api/rpc' && opts?.body?.includes('getoracleprice')) {
      return new Response(JSON.stringify({ result: { price_micro_usd: 13420, is_stale: true } }),
        { headers: { 'content-type': 'application/json' } });
    }
    return window.__origFetch(url, opts);
  };
}`);
await setVal('w-mint-amount', '75');
await evaluate(`document.getElementById('w-mint-tier').value = '6months'`);
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('stale')`, 'stale-oracle error');
check((await evaluate(text('w-mint-err'))).includes('fresh quote'),
  'stale-oracle error is distinct and explains what to wait for');
await evaluate(`window.fetch = window.__origFetch`);

// ---- Error 4: softfork inactive. Same technique: getdeploymentinfo is stubbed
// to "not active" before the app boots, then the page is reloaded.
const { identifier: stubId } = await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: `{
    const orig = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (url === '/api/rpc' && opts?.body?.includes('getdeploymentinfo')) {
        return new Response(JSON.stringify({ result: { deployments: {
          digidollar: { type: 'bip9', bip9: { status: 'started' }, active: false },
          taproot: { type: 'bip9', bip9: { status: 'active' }, active: true },
        } } }), { headers: { 'content-type': 'application/json' } });
      }
      return orig(url, opts);
    };
  }`,
}, sessionId);
await cdp('Page.reload', {}, sessionId);
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked after reload');
await setVal('w-unlock-pass', 'mint flow pass');
await click('w-unlock');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked again');
await waitFor(`${text('s-dd')}.length > 0 && !${text('s-dd')}.includes('active')`, 'status card shows DD inactive');
await setVal('w-mint-amount', '75');
await evaluate(`document.getElementById('w-mint-tier').value = '6months'`);
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('not active')`, 'softfork-inactive error');
check((await evaluate(text('w-mint-err'))).includes('softfork activates'),
  'softfork-inactive error is distinct and points at the Status card');
await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubId }, sessionId);

// ---- Happy path: $75 at 6 months (collateral ≈ 19,756 DGB — fund one big coin).
await cdp('Page.reload', {}, sessionId);
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked for the happy path');
await setVal('w-unlock-pass', 'mint flow pass');
await click('w-unlock');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked for the happy path');
await nodeRpc('sendtoaddress', [addr0, 25_000], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '26,000'`, 'big coin confirmed');
await nodeRpc('setmockoracleprice', [13_420]);
await setVal('w-mint-amount', '75');
await evaluate(`document.getElementById('w-mint-tier').value = '6months'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'confirmation screen');
const cColl = await evaluate(text('w-mint-c-coll'));
const cPrice = await evaluate(text('w-mint-c-price'));
const cUnlock = await evaluate(text('w-mint-c-unlock'));
// $75 · 350% ÷ $0.01342 × 1.01 ≈ 19,755.96 DGB — recompute independently:
// ceil(7500·1e8·350·100/13420)=195,603,576,752 → ×101/100 = 197,559,612,519 sats
check(cColl === '19,755.96', `confirmation shows the exact collateral: ${cColl} DGB`);
check(cPrice === '$0.01342 / DGB', `confirmation shows the oracle price used: ${cPrice}`);
check(/≈ \d{4}-\d{2}-\d{2} \(block [\d,]+\)/.test(cUnlock), `confirmation shows the lock expiry: ${cUnlock}`);
check((await nodeRpc('getrawmempool')).length === 0, 'nothing signed or broadcast at review time');
await shot('51-mint-confirm.png');

await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'broadcast acknowledged');
const mempool = await nodeRpc('getrawmempool');
check(mempool.length === 1, `client-signed mint accepted into the mempool: ${mempool[0]?.slice(0, 16)}…`);
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-positions')}.includes('$75.00')`, 'position appears in the wallet');
const posText = await evaluate(text('w-positions'));
check(posText.includes('$75.00') && posText.includes('6 months') && posText.includes('19,755.96'),
  `position rendered after mining: "${posText.slice(0, 100)}…"`);
await shot('52-mint-position.png');

console.log('\nDone.');
ws.close();
