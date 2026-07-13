// Prove the demo/educational disclaimer (#79): the footer link renders on the
// wallet UI, opens a disclaimer dialog carrying the required wording (demo/
// educational only, no warranty, user bears all risk), and closes again.
// Evidence: assertions on the live DOM + a PNG screenshot (written to cwd).
// Needs no deps (Node ≥22 built-in WebSocket). Setup:
//   PORT=8791 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-disclaimer.mjs   # exit 0 = all checks green
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
const modalOpen = () => `document.getElementById('disclaimer-modal').classList.contains('open')`;
let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('footer-disclaimer')`, 'footer disclaimer link mounts');

// ---- 1. Footer link renders and is visible (regardless of wallet state).
const linkText = await evaluate(`document.getElementById('footer-disclaimer').textContent.trim()`);
const linkVisible = await evaluate(`(() => { const r = document.getElementById('footer-disclaimer').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
check(linkVisible && /disclaimer/i.test(linkText), `footer link renders: "${linkText}"`);

const footerLine = await evaluate(`document.querySelector('footer.site .disclaimer-line').textContent.replace(/\\s+/g,' ').trim()`);
check(/no warranty/i.test(footerLine) && /all risk/i.test(footerLine),
  `footer line states no-warranty + all-risk: "${footerLine}"`);

// ---- 2. Dialog starts closed, opens on click.
// app.js is a module (async): the footer <button> exists in static HTML before
// its click handler is wired, so re-issue the click until the dialog opens.
check(!(await evaluate(modalOpen())), 'disclaimer dialog starts closed');
await waitFor(`(() => { document.getElementById('footer-disclaimer').click(); return ${modalOpen()}; })()`,
  'dialog opens on link click');
check(true, 'clicking the footer link opens the disclaimer dialog');
await shot('90-disclaimer-open.png');

// ---- 3. Dialog carries the three required assertions.
const body = (await evaluate(`document.querySelector('#disclaimer-modal .disclaimer-body').textContent`)).toLowerCase();
check(/demonstration and educational/.test(body), 'wording: demonstration/educational only');
check(/no warranty|without warranty|as is|“as is”|"as is"/.test(body), 'wording: no warranty / as-is');
check(/bear all risk|all risk/.test(body), 'wording: user bears all risk');
check(/keys.*never leave|generated in your browser/.test(body.replace(/\s+/g, ' ')), 'wording: keys never leave the browser');

// ---- 4. Close button dismisses it.
await evaluate(`document.querySelector('#disclaimer-modal [data-close]').click()`);
await waitFor(`!(${modalOpen()})`, 'dialog closes on Close');
check(!(await evaluate(modalOpen())), 'Close button dismisses the disclaimer dialog');

console.log('\nDone.');
ws.close();
