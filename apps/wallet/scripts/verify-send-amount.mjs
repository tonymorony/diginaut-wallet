// The send amount field is not self-describing: what the number MEANS depends
// on `sendCcy`, and whether it is a drain depends on `sendMaxArmed`. Both are
// out-of-band state, and both used to survive things that abandon a draft.
//
// Two ways that produced a wrong amount, both driven here:
//   A. sendCcy is sticky. Pay once in USD, then paste a merchant's BIP21
//      `?amount=200` — absorbSendUri wrote 200 into a field still read as USD,
//      so review priced $200 of DGB. At $0.0034/DGB that is ~59,000 DGB for a
//      200 DGB request.
//   B. sendMaxArmed was cleared only by typing or a successful broadcast.
//      Click Max, cancel, switch to another wallet, type a small amount and
//      Review — the max path re-planned a full drain of the NEW wallet.
//
// Self-contained except Chrome (wallet server + fake indexer start here):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-send-amount.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDX_PORT = Number(process.env.IDX_PORT) || 8877;
const APP_PORT = Number(process.env.APP_PORT) || 8876;
const PASS = 'send amount driver';

const idx = spawn('node', [`${ROOT}scripts/fake-indexer.mjs`], {
  env: { ...process.env, PORT: String(IDX_PORT), TIP: '1284512' }, stdio: 'ignore',
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

let b;
for (const s of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(s, (err) => { idx.kill(); app.kill(); b?.close(); if (err instanceof Error) { console.error(err); process.exit(1); } });
}
b = await connectCdp();
const { evaluate, waitFor, check, setVal, click, text } = b;
const vis = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const val = (id) => evaluate(`document.getElementById('${id}').value`);
const fund = (address, sats, txid) => fetch(`http://127.0.0.1:${IDX_PORT}/__fund`, {
  method: 'POST', body: JSON.stringify({ address, utxos: [{ txid, vout: 0, valueSats: sats, height: 99_000 }] }),
});

await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(vis('w-open'), 'wallet open');
if (await evaluate(vis('w-backup-view'))) await click('w-backup-done');
await waitFor(`!document.getElementById('w-connect-modal').classList.contains('open')`, 'ceremony dismissed');

// fund wallet A generously so a drain would be unmistakable
await click('act-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive');
if (await evaluate(vis('w-receive-guard'))) await click('w-receive-anyway');
await waitFor(`document.getElementById('w-address').textContent.startsWith('dgb')`, 'address');
const addrA = await evaluate(text('w-address'));
await evaluate(`document.querySelector('#receive-modal [data-close]').click()`);
await fund(addrA, '500000000000', 'a'.repeat(64)); // 5,000 DGB
await waitFor(`document.getElementById('w-balance').textContent.startsWith('5,000')`, 'wallet A funded', 30_000);

// ---- A. a BIP21 request must be read as DGB even when USD entry is sticky ----
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send modal');
const ccyUsable = !(await evaluate(`document.getElementById('w-send-ccy').disabled`));
check(ccyUsable, 'oracle price present, so USD entry is available (the sticky-state precondition)');
await click('w-send-ccy');
check((await evaluate(text('w-send-amount-label'))) === 'Amount (USD)', 'switched the field to USD, as a user paying $10 would');

await setVal('w-send-to', 'digibyte:' + addrA + '?amount=200&label=Coffee');
await waitFor(`document.getElementById('w-send-amount').value !== ''`, 'URI amount absorbed');
check((await val('w-send-amount')) === '200', `the requested amount is in the field: ${await val('w-send-amount')}`);
check((await evaluate(text('w-send-amount-label'))) === 'Amount (DGB)',
  'and the field now says DGB — a BIP21 amount is DGB by definition');
const eq = await evaluate(text('w-send-amount-eq'));
check(/DGB|\$/.test(eq) && !/^\s*$/.test(eq), `the ≈-line was refreshed, not left stale: "${eq}"`);

// review it: the plan must spend ~200 DGB, not $200 worth
await click('w-send-review');
await waitFor(`${vis('w-send-confirm')} || document.getElementById('w-send-err').textContent.length > 0`, 'review resolved');
const err = await evaluate(text('w-send-err'));
check(err === '', `review succeeded without error ${err ? '— got: ' + err : ''}`);
// read the amount cell itself — the concatenated modal text has no word
// boundary between the "Amount" label and the figure
const sentDgb = Number((await evaluate(text('w-send-c-amount'))).replace(/,/g, ''));
check(Math.abs(sentDgb - 200) < 0.001,
  `the confirm screen sends ${sentDgb} DGB — the requested 200, not $200 worth (~59,000 DGB)`);
await b.shot('140-send-bip21-currency.png');

// ---- B. "Max" must not survive an abandoned draft ----
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send reopened');
check((await val('w-send-amount')) === '', 'closing the modal cleared the abandoned amount');

await setVal('w-send-to', addrA);
await click('w-send-max');
await waitFor(`document.getElementById('w-send-amount').value !== ''`, 'max filled');
const maxed = await val('w-send-amount');
check(Number(maxed.replace(/,/g, '')) > 4000, `Max armed and filled the whole balance: ${maxed} DGB`);

// Abandon it and come back WITHOUT typing. Typing is not the test: the input
// listener disarms max, so a driver that types proves nothing about this bug.
// Review on the untouched form is the discriminator — armed max would re-plan a
// full drain the user never re-confirmed.
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send reopened again');
check((await val('w-send-amount')) === '', 'the armed max left no amount behind either');
await setVal('w-send-to', addrA);
await click('w-send-review');
await waitFor(`${vis('w-send-confirm')} || document.getElementById('w-send-err').textContent.length > 0`, 'review resolved');
const drained = await evaluate(`document.getElementById('w-send-confirm').style.display !== 'none'`);
const amountShown = Number((await evaluate(text('w-send-c-amount'))).replace(/,/g, '') || 0);
// the property is "no plan was made", not any particular wording
check(!drained && (await evaluate(text('w-send-err'))).length > 0,
  `an abandoned Max does not survive: review refused ("${await evaluate(text('w-send-err'))}") `
  + `instead of silently planning ${amountShown} DGB`);

// the same state must not survive a wallet teardown either — lock/unlock runs
// resetWalletState, the identical path a wallet switch takes
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send for the teardown case');
await setVal('w-send-to', addrA);
await click('w-send-max');
await waitFor(`document.getElementById('w-send-amount').value !== ''`, 'max armed again');
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);
await click('w-lock');
await waitFor(vis('w-locked'), 'locked');
await setVal('w-unlock-pass', PASS);
await click('w-unlock');
await waitFor(vis('w-open'), 'unlocked');
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send after unlock');
check((await val('w-send-amount')) === '',
  'a lock (same teardown a wallet switch runs) clears the armed amount too');

await b.shot('141-send-max-disarmed.png');

// ---- C. the stale-index warning tracks the indexer, in both directions (#H5) ----
// The fake indexer serves the mock node's own height, so every confirm screen
// above was silent — that is the fixture being honest, not the warning being
// dead. Move the tip under the driver to prove both edges. The row is written
// at REVIEW time from the retained poll state, so a tip move only reaches a
// review that happened after the 8s money poll saw it: re-review until it does,
// rather than sleeping a poll interval and hoping.
const NODE_BLOCKS = 1_284_512; // server.js mock getblockchaininfo `blocks`
const setTip = (tip) => fetch(`http://127.0.0.1:${IDX_PORT}/__tip`, {
  method: 'POST', body: JSON.stringify({ tip }),
});
async function reviewUntilStale(want, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    await setVal('w-send-to', addrA);
    await setVal('w-send-amount', '10');
    await click('w-send-review');
    await waitFor(`${vis('w-send-confirm')} || document.getElementById('w-send-err').textContent.length > 0`, 'review resolved');
    if ((await evaluate(vis('w-send-c-stale'))) === want || Date.now() - t0 > timeoutMs) return;
    await click('w-send-cancel'); // resetSend hides the row, so the next review re-renders it from scratch
    await new Promise((r) => setTimeout(r, 500));
  }
}

await setTip(NODE_BLOCKS - 1_000_000);
await reviewUntilStale(true);
check(await evaluate(vis('w-send-c-stale')),
  'an index 1,000,000 blocks behind the node warns on the send confirm screen');
const staleCopy = await evaluate(text('w-send-c-stale'));
check(/1,000,000\s+blocks\s+behind/.test(staleCopy),
  `and it names how far behind the index is, not just "stale": "${staleCopy}"`);
await b.shot('142-send-stale-index.png');

// and it is advisory state, not a one-way latch — a caught-up index clears it
await click('w-send-cancel');
await setTip(NODE_BLOCKS);
await reviewUntilStale(false);
check(!(await evaluate(vis('w-send-c-stale'))),
  'and the warning goes away once the index catches the node up');

console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
