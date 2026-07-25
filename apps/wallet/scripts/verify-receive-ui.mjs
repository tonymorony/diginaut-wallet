// Receive view: one key, two encodings. The DGB and DigiDollar forms are tabs
// with a QR each (Core and mobile wallets reject dgb1p… for a DigiDollar send,
// #72, so the DD form needs something scannable of its own), the address boxes
// carry an inline copy affordance, and the receive chain is browsable instead
// of being a single address with a "Next" button and no way back.
//
// The QR checks rebuild the expected SVG with the app's own encoder inside the
// page and compare byte for byte — #107's lesson (encode the address VERBATIM)
// applies to the new QR too, and a screenshot cannot catch a wrong payload.
//
// Self-contained except Chrome: fake indexer + wallet server start here.
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-receive-ui.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const IDX_PORT = Number(process.env.IDX_PORT) || 8889;
const APP_PORT = Number(process.env.APP_PORT) || 8888;
const PASS = 'receive ui driver';

const idx = spawn('node', [`${ROOT}scripts/fake-indexer.mjs`], {
  env: { ...process.env, PORT: String(IDX_PORT), TIP: '100000' }, stdio: 'ignore',
});
const app = spawn('node', [`${ROOT}server.js`], {
  env: { ...process.env, PORT: String(APP_PORT), INDEXER_URL: `http://127.0.0.1:${IDX_PORT}` }, stdio: 'ignore',
});
const APP = `http://127.0.0.1:${APP_PORT}`;
for (let i = 0; i < 100; i++) {
  try { await fetch(`${APP}/api/config`); await fetch(`http://127.0.0.1:${IDX_PORT}/api/address/x/utxos`); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}
// a stray fake indexer from a crashed run would serve that run's funding as chain truth
await fetch(`http://127.0.0.1:${IDX_PORT}/__reset`, { method: 'POST' });

let b;
for (const signal of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(signal, (err) => {
    idx.kill(); app.kill(); b?.close();
    if (err instanceof Error) { console.error(err); process.exit(1); }
  });
}

b = await connectCdp();
const { evaluate, waitFor, check, setVal, click, text } = b;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const shown = (id) => evaluate(`document.getElementById('${id}').getBoundingClientRect().height > 0`);

await b.cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 2, mobile: false });
await b.navigate(APP);
await waitFor(visible('w-none'), 'no-wallet state');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(visible('w-open'), 'wallet open');
await waitFor(visible('w-backup-view'), 'backup ceremony');
await click('w-backup-done');
await waitFor(`!document.getElementById('w-connect-modal').classList.contains('open')`, 'ceremony dismissed');

// the ceremony was skipped, so receive is intercepted — that guard is #92's, not ours
await click('act-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive modal');
if (await evaluate(visible('w-receive-guard'))) await click('w-receive-anyway');
await waitFor(`document.getElementById('w-address').textContent.startsWith('dgb')`, 'address rendered');

// ---- 1. opens on DGB, DigiDollar is a deliberate switch ----
check(await shown('rx-pane-dgb') && !(await shown('rx-pane-dd')), 'receive opens on the DGB form');
check(await evaluate(`document.getElementById('rx-tab-dgb').getAttribute('aria-selected') === 'true'`),
  'the DGB tab reports itself selected to assistive tech');

// Rebuild the expected QR with the app's own encoder, in the page. Both sides
// go through the DOM parser before comparing: innerHTML re-serializes what was
// parsed (self-closing tags, attribute quoting), so raw string vs innerHTML
// would differ on markup shape rather than on the payload under test.
const qrMatches = (elId, addrId, label) => evaluate(`(async () => {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(document.getElementById('${addrId}').textContent, 'Byte');
  qr.make();
  const oracle = document.createElement('div');
  oracle.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  return oracle.innerHTML === document.getElementById('${elId}').innerHTML;
})()`).then((ok) => check(ok, label));

await qrMatches('w-qr', 'w-address', 'the DGB QR encodes the bech32m address verbatim');
const dgbQr = await evaluate(`document.getElementById('w-qr').innerHTML`);
await b.shot('120-receive-dgb-tab.png');

// ---- 2. the DigiDollar form has its own QR of the DD… address ----
await click('rx-tab-dd');
check(await shown('rx-pane-dd') && !(await shown('rx-pane-dgb')), 'switching to DigiDollar swaps the pane');
const ddAddr = await evaluate(text('w-dd-address'));
check(/^[DTR]D[1-9A-HJ-NP-Za-km-z]{40,}$/.test(ddAddr), `the DigiDollar pane shows the base58check form: ${ddAddr.slice(0, 14)}…`);
await qrMatches('w-dd-qr', 'w-dd-address', 'the DigiDollar QR encodes the DD… address verbatim');
check((await evaluate(`document.getElementById('w-dd-qr').innerHTML`)) !== dgbQr,
  'the two forms really are two different QRs, not one reused');
