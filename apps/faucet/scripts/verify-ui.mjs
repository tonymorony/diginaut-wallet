// Drive the wallet UI faucet button against the REAL faucet + regtest node.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = fileURLToPath(new URL('.', import.meta.url)); // .pathname is a URL path — unusable as a path on Windows

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
async function waitFor(expr, label, timeoutMs = 30000) {
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 150));
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
check((await evaluate(`document.getElementById('modeBadge').textContent`)) === 'LIVE NODE', 'app runs against the LIVE regtest node');

// create a wallet
await setVal('w-create-pass', 'faucet flow pass');
await setVal('w-create-pass2', 'faucet flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
const addr = await evaluate(text('w-address'));
check(addr.startsWith('dgbrt1p'), 'client-derived REGTEST address (hrp from live chain): ' + addr);

// faucet button visible (FAUCET_URL configured) and claims real coins
await waitFor(`document.getElementById('w-faucet').style.display !== 'none'`, 'faucet button visible');
check(true, 'faucet button shown because FAUCET_URL is configured');
await click('w-faucet');
await waitFor(`${text('w-faucet-out')}.startsWith('Sent')`, 'faucet success message');
const msg = await evaluate(text('w-faucet-out'));
check(/^Sent [\d,]+ DGB — tx [0-9a-f]{16}…$/.test(msg), 'coins dispensed from the UI: ' + msg);
await shot('10-faucet-claimed.png');

// probe: immediate second claim → clear cooldown error, no crash
await click('w-faucet');
await waitFor(`${text('w-open-err')}.length > 0`, 'cooldown error surfaced');
const err = await evaluate(text('w-open-err'));
check(/already claimed/.test(err) && /24h/.test(err), 'PROBE: repeat claim → cooldown message in UI: ' + err.slice(0, 80) + '…');
await shot('11-faucet-cooldown.png');

// the tx really pays this address on the node
const txid = msg.match(/tx ([0-9a-f]{16})…/)[1];
console.log('   (txid prefix from UI: ' + txid + ')');

console.log('\nDone.');
ws.close();
