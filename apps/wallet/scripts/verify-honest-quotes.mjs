// Drive #62: honest quotes + friendly consensus errors, offline in mock mode.
// Proves: getdcamultiplier proxied (and fund-moving RPCs still blocked), every
// quote surface (calculator, slider preview, review screen) scales with a
// degraded-health DCA multiplier, the volatility freeze blocks the review
// BEFORE signing, and a consensus reject on broadcast surfaces as a friendly
// error, not raw node text. Setup (degraded health is the point):
//   MOCK_SYSTEM_HEALTH=130 PORT=8791 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-honest-quotes.mjs   # exit 0 = all green
// The indexer and the broadcast reject are faked via CDP Fetch interception —
// no node, no indexer, no funds needed.
import { writeFileSync } from 'node:fs';
import { requiredCollateralSats } from 'digidollar-js';

const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
const APP = process.env.APP_URL || 'http://127.0.0.1:8791';
const OUT = new URL('.', import.meta.url).pathname; // screenshots land next to the driver, not in cwd
const MINT_FEE_SATS = 12_000_000n; // app.js MINT_FEE_SATS
const PRICE_MICRO = 13_420n; // mock getoracleprice
const DCA_BPS = 12_500n; // MOCK_SYSTEM_HEALTH=130 → warning tier, 1.25×

const fmtDGB = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });

let step = 0;
function check(cond, what) {
  step++;
  console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`);
  if (!cond) process.exitCode = 1;
}

// -- A. proxy surface (no browser needed)
const api = async (method, params = []) => {
  const res = await fetch(APP + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  return { status: res.status, json: await res.json() };
};
{
  const { status, json } = await api('getdcamultiplier');
  check(status === 200 && json.result.multiplier === 1.25 && json.result.tier_status === 'warning',
    `getdcamultiplier proxied: ${JSON.stringify(json.result)}`);
  const blocked = await api('mintdigidollar', [10000, 3]);
  check(blocked.status === 403, 'fund-moving mintdigidollar still refused by the whitelist');
}

// -- CDP plumbing (house pattern) + Fetch interception state
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
const fake = { protectionFrozen: false, broadcastReject: false, utxoSats: 0n };

function fulfill(requestId, sid, status, body) {
  return cdp('Fetch.fulfillRequest', {
    requestId,
    responseCode: status,
    responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  }, sid);
}

ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const sid = m.sessionId;
  try {
    if (request.url.includes('/api/indexer/')) {
      // one fat P2TR coin on every watched address — enough for the mint
      const body = request.url.endsWith('/utxos')
        ? { utxos: [{ txid: 'ab'.repeat(32), vout: 0, valueSats: String(fake.utxoSats), height: 100 }] }
        : request.url.endsWith('/dd-utxos') ? { utxos: [], totalCents: '0' }
        : request.url.endsWith('/positions') ? { address: '', positions: [], tipHeight: 100 }
        : { history: [] };
      return await fulfill(requestId, sid, 200, body);
    }
    const rpcBody = request.postData ? JSON.parse(request.postData) : {};
    if (fake.protectionFrozen && rpcBody.method === 'getprotectionstatus') {
      return await fulfill(requestId, sid, 200, {
        result: {
          oracle: { available: true, minting_restricted: false },
          volatility: { protection_active: true, current_volatility: 24.8, protection_threshold: 20, minting_restricted: true },
        },
      });
    }
    if (fake.broadcastReject && rpcBody.method === 'sendrawtransaction') {
      return await fulfill(requestId, sid, 502, { error: 'minting-frozen-volatility, DigiDollar: Minting frozen due to high volatility' });
    }
    await cdp('Fetch.continueRequest', { requestId }, sid);
  } catch (e) {
    console.error('interception error:', e.message);
  }
};
const cdp = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await cdp('Page.enable', {}, sessionId);
await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/indexer/*' }, { urlPattern: '*/api/rpc' }] }, sessionId);

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error('page threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  return result.value;
}
async function waitFor(expr, label, timeoutMs = 15000) {
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${label}`);
}
async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(OUT + name, Buffer.from(data, 'base64'));
  console.log('  [screenshot]', name);
}
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const text = (id) => `document.getElementById('${id}').textContent`;
const click = (id) => evaluate(`document.getElementById('${id}').click()`);
const setVal = (id, v) => evaluate(
  `{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', {bubbles:true})); }`);

