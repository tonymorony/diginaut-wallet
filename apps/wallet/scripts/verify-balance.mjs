// Drive #5: balance & history in the wallet UI through the full real stack
// (regtest node + ElectrumX + indexer façade + faucet + wallet app).
import { writeFileSync } from 'node:fs';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = new URL('.', import.meta.url).pathname;
const RPC = 'http://127.0.0.1:18500/wallet/stand';

async function nodeRpc(method, params = []) {
  const res = await fetch(RPC, {
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

await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');

// oracle card must be healthy on the LIVE node now (renamed RPCs)
await waitFor(`${text('o-price')}.startsWith('$')`, 'oracle price rendered');
check(true, 'oracle card works on the live node: price ' + await evaluate(text('o-price')) + ', consensus ' + await evaluate(text('o-consensus')));

await setVal('w-create-pass', 'balance flow pass');
await setVal('w-create-pass2', 'balance flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');

// empty wallet: money section appears via polling with zero balance
await waitFor(`document.getElementById('w-money').style.display !== 'none'`, 'money section shown');
check((await evaluate(text('w-balance'))) === '0', 'fresh wallet shows balance 0, history: ' + (await evaluate(text('w-history'))).slice(0, 30));

// claim from the faucet → must appear as PENDING without any mining
await click('w-faucet');
await waitFor(`${text('w-faucet-out')}.startsWith('Sent')`, 'faucet dispensed');
await waitFor(`document.getElementById('w-pending-row').style.display !== 'none'`, 'pending row visible');
const pendingAmt = await evaluate(text('w-pending'));
check(pendingAmt === '14,488', 'incoming tx shows as PENDING +' + pendingAmt + ' DGB while in mempool');
check((await evaluate(text('w-history'))).includes('pending'), 'history entry marked pending');
await shot('20-pending.png');

// mine a block → the same tx must flip to confirmed and land in the balance
await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress')]);
await waitFor(`${text('w-balance')} === '14,488'`, 'balance confirmed after mining');
check(true, 'after 1 block: balance = 14,488 DGB');
await waitFor(`document.getElementById('w-pending-row').style.display === 'none'`, 'pending row gone');
check((await evaluate(text('w-history'))).includes('confirmed'), 'history entry flipped to confirmed');
await shot('21-confirmed.png');

// probe: lock stops the money section; unlock restores it with the same balance
await click('w-lock');
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked');
await setVal('w-unlock-pass', 'balance flow pass');
await click('w-unlock');
await waitFor(`${text('w-balance')} === '14,488'`, 'balance back after unlock');
check(true, 'PROBE: lock → unlock re-derives and re-fetches the same balance');

console.log('\nDone.');
ws.close();
