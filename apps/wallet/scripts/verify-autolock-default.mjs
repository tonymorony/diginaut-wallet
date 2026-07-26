// The DEFAULT auto-lock must actually fire. Auto-lock is what drops the vault's
// AES session key and every plaintext mnemonic on an unattended device (spec
// §5: 5 minutes), and it was broken for every profile that had never opened the
// setting: the delay was read as Number(localStorage.getItem(key)), an absent
// key gives Number(null) === 0, and 0 is the "Never" setting. The select still
// displayed "5 minutes", so nothing on screen contradicted it.
//
// verify-wallet-mgmt.mjs cannot catch that: it writes a ladder value first, then
// reloads with the mock-only ?autolockSecs= hook, so it only ever exercises the
// explicitly-set path. This driver touches neither — empty localStorage, no
// query hook — and fast-forwards the real 5-minute timer with CDP virtual time
// instead of waiting it out.
//
// Self-contained except Chrome (mock wallet server starts here):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-autolock-default.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';
const PORT = 8883;
const app = spawn('node', [`${fileURLToPath(new URL('..', import.meta.url))}server.js`], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const APP = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { await fetch(`${APP}/api/config`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
let b;
for (const s of ['exit','SIGINT','SIGTERM','uncaughtException']) process.on(s, (e) => { app.kill(); b?.close(); if (e instanceof Error) { console.error(e); process.exit(1); } });
b = await connectCdp();
const { evaluate, waitFor, check, setVal, click } = b;
const vis = (id) => `document.getElementById('${id}').style.display !== 'none'`;

await b.navigate(APP);
await waitFor(vis('w-none'), 'no-wallet');
await setVal('w-create-pass', 'autolock default probe');
await setVal('w-create-pass2', 'autolock default probe');
await click('w-create');
await waitFor(vis('w-open'), 'open');
if (await evaluate(vis('w-backup-view'))) await click('w-backup-done');

check(await evaluate(`localStorage.getItem('diginaut.autolock') === null`),
  'profile has never touched the auto-lock setting (the shipped default path)');
check(await evaluate(`document.getElementById('w-autolock').value === '5'`),
  'the select shows 5 minutes');
const mins = await evaluate(`import('/autolock.js').then((m) => m.autolockMinutes(localStorage.getItem('diginaut.autolock')))`);
check(mins === 5, `the served module resolves an absent preference to ${mins} minutes`);

// fast-forward past 5 minutes of inactivity
await b.cdp('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 340_000 });
await waitFor(vis('w-locked'), 'wallet auto-locks on the default delay', 60_000);
check(true, 'the DEFAULT auto-lock fires — no setting touched, no query hook');
check(await evaluate(`document.getElementById('w-open').style.display === 'none'`), 'and the open view is torn down');
console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
