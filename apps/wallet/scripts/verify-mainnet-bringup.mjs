// Mainnet bring-up (#61): drive the wallet against a MAINNET-shaped node and
// prove the config-only story: neutral chrome (no testnet banner/title),
// dgb1p… addresses on coin type 20, live deployment status, no faucet UI,
// and a self-explanatory no-indexer state.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-mainnet-bringup.mjs   # exit 0 = all green
// A fresh user-data-dir gives a fresh IndexedDB ("no wallet" state) — required.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';

// ---- stub DigiByte MAINNET node (shapes mirror the live 9.26.x node) ----
const HEIGHT = 23_828_832; // pre-activation: DD signaling, not yet active
function nodeResult(method) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain: 'main', blocks: HEIGHT, headers: HEIGHT, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: { type: 'bip9', active: false, bip9: { bit: 23, status: 'started', min_activation_height: 23_627_520 } },
          taproot: { type: 'bip9', active: true, bip9: { status: 'active' } },
        },
      };
    case 'getoracleprice':
      return { price_micro_usd: 8_420, price_cents: 1, price_usd: 0.00842, is_stale: false, oracle_count: 35, status: 'ok' };
    case 'getoracles':
      return Array.from({ length: 35 }, (_, i) => ({
        oracle_id: i, name: `oracle-${i}`, is_active: true, in_consensus: true,
        active_oracle_count: 35, total_oracle_slots: 35, consensus_threshold: 7,
      }));
    default:
      throw new Error(`stub node: no handler for ${method}`);
  }
}
let nodeUp = false; // starts DOWN: the driver proves the unknown-chain guard + recovery first
const node = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const { method, id } = JSON.parse(raw);
  if (!nodeUp) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    return res.end('node down');
  }
  try {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, result: nodeResult(method) }));
  } catch (e) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, error: { message: String(e.message) } }));
  }
});
await new Promise((r) => node.listen(0, r));

// real mode (creds set), mainnet node, NO faucet, NO indexer — the #61 shape
const server = startServer({
  port: 0,
  rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
});
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

// ---- CDP plumbing (same recipe as verify-ui.mjs) ----
const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
function cdp(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await cdp('Page.enable', {}, sessionId);
await cdp('Runtime.enable', {}, sessionId);
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error('page threw: ' + JSON.stringify(exceptionDetails.exception?.description || exceptionDetails.text));
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
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const text = (id) => `document.getElementById('${id}').textContent`;
const click = (id) => evaluate(`document.getElementById('${id}').click()`);
const setVal = (id, v) => evaluate(
  `{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', {bubbles:true})); }`);
let step = 0;
function check(cond, what) {
  step++;
  console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`);
  if (!cond) process.exitCode = 1;
}

// -- 1. boot with the node DOWN: nothing may claim a network
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(visible('w-none'), 'no-wallet state');
check((await evaluate(`document.title`)) === 'Diginaut · DigiDollar wallet', 'tab title is network-neutral while the chain is unknown');
check(await evaluate(`document.getElementById('net-banner').hidden`), 'no network banner while the chain is unknown');

// -- 2. create a wallet while the chain is unknown → placeholder, never a guessed address
await setVal('w-create-pass', 'correct horse battery');
await setVal('w-create-pass2', 'correct horse battery');
await click('w-create');
await waitFor(visible('w-open'), 'unlocked after create');
const placeholder = await evaluate(text('w-address'));
check(!/1[a-z0-9]{20,}/.test(placeholder), `no address rendered for a guessed network: "${placeholder}"`);
check(await evaluate(`document.getElementById('w-copy').disabled`), 'copy is disabled — nothing address-like to copy');

// -- 3. node comes up (mainnet): the status retry loop recovers without a reload
nodeUp = true;
await waitFor(`${text('s-chain')} === 'main'`, 'chain=main from the node (retry loop)', 20000);
check(true, 'status retry loop picks the node up without a page reload');
await waitFor(`${text('w-address')}.startsWith('dgb1p')`, 'mainnet address rendered after recovery');
const addr = await evaluate(text('w-address'));
const path = await evaluate(text('w-path'));
check(/^dgb1p[a-z0-9]{50,}$/.test(addr), `mainnet receive address: ${addr.slice(0, 20)}…`);
check(path === "m/86'/20'/0'/0/0", `SLIP-44 coin type 20 derivation path (${path})`);
check(!(await evaluate(`document.getElementById('w-copy').disabled`)), 'copy re-enabled once the network is known');
check((await evaluate(`document.title`)) === 'Diginaut · DigiDollar wallet', 'tab title stays network-neutral on mainnet');
check(await evaluate(`document.getElementById('net-banner').hidden`), 'no banner on mainnet (beta copy is #63)');
check(!(await evaluate(`document.body.textContent`)).includes('TESTNET'), 'no user-visible TESTNET wording anywhere');
check((await evaluate(text('modeBadge'))) === 'LIVE NODE', 'LIVE NODE badge (real mode)');

// -- 4. DD deployment honestly reported pre-activation
await waitFor(`${text('s-dd')}.includes('started')`, 'dd status rendered');
check(true, 'DigiDollar shows BIP9 "started" (not active yet)');

// -- 5. no faucet configured → no faucet affordance
check(await evaluate(`document.getElementById('w-faucet').style.display === 'none'`), 'faucet button absent (none configured)');

// -- 6. no indexer configured → the state explains itself, receive still works
await waitFor(visible('w-no-indexer'), 'no-indexer panel');
check((await evaluate(text('w-no-indexer'))).includes('indexer'), 'no-indexer panel explains why balances are unavailable');
check(await evaluate(`document.getElementById('loading-veil').style.display === 'none'`), 'no eternal loading veil without an indexer');
await click('w-no-indexer-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive modal opens from the panel');
check((await evaluate(text('w-address'))).startsWith('dgb1p'), 'receive modal shows the mainnet address');

await cdp('Target.closeTarget', { targetId });
ws.close();
server.close();
node.close();
console.log(process.exitCode ? '\nFAILED' : '\nall green');