// -- B. guest calculator quotes with the degraded multiplier
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(visible('w-none'), 'no-wallet state');
await waitFor(`${text('o-price')}.startsWith('$')`, 'oracle price loaded');
await waitFor(`${text('r-ratio')}.includes('1250%')`, 'calculator ratio reflects DCA');
const rRatio = await evaluate(text('r-ratio'));
check(rRatio.includes('1250%') && rRatio.includes('1000% base') && rRatio.includes('1.25×'),
  `calculator ratio is the EFFECTIVE one with the base spelled out: "${rRatio}"`);
const expectCalc = requiredCollateralSats({ ddCents: 10_000n, tierId: '1hour', oraclePriceMicroUsd: PRICE_MICRO, dcaMultiplierBps: DCA_BPS });
check((await evaluate(text('r-dgb'))) === fmtDGB(expectCalc),
  `calculator DGB-to-lock is the DCA-scaled amount: ${fmtDGB(expectCalc)} DGB`);
await shot('80-calculator-dca.png');

// -- C. wallet + mint slider preview
await setVal('w-create-pass', 'correct horse battery');
await setVal('w-create-pass2', 'correct horse battery');
await click('w-create');
await waitFor(visible('w-open'), 'unlocked after create');
await click('w-backup-done');
await click('act-mint');
await setVal('w-mint-amount', '150');
await waitFor(`${text('mint-estimate')}.length > 0`, 'mint estimate rendered');
const est = await evaluate(text('mint-estimate'));
const expectMint = requiredCollateralSats({ ddCents: 15_000n, tierId: '1hour', oraclePriceMicroUsd: PRICE_MICRO, dcaMultiplierBps: DCA_BPS });
check(est.includes(fmtDGB(expectMint)) && est.includes('1250%') && est.includes('1.25× collateral') && est.includes('warning'),
  `slider preview quotes with DCA and names the tier: "${est}"`);
fake.utxoSats = expectMint + MINT_FEE_SATS + 100_000_000n;

// -- D. volatility freeze blocks the review BEFORE anything is signed
fake.protectionFrozen = true;
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.length > 0`, 'freeze gate error');
const frozenErr = await evaluate(text('w-mint-err'));
check(/frozen/i.test(frozenErr) && /20%/.test(frozenErr) && !(await evaluate(visible('w-mint-confirm'))),
  `frozen minting blocks review pre-sign: "${frozenErr}"`);
await shot('81-freeze-gate.png');

// -- E. review screen: DCA-scaled collateral + explicit ratio row
fake.protectionFrozen = false;
await click('w-mint-review');
await waitFor(visible('w-mint-confirm'), 'confirmation screen');
const cRatio = await evaluate(text('w-mint-c-ratio'));
const cColl = await evaluate(text('w-mint-c-coll'));
check(cRatio.includes('1250%') && cRatio.includes('1000% base') && cRatio.includes('warning'),
  `review shows the effective ratio and why: "${cRatio}"`);
check(cColl === fmtDGB(expectMint), `review collateral is the DCA-scaled amount: ${cColl} DGB`);
await shot('82-review-dca-ratio.png');

// -- F. consensus reject on broadcast → friendly error, raw token preserved
fake.broadcastReject = true;
await click('w-mint-go');
await waitFor(`${text('w-mint-err')}.length > 0`, 'broadcast error surfaced');
const rejErr = await evaluate(text('w-mint-err'));
check(/frozen/i.test(rejErr) && /untouched/.test(rejErr) && rejErr.includes('minting-frozen-volatility'),
  `consensus reject mapped to a friendly error: "${rejErr}"`);
check(!rejErr.startsWith('minting-frozen-volatility'), 'raw node text is not the headline');
await shot('83-friendly-reject.png');

console.log(process.exitCode ? '\nSome checks FAILED' : '\nAll honest-quote checks green');
ws.close();
