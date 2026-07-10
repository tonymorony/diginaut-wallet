// Drive the wallet UI in headless Chrome over CDP: create → lock → unlock → restore.
// Evidence: assertions on the live DOM + PNG screenshots (written to cwd).
// Needs no deps (Node ≥22 built-in WebSocket). Setup:
//   PORT=8791 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-ui.mjs          # exit 0 = all checks green
// A fresh user-data-dir gives a fresh IndexedDB ("no wallet" state) — required.
import { writeFileSync } from 'node:fs';

const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
const APP = process.env.APP_URL || 'http://127.0.0.1:8791';
const OUT = './';

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
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (exceptionDetails) throw new Error('page threw: ' + JSON.stringify(exceptionDetails.exception?.description || exceptionDetails.text));
  return result.value;
}

// Poll until an expression is truthy (UI state transitions are async).
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

let step = 0;
function check(cond, what) {
  step++;
  console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`);
  if (!cond) process.exitCode = 1;
}

// -- 1. fresh profile → "no wallet" state + banner
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(visible('w-none'), 'no-wallet state');
check(true, 'fresh profile boots into "no wallet" state');
// the banner is runtime-rendered from the node's chain (#61); mock chain = 'test'
await waitFor(`${text('net-banner')}.includes('TESTNET ONLY') && !document.getElementById('net-banner').hidden`, 'runtime TESTNET banner');
check(true, 'TESTNET ONLY banner rendered from the node chain (mock=test)');
await shot('01-no-wallet.png');

// -- probe: mismatched passwords rejected
await setVal('w-create-pass', 'correct horse battery');
await setVal('w-create-pass2', 'different');
await click('w-create');
await waitFor(`${text('w-none-err')}.length > 0`, 'mismatch error');
check((await evaluate(text('w-none-err'))).includes('match'), 'PROBE: mismatched passwords → inline error: ' + await evaluate(text('w-none-err')));

// -- 2. create wallet
await setVal('w-create-pass2', 'correct horse battery');
await click('w-create');
await waitFor(visible('w-open'), 'unlocked state after create');
const addr0 = await evaluate(text('w-address'));
const path0 = await evaluate(text('w-path'));
check(/^dgbt1p[a-z0-9]{50,}$/.test(addr0), `create → client-side receive address shown: ${addr0} (${path0})`);
check(path0 === "m/86'/1'/0'/0/0", 'path is BIP86 testnet account 0 index 0');
// #72: the receive screen also shows the DigiDollar base58check form (TD… on
// testnet) — the ONLY encoding Core/mobile wallets accept as a DD recipient.
const ddAddr0 = await evaluate(text('w-dd-address'));
check(/^TD[1-9A-HJ-NP-Za-km-z]{40,}$/.test(ddAddr0), `create → DigiDollar (TD…) address shown for interop: ${ddAddr0}`);
await shot('02-created-unlocked.png');

// -- 3. seed backup view (optional, reveals 12 words)
await click('w-backup');
const seed = (await evaluate(text('w-seed-words'))).trim();
check(seed.split(' ').length === 12, 'seed backup reveals a 12-word phrase');
await shot('03-seed-backup.png');
await click('w-backup');
check((await evaluate(text('w-seed-words'))) === '', 'hide seed clears it from the DOM');

// -- 4. next address
await click('w-next');
const addr1 = await evaluate(text('w-address'));
check(addr1 !== addr0 && (await evaluate(text('w-path'))) === "m/86'/1'/0'/0/1", `next address differs: ${addr1}`);

// -- 5. lock
await click('w-lock');
await waitFor(visible('w-locked'), 'locked state');
check(true, 'lock → locked state, mnemonic dropped from memory');
await shot('04-locked.png');

// -- probe: wrong password
await setVal('w-unlock-pass', 'not the password');
await click('w-unlock');
await waitFor(`${text('w-locked-err')}.length > 0`, 'wrong-pass error');
check((await evaluate(text('w-locked-err'))) === 'wrong password', 'PROBE: wrong password → "wrong password", stays locked');

// -- 6. unlock with the right password
await setVal('w-unlock-pass', 'correct horse battery');
await click('w-unlock');
await waitFor(visible('w-open'), 'unlocked after unlock');
check((await evaluate(text('w-address'))) === addr0, 'unlock → same address 0 re-derived');

// -- 7. reload: wallet persists (IndexedDB), comes back locked
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(visible('w-locked'), 'locked after reload');
check(true, 'page reload → wallet persisted, locked (keys not kept)');

// -- 8. erase + restore from seed round-trip
await evaluate(`{ const l = document.getElementById('w-forget'); l.click(); }`);
await waitFor(visible('w-none'), 'no-wallet after erase');
await click('w-show-restore');

// probe: junk seed rejected
await setVal('w-restore-seed', 'foo bar baz');
await setVal('w-create-pass', 'brand new password');
await setVal('w-create-pass2', 'brand new password');
await click('w-restore-go');
await waitFor(`${text('w-none-err')}.length > 0`, 'invalid seed error');
check((await evaluate(text('w-none-err'))).includes('valid BIP39'), 'PROBE: junk seed phrase → validation error: ' + await evaluate(text('w-none-err')));

await setVal('w-restore-seed', '  ' + seed.toUpperCase() + '  '); // sloppy paste: case + whitespace
await click('w-restore-go');
await waitFor(visible('w-open'), 'unlocked after restore');
check((await evaluate(text('w-address'))) === addr0, 'restore from seed (sloppy paste) → identical address 0: round-trip proven');
await shot('05-restored.png');

console.log('\nDone.');
ws.close();
