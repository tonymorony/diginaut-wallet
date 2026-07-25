// The oracle price and the chain status were fetched ONCE at boot and then
// presented as live for the rest of the session. Everything downstream trusted
// them: the header price, the fiat equivalents, the mint estimate, and — worst
// — usdToSats, which is the divisor a USD-denominated send is actually built
// from. The staleness gate that demotes USD entry ran once too, so a quote
// could go stale and nothing on screen would say so.
//
// What this drives, in the order the damage gets worse:
//   1. the header price follows the oracle mid-session at all
//   2. the "≈ … DGB" line under the amount follows it WITHOUT the user typing
//      — otherwise the fix trades a silently wrong amount for an amount that
//      contradicts the line printed directly beneath it
//   3. a quote going stale demotes USD entry mid-session
//   4. and that demotion disarms Max. A blanked amount field with sendMaxArmed
//      still true means the next Review plans a drain of the whole balance,
//      triggered by nothing but a timer.
//
// Timer compression: only the 55–65s band is squeezed, so the 60s polls fire in
// 300ms while the 5-minute auto-lock (300_000) and the 8s money poll are left
// exactly as they are. Compressing setTimeout wholesale would auto-lock the
// wallet out from under the driver.
//
// Self-contained except Chrome (wallet server + fake indexer start here):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-oracle-refresh.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const IDX_PORT = Number(process.env.IDX_PORT) || 8869;
const APP_PORT = Number(process.env.APP_PORT) || 8868;
const PASS = 'oracle refresh driver';
// Boot price and the price it moves to. Both exact so the DGB equivalents below
// are hand-computable: $1.00 = 1e6 µUSD, sats = 1e6 · 1e8 / µUSD-per-DGB.
const BOOT_MICRO = 13_420n;  // $0.01342/DGB — 1e14/13420 = 7_451_564_828 sats
const MOVED_MICRO = 3_400n;  // $0.0034/DGB  — 1e14/3400  = 29_411_764_705 sats
const BOOT_EQ = '≈ 74.51564828 DGB';
const MOVED_EQ = '≈ 294.11764705 DGB';

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
await fetch(`http://127.0.0.1:${IDX_PORT}/__reset`, { method: 'POST' });
const probe = await (await fetch(`http://127.0.0.1:${IDX_PORT}/api/address/dgb1qprobe/utxos`)).json();
if (probe.utxos?.length) throw new Error(`fake indexer on :${IDX_PORT} is not clean — kill the stray process`);

let b;
for (const s of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(s, (err) => { idx.kill(); app.kill(); b?.close(); if (err instanceof Error) { console.error(err); process.exit(1); } });
}
b = await connectCdp();
const { evaluate, waitFor, check, setVal, click, text, cdp } = b;
const vis = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const val = (id) => evaluate(`document.getElementById('${id}').value`);

// Installed BEFORE any navigation, so boot()'s very first getoracleprice is
// already driver-controlled — otherwise check 1 races the real mock price.
await cdp('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__oracle = { price_usd: 0.01342, price_micro_usd: '${BOOT_MICRO}', is_stale: false };
    window.__height = 1284512;
    (() => {
      const realFetch = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (url.endsWith('/api/rpc') && args[1]?.body) {
          const { method } = JSON.parse(args[1].body);
          const reply = (result) => new Response(JSON.stringify({ result }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
          if (method === 'getoracleprice') return reply(window.__oracle);
          if (method === 'getblockchaininfo') {
            // Pass through and patch only the height, so the CHAIN the wallet
            // derives addresses for stays whatever the server really says.
            const res = await realFetch(...args);
            const json = await res.json();
            if (json.result) json.result.blocks = window.__height;
            return reply(json.result);
          }
        }
        return realFetch(...args);
      };
      // Only the 60s poll band. 300_000 (auto-lock) and 8_000 (money poll) pass
      // through untouched — squeezing those breaks the driver, not the app.
      const realTimeout = window.setTimeout;
      window.setTimeout = (fn, d, ...rest) =>
        realTimeout(fn, (d >= 55_000 && d <= 65_000) ? 300 : d, ...rest);
    })();
  `,
});

await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(vis('w-open'), 'wallet open');
if (await evaluate(vis('w-backup-view'))) await click('w-backup-done');
await waitFor(`!document.getElementById('w-connect-modal').classList.contains('open')`, 'ceremony dismissed');
const addr = await evaluate(text('w-address'));
await fetch(`http://127.0.0.1:${IDX_PORT}/__fund`, {
  method: 'POST',
  body: JSON.stringify({ address: addr, utxos: [{ txid: 'e'.repeat(64), vout: 0, valueSats: '50000000000', height: 99_000 }] }),
}); // 500 DGB