check(!(await shown('w-req-amount')),
  'no amount field on the DigiDollar form — senddigidollar takes an address, not a URI');
await b.shot('121-receive-dd-tab.png');

// ---- 3. inline copy affordance ----
await evaluate(`{ window.__copied = null;
  navigator.clipboard.writeText = async (t) => { window.__copied = t; }; }`);
await click('w-copy-dd-icon');
await waitFor(`window.__copied`, 'clipboard write');
check(await evaluate(`window.__copied`) === ddAddr, 'the icon copies the DigiDollar address');
check(await evaluate(`document.getElementById('w-copy-dd-icon').classList.contains('copied')`),
  'and confirms it on the button, not just in the clipboard');
check(await evaluate(`document.getElementById('w-copy-dd-icon').getAttribute('aria-label') === 'Copied'`),
  'the confirmation reaches assistive tech too');

// ---- 4. the receive chain is browsable ----
await click('rx-tab-dgb');
const addr0 = await evaluate(text('w-address'));
check(!(await shown('w-prev-list')), 'the address list starts collapsed');
await click('w-next');
await new Promise((r) => setTimeout(r, 300));
await click('w-next');
await waitFor(`document.getElementById('w-path').textContent.endsWith('/2')`, 'walked to index 2');
const addr2 = await evaluate(text('w-address'));
await click('w-prev-toggle');
await waitFor(`document.querySelectorAll('#w-prev-list .rx-row').length === 3`, 'three handed-out addresses listed');
check(true, 'the list holds every index handed out so far (#2, #1, #0)');
check(await evaluate(`document.querySelector('#w-prev-list .rx-row .rx-tag').classList.contains('now')`),
  'the address on display is marked as such');
check(await evaluate(`[...document.querySelectorAll('#w-prev-list .rx-row')][2].textContent.includes('${addr0.slice(0, 14)}')`),
  'and the oldest row is address #0, still recoverable after two "Next" taps');

// a payment to the OLD address marks it, from the poll's own data
await fetch(`http://127.0.0.1:${IDX_PORT}/__fund`, {
  method: 'POST',
  body: JSON.stringify({ address: addr0, utxos: [{ txid: 'c'.repeat(64), vout: 0, valueSats: '4200000000', height: 99_000 }] }),
});
await waitFor(`[...document.querySelectorAll('#w-prev-list .rx-row')].at(-1).textContent.includes('received')`,
  'the paid address gets its marker', 30_000);
check(true, 'an address that has been paid says so — which one did they use, answered');
check(await evaluate(`[...document.querySelectorAll('#w-prev-list .rx-row')][1].textContent.includes('unused')`),
  'an untouched handout is marked unused, not silently blank');
await b.shot('122-receive-address-list.png');

// copying from a row copies THAT address, not the one on display
await evaluate(`window.__copied = null`);
await evaluate(`[...document.querySelectorAll('#w-prev-list .rx-row')].at(-1).querySelector('.icon-btn').click()`);
await waitFor(`window.__copied`, 'row clipboard write');
check(await evaluate(`window.__copied`) === addr0, 'a row copies its own address, not the current one');

// the list must speak the form the tab is on, or a copied row is the wrong
// address for the payer the user is talking to
await click('rx-tab-dd');
await waitFor(`document.querySelector('#w-prev-list .rx-row .rx-addr').textContent.startsWith('TD')`,
  'the list re-encodes with the tab');
check(true, 'on the DigiDollar tab the list shows DD… addresses');
await evaluate(`window.__copied = null`);
await evaluate(`[...document.querySelectorAll('#w-prev-list .rx-row')].at(-1).querySelector('.icon-btn').click()`);
await waitFor(`window.__copied`, 'row clipboard write (DD form)');
const copiedDD = await evaluate(`window.__copied`);
check(/^TD[1-9A-HJ-NP-Za-km-z]{40,}$/.test(copiedDD) && copiedDD !== addr0,
  'and copies the DigiDollar form of that same key, not the dgb1p… one');
await click('rx-tab-dgb');

// ---- 5. every open starts from the same place ----
await evaluate(`document.querySelector('#receive-modal [data-close]').click()`);
await click('act-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive reopened');
// the backup guard fires on EVERY open until the quiz passes (#92) — that
// interception sits in front of the body being asserted on here
if (await evaluate(visible('w-receive-guard'))) await click('w-receive-anyway');
check(await shown('rx-pane-dgb') && !(await shown('rx-pane-dd')) && !(await shown('w-prev-list')),
  'reopening resets to the DGB form with the list collapsed');
check((await evaluate(text('w-address'))) === addr2, 'and keeps the address the wallet is actually on');

console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
