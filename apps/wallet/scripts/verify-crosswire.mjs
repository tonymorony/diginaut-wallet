// Cross-wire guard, end to end (#64): a wallet deployment whose node reports
// the WRONG chain must fail loudly and closed — danger banner, CROSS-WIRED
// badge, no wallet boot, every RPC refused. Server unit tests cover the guard
// logic; this drives the UI's blocking state through a real browser.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-crosswire.mjs   # exit 0 = all green
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';

// ---- stub DigiByte node that reports TESTNET ----
const node = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const { method, id } = JSON.parse(raw);
  const result = method === 'getblockchaininfo'
    ? { chain: 'test', blocks: 1_200_000, headers: 1_200_000, initialblockdownload: false }
    : { price_micro_usd: 2_546, is_stale: false };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, result }));
});
await new Promise((r) => node.listen(0, r));

// …behind a wallet that claims MAINNET
const server = startServer({
  port: 0,
  rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
  expectedChain: 'main',
});
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

// give the guard's boot probe a moment to learn the node's chain
for (let i = 0; i < 40; i++) {
  const cfg = await (await fetch(APP + '/api/config')).json();
  if (cfg.chain) break;
  await new Promise((r) => setTimeout(r, 50));
}

// ---- CDP plumbing (same recipe as verify-beta-posture.mjs) ----
const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
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
async function waitFor(expr, label, timeoutMs = 20000) {
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timeout: ' + label);
}
let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`!document.getElementById('net-banner').hidden`, 'banner renders');

const banner = await evaluate(`document.getElementById('net-banner').textContent`);
check(/SERVER MISCONFIGURED/.test(banner), `danger banner names the failure: "${banner}"`);
check(/MAIN/.test(banner) && /TEST/.test(banner), 'banner names both chains (expected vs actual)');
check(await evaluate(`document.getElementById('net-banner').classList.contains('danger')`), 'banner is danger-red');
check(await evaluate(`document.getElementById('modeBadge').textContent === 'CROSS-WIRED'`), 'mode badge says CROSS-WIRED');
check(await evaluate(`document.getElementById('w-loading').textContent.includes('wallet disabled')`), 'wallet boot is blocked with an explanation');
check(!(await evaluate(`document.getElementById('w-none').style.display !== 'none'`)), 'create-wallet flow never appears');

// the server side of the same coin: every RPC is refused
const rpcRes = await fetch(APP + '/api/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'getoracleprice', params: [] }),
});
check(rpcRes.status === 503 && /refusing to serve/.test((await rpcRes.json()).error), 'server refuses ALL rpc (503, names the cross-wire)');

const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync('./100-crosswire-blocked.png', Buffer.from(data, 'base64'));
console.log('  [screenshot] 100-crosswire-blocked.png');

console.log(process.exitCode ? '\nFAILED' : '\nall green');
ws.close();
node.close();
server.close();
process.exit(process.exitCode || 0);
