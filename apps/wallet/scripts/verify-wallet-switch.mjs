// Switching wallets stops the money poll, but it cannot cancel one already in
// flight. refreshMoney guarded only `!wallet.seed`, which catches a LOCK (the
// seed is nulled) and misses a SWITCH entirely — openWallet replaces the seed
// rather than nulling it, so the outgoing wallet's answer sails through and
// paints its balance, history, positions and DD total onto the wallet the user
// is now looking at.
//
// Two directions, because they fail differently:
//   A. funded wallet's poll lands on the empty wallet → a balance that is not
//      yours, and an Activity list of somebody else's transactions
//   B. the same, then open the REMOVE ceremony — whose warning text is built
//      from lastConfirmedDgb, the value that poll just wrote. "This wallet
//      holds no funds the indexer can see" on a wallet that holds 5,000 DGB is
//      a destructive confirmation screen arguing for the destruction.
//
// The gate below holds the indexer responses instead of racing them, so the
// interleaving under test happens every run rather than on an unlucky one.
//
// Self-contained except Chrome (wallet server + fake indexer start here):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-wallet-switch.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const IDX_PORT = Number(process.env.IDX_PORT) || 8867;
const APP_PORT = Number(process.env.APP_PORT) || 8866;
const PASS = 'wallet switch driver';
const A_TXID = 'a'.repeat(64); // recognisable in the Activity list

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
// A survivor from a crashed run would serve ITS funding as chain truth here.
await fetch(`http://127.0.0.1:${IDX_PORT}/__reset`, { method: 'POST' });
const probe = await (await fetch(`http://127.0.0.1:${IDX_PORT}/api/address/dgb1qprobe/utxos`)).json();
if (probe.utxos?.length) throw new Error(`fake indexer on :${IDX_PORT} is not clean — kill the stray process`);

let b;
for (const s of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException']) {
  process.on(s, (err) => { idx.kill(); app.kill(); b?.close(); if (err instanceof Error) { console.error(err); process.exit(1); } });
}
b = await connectCdp();
const { evaluate, waitFor, check, setVal, click, text } = b;
const vis = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const modalOpen = (id) => `document.getElementById('${id}').classList.contains('open')`;
const fund = (address, sats, txid) => fetch(`http://127.0.0.1:${IDX_PORT}/__fund`, {
  method: 'POST', body: JSON.stringify({ address, utxos: [{ txid, vout: 0, valueSats: sats, height: 99_000 }] }),
});

// Park every indexer response until released. Installed AFTER wallet A is
// already painted, so it only ever holds the poll we care about.
const installGate = () => evaluate(`(() => {
  window.__held = [];
  window.__stall = true;
  const real = window.fetch;
  window.fetch = (...args) => {
    const url = String(args[0]);
    if (window.__stall && url.includes('/api/indexer/')) {
      return new Promise((resolve) => window.__held.push(() => resolve(real(...args))));
    }
    return real(...args);
  };
  return true;
})()`);

await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet');

// ---- wallet A: funded ----
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(vis('w-open'), 'wallet A open');
if (await evaluate(vis('w-backup-view'))) await click('w-backup-done');
await waitFor(`!${modalOpen('w-connect-modal')}`, 'ceremony dismissed');
const addrA = await evaluate(text('w-address'));
await fund(addrA, '500000000000', A_TXID); // 5,000 DGB
await waitFor(`document.getElementById('w-balance').textContent === '5,000'`, 'wallet A shows its balance', 20_000);
check(true, `wallet A funded and painted: ${await evaluate(text('w-balance'))} DGB`);

// ---- park wallet A's next poll mid-flight ----
await installGate();
// (wallet.index 0 → 3 derivations) × 2 address forms = 6 reads per poll
await waitFor(`window.__held.length >= 6`, 'wallet A has a poll in flight', 20_000);
check(true, `wallet A's poll is parked mid-flight (${await evaluate('window.__held.length')} reads held)`);

// Released BEFORE the switch, deliberately. Leaving the gate closed across the
// switch would park wallet B's own first poll too, and B would then be the LAST
// painter — the assertions below would pass with the bug fully present.
await evaluate(`window.__stall = false`);

// ---- wallet B: empty ----
await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'wallet switcher opens');
await click('w-add-wallet');
await waitFor(modalOpen('w-connect-modal'), 'add-wallet reuses the connect modal');
await click('w-create-choice');
await click('w-create');
await waitFor(vis('w-backup-view'), 'ceremony for wallet B');
await click('w-backup-done');
await waitFor(`!${modalOpen('w-connect-modal')}`, 'ceremony dismissed for wallet B');
await waitFor(`${text('w-address')} !== ${JSON.stringify(addrA)}`, 'wallet B derives its own address');
await waitFor(`document.getElementById('w-balance').textContent === '0'`, 'wallet B shows its own empty balance', 20_000);

// ---- release wallet A's poll onto wallet B ----
const released = await evaluate(`(() => { const n = window.__held.length; window.__held.splice(0).forEach((f) => f()); return n; })()`);
await new Promise((r) => setTimeout(r, 800)); // continuation is single-digit ms; B's own repoll is 8s out
check(released > 0, `released ${released} held reads belonging to wallet A onto wallet B`);

check((await evaluate(text('w-balance'))) === '0',
  "wallet A's late poll does not paint its balance onto wallet B");
check(!(await evaluate(`document.getElementById('w-history').innerHTML`)).includes(A_TXID.slice(0, 12)),
  "and none of wallet A's transactions appear in wallet B's Activity");
await b.shot('130-wallet-switch-no-crosstalk.png');

// ---- the destructive direction: the remove ceremony reads the same value ----
// Park empty wallet B's poll, switch to funded wallet A, release B's answer
// onto A, then open the ceremony that asks whether to delete A.
await installGate();
await waitFor(`window.__held.length >= 6`, 'wallet B has a poll in flight', 20_000);
await evaluate(`window.__stall = false`);
await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'switcher open again');
await evaluate(`document.querySelector('#w-wallet-list [data-switch]').click()`); // first row = wallet A
await waitFor(`${text('w-address')} === ${JSON.stringify(addrA)}`, 'switched back to wallet A');
await waitFor(`document.getElementById('w-balance').textContent === '5,000'`, 'wallet A repainted', 20_000);
await evaluate(`(() => { window.__held.splice(0).forEach((f) => f()); return true; })()`);
await new Promise((r) => setTimeout(r, 800));
check((await evaluate(text('w-balance'))) === '5,000',
  "the empty wallet's late poll does not blank the funded wallet's balance");

await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'switcher open for manage');
await evaluate(`document.querySelectorAll('#w-wallet-list [data-manage]')[0].click()`);
await waitFor(`document.getElementById('w-remove-open') !== null`, 'manage row expanded for wallet A');
await click('w-remove-open');
await waitFor(vis('w-remove-view'), 'remove ceremony shown for wallet A');
const warnings = await evaluate(`document.getElementById('w-remove-warnings').innerHTML`);
check(warnings.includes('holds 5,000 DGB'),
  'the remove ceremony for wallet A reports the funds it actually holds');
check(!warnings.includes('holds no funds the indexer can see'),
  "and does not argue for its own destruction with the empty wallet's balance");
await b.shot('131-wallet-switch-remove-ceremony.png');

console.log(process.exitCode ? '\nRED' : '\nall green');
// Explicit, like the other drivers: the spawned indexer and wallet server are
// live handles, so without this the process sits there green forever and the
// CI job hangs instead of failing. (Found the hard way, on this driver.)
process.exit(process.exitCode || 0);