await waitFor(`document.getElementById('o-price').textContent.startsWith('$0.01342')`, 'boot price on screen');
check(true, `header shows the boot oracle price: ${await evaluate(text('o-price'))}`);

// ---- USD entry priced at the BOOT rate ----
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send modal open');
await setVal('w-send-to', addr); // review reads this before any conversion
await click('w-send-ccy'); // DGB → USD
await setVal('w-send-amount', '1.00');
await waitFor(`document.getElementById('w-send-amount-eq').textContent === ${JSON.stringify(BOOT_EQ)}`,
  'the ≈-line prices $1.00 at the boot rate');
check(true, `$1.00 at $0.01342/DGB → ${await evaluate(text('w-send-amount-eq'))}`);

// ---- the rate moves, and NOBODY TOUCHES THE KEYBOARD ----
await evaluate(`window.__oracle = { price_usd: 0.0034, price_micro_usd: '${MOVED_MICRO}', is_stale: false }`);
await waitFor(`document.getElementById('o-price').textContent.startsWith('$0.0034')`,
  'the header price follows the oracle mid-session', 15_000);
check(true, `the poll picked up the new price: ${await evaluate(text('o-price'))}`);
// This is the check that forces the repaint into the poll. Without it the field
// still reads "$1.00 ≈ 74.5 DGB" while Review would build 294.1 DGB.
await waitFor(`document.getElementById('w-send-amount-eq').textContent === ${JSON.stringify(MOVED_EQ)}`,
  'the ≈-line follows the new rate with no typing', 15_000);
check(true, `same untouched "$1.00" now reads ${await evaluate(text('w-send-amount-eq'))}`);

// ---- chain status is polled too ----
await evaluate(`window.__height = 1284600`);
await waitFor(`document.getElementById('s-height').textContent === '1,284,600'`,
  'the chain height follows the node mid-session', 15_000);
check(true, `height moved without a reload: ${await evaluate(text('s-height'))}`);

// ---- Max, armed in USD, must not survive the price going stale ----
await click('w-send-max');
await waitFor(`document.getElementById('w-send-amount').value !== ''`, 'Max filled the amount');
check(await evaluate(`document.getElementById('w-send-ccy').disabled === false`),
  'Max armed while USD entry is still offered');
const armedAmount = await val('w-send-amount');

await evaluate(`window.__oracle = { price_usd: 0.0034, price_micro_usd: '${MOVED_MICRO}', is_stale: true }`);
await waitFor(`document.getElementById('w-send-ccy').disabled === true`,
  'a stale quote demotes USD entry mid-session', 15_000);
check(true, `stale quote demoted USD entry (Max had filled "${armedAmount}")`);
check((await evaluate(text('w-send-amount-label'))) === 'Amount (DGB)',
  'the field is relabelled, so the digits are not re-read in the other currency');
check((await evaluate(text('o-price'))).includes('(stale)'),
  'and the header says so out loud');
check((await val('w-send-amount')) === '',
  'the amount field is cleared rather than reinterpreted as DGB');

// The load-bearing one. A blank field with Max still armed sends everything.
await click('w-send-review');
await new Promise((r) => setTimeout(r, 600));
const reviewShown = await evaluate(`document.getElementById('w-send-confirm').style.display !== 'none'`);
const reviewAmount = await evaluate(text('w-send-c-amount'));
check(!reviewShown || !/^49[0-9]/.test(String(reviewAmount).replace(/,/g, '')),
  `Review on the cleared field does not plan a full-balance drain (confirm shown: ${reviewShown}, amount: "${reviewAmount}")`);
await b.shot('140-oracle-refresh-stale-demote.png');

console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
