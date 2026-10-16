// A wallet must not lose sight of an address it handed out. Before the receive
// counter existed, wallet.index reset to 0 on every open and watchedDerivations
// only covers index…index+2 — so a coin received at index 3 vanished from the
// balance (and from the spendable set) after a reload.
//
// Two independent memories, one driver:
//   A. the vault counter — this device remembers a handout nobody has paid yet
//   B. the chain scan    — a seed restored where no counter exists (another
//                          device, an erased vault) re-finds its funded indices
//
// Self-contained except Chrome: fake indexer + wallet server are started here.
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-receive-index.mjs   # exit 0 = all green
// A FRESH user-data-dir per run is required (IndexedDB carries the vault).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDX_PORT = Number(process.env.IDX_PORT) || 8899;
const APP_PORT = Number(process.env.APP_PORT) || 8898;
const PASS = 'receive index driver';
// BIP39 vector #3 — restored verbatim in part B, so both halves share a chain
const MNEMONIC = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
// Past the gap-free window (watched = 0…2 at index 0) AND past the first scan
// batch (RECEIVE_SCAN_BATCH = 5), so part B's scan can only succeed by
// continuing into a second batch — the loop's gap accumulation has to work.
const HANDOUT = 6;
const DEEP = 13; // second funded index, five unused indices below it (7…12)

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
// A crashed earlier run leaves its fake indexer holding this port — the new one
// then fails to bind (silently, stdio:'ignore') and this run reads the previous
// run's funding as if it were the chain. Wipe the state we're about to assert on
// and prove the wipe took, so a stale process can never masquerade as a pass.
await fetch(`http://127.0.0.1:${IDX_PORT}/__reset`, { method: 'POST' });
const stale = await (await fetch(`http://127.0.0.1:${IDX_PORT}/api/address/dgb1qprobe/utxos`)).json();
if (stale.utxos?.length) throw new Error(`fake indexer on :${IDX_PORT} is not clean — kill the stray process`);
const fund = (address, valueSats, txid) => fetch(`http://127.0.0.1:${IDX_PORT}/__fund`, {
  method: 'POST',
  body: JSON.stringify({ address, utxos: [{ txid, vout: 0, valueSats, height: 99_000 }] }),
});

// Whatever happens below — a failed check, a timeout, a thrown driver bug — the
// two servers die with this process. A survivor would poison the NEXT run.
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
const balance = () => evaluate(text('w-balance'));

await b.navigate(APP);
await waitFor(visible('w-none'), 'no-wallet state');

// ---- restore the shared seed, skip nothing: this is the normal open path ----
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC);
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-restore-go');
await waitFor(visible('w-open'), 'wallet open');

// ---- A. hand out index 3, pay it only AFTER a reload ----
await click('act-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive modal');
// Index 0's address, captured before any handout — part B asserts the restored
// wallet's scan PROBES it, which only a walk starting at 0 does.
const indexZeroAddr = await evaluate(text('w-address'));
for (let i = 0; i < HANDOUT; i++) {
  await click('w-next');
  await new Promise((r) => setTimeout(r, 200));
}
const handedOut = await evaluate(text('w-address'));
const handedPath = await evaluate(text('w-path'));
check(handedPath.endsWith(`/${HANDOUT}`), `handed out ${handedPath} → ${handedOut.slice(0, 16)}…`);
await evaluate(`document.querySelector('#receive-modal [data-close]').click()`);

// The counter is written asynchronously (best effort — see rememberReceiveIndex).
// Read it straight out of IndexedDB rather than reloading on a guess: the point
// under test is that it LANDS, and a reload mid-write would test the timing.
const storedIndex = () => evaluate(`new Promise((resolve) => {
  const req = indexedDB.open('dd-wallet', 1);
  req.onsuccess = () => {
    const get = req.result.transaction('keystore', 'readonly').objectStore('keystore').get('vault');
    get.onsuccess = () => resolve(get.result?.meta?.wallets?.[0]?.receiveIndex ?? null);
    get.onerror = () => resolve(null);
  };
  req.onerror = () => resolve(null);
})`);
let landed = null;
for (let i = 0; i < 40 && landed !== HANDOUT; i++) {
  landed = await storedIndex();
  if (landed !== HANDOUT) await new Promise((r) => setTimeout(r, 250));
}
check(landed === HANDOUT, `the vault remembers the handout: receiveIndex=${landed}`);

await b.navigate(APP); // reload: in-memory index gone, only the vault counter survives
// wait for the LOCKED state, not just the field: the unlock button exists from
// the first paint, and clicking it before the vault has loaded does nothing
await waitFor(visible('w-locked'), 'locked after reload');
await setVal('w-unlock-pass', PASS);
await click('w-unlock');
await waitFor(visible('w-open'), 'wallet open after unlock');
check((await evaluate(text('w-path'))).endsWith(`/${HANDOUT}`),
  `unlock reopens on the handed-out address, not index 0 (${await evaluate(text('w-path'))})`);

// the payer finally pays — an address handed out in a session that has ended
await fund(handedOut, '123400000000', 'a'.repeat(64));
await waitFor(`!['—', '0'].includes(document.getElementById('w-balance').textContent)`, 'payment lands', 30_000);
check((await balance()).startsWith('1,234'), `a payment to the handed-out address is seen: ${await balance()} DGB`);
// The address on screen was just paid, so the money poll must re-arm the scan
// and move the handout counter past it — WITHOUT a reload. Nothing else pins
// the re-arm: an inert one leaves the balance check above green.
await waitFor(`document.getElementById('w-path').textContent.endsWith('/' + ${HANDOUT + 1})`,
  'the money poll re-arms the scan when the shown address is paid', 30_000);
check(true, `the shown address rotates mid-session: ${await evaluate(text('w-path'))}`);
await b.shot('110-receive-index-remembered.png');

// ---- B. erase the vault (counter and all), restore the same seed ----
await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(visible('w-erase-view'), 'erase ceremony');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(visible('w-none'), 'vault erased');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC);
await setVal('w-create-pass', 'a different password entirely');
await setVal('w-create-pass2', 'a different password entirely');
const reqMark = (await (await fetch(`http://127.0.0.1:${IDX_PORT}/__requests`)).json()).requests.length;
await click('w-restore-go');
await waitFor(visible('w-open'), 'restored wallet open');

// Nothing on this device knows about index 3; only the chain does. Wait on the
// PATH, not the balance: w-balance still holds the pre-erase figure (the money
// grid is hidden on teardown, not blanked), so a balance wait passes on stale
// text before the scan has run.
// The scan lands ONE PAST the deepest index the chain has seen: index 6 was
// already paid, so re-offering it would reuse an address for nothing.
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${HANDOUT + 1}')`, 'chain scan advances the index', 30_000);
check(true, `the chain scan re-finds the funded index and offers the NEXT one → ${await evaluate(text('w-path'))}`);
// "No counter to read" is asserted by PROVENANCE, not by racing the scan for a
// momentary '/0' in the UI (that read is only true until the walk finishes — a
// quiet machine loses it). If the erased counter had leaked, the warm-start walk
// would begin at the counter and index 0 would never be probed; a fresh walk
// must probe it. The fake's request log makes that deterministic.
const sinceRestore = (await (await fetch(`http://127.0.0.1:${IDX_PORT}/__requests`)).json()).requests.slice(reqMark);
check(sinceRestore.some((u) => u.includes(`/${indexZeroAddr}/`) && u.endsWith('/history')),
  'a restored wallet walks from index 0 — no counter survived the erase (index-0 address probed)');
// And this is what makes that free: watchedDerivations counts from 0, so the
// already-paid index 6 is still inside the window and its coins still count.
await waitFor(`document.getElementById('w-balance').textContent.startsWith('1,234')`, 'balance recounts the funds', 30_000);
check(true, `and the funds at the PREVIOUS index are still watched: ${await balance()} DGB`);
await b.shot('111-receive-index-rediscovered.png');

// ---- C. a run of unused indices must not stop the scan short ----
// Walk to a deeper index and fund THAT, leaving 7…12 unused. Then erase and
// restore again: only a scan that keeps walking past a gap can find index 13.
// (Funding it and watching the balance would prove nothing — watchedDerivations
// is cumulative from 0, so the open wallet already covers it. The rediscovery
// is the whole point, so the driver has to force one.)
const deep = await evaluate(`(async () => {
  const el = document.getElementById('w-address');
  for (let i = 0; i < ${DEEP - (HANDOUT + 1)}; i++) { document.getElementById('w-next').click(); await new Promise((r) => setTimeout(r, 60)); }
  return el.textContent;
})()`);
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${DEEP}')`, `walked to index ${DEEP}`);
await fund(deep, '5000000000', 'b'.repeat(64));

await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(visible('w-erase-view'), 'erase ceremony (second)');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(visible('w-none'), 'vault erased (second)');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC);
await setVal('w-create-pass', 'a third password for the third vault');
await setVal('w-create-pass2', 'a third password for the third vault');
await click('w-restore-go');
await waitFor(visible('w-open'), 'restored wallet open (second)');
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${DEEP + 1}')`,
  'scan crosses the unused run', 30_000);
check(true, `the scan walked past unused ${HANDOUT + 1}…${DEEP - 1} to the funded index ${DEEP}, and offers ${DEEP + 1}`);
await waitFor(`document.getElementById('w-balance').textContent.startsWith('1,284')`, 'both funded indices counted', 30_000);
check(true, `and both funded indices are in the balance: ${await balance()} DGB`);
await b.shot('112-receive-index-gap-crossed.png');

// ---- D. one indexer hiccup must not end rediscovery for the session ----
// The scan used to mark its generation as scanned BEFORE the I/O and swallow
// the error, so a single indexer failure retired receive rediscovery until the
// wallet was re-opened — a restored wallet showing a confidently wrong balance
// with no retry. Fund a THIRD index first, so the number this part waits for
// has never been on screen: a balance assertion on 1,284 would pass instantly
// on part C's leftover text (teardown hides the money grid, it does not blank it).
const THIRD = 17;
const third = await evaluate(`(async () => {
  const el = document.getElementById('w-address');
  for (let i = 0; i < ${THIRD - (DEEP + 1)}; i++) { document.getElementById('w-next').click(); await new Promise((r) => setTimeout(r, 60)); }
  return el.textContent;
})()`);
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${THIRD}')`, `walked to index ${THIRD}`);
await fund(third, '10000000000', 'c'.repeat(64)); // 100 DGB → total 1,384

const setFail = (on) => fetch(`http://127.0.0.1:${IDX_PORT}/__fail`, {
  method: 'POST', body: JSON.stringify({ on }),
});

await setFail(true);
await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(visible('w-erase-view'), 'erase ceremony (third)');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(visible('w-none'), 'vault erased (third)');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC);
await setVal('w-create-pass', 'a fourth password for the fourth vault');
await setVal('w-create-pass2', 'a fourth password for the fourth vault');
await click('w-restore-go');
await waitFor(visible('w-open'), 'restored wallet open (third)');
// Taken while the indexer is still refusing — this is the load-bearing
// precondition. If the scan had somehow already succeeded, the rest proves nothing.
await new Promise((r) => setTimeout(r, 1500));
check((await evaluate(text('w-path'))).endsWith('/0'),
  'with the indexer down the restored wallet is stuck at index 0, as it must be');

// Recovery: no reload, no re-unlock, nothing but the indexer coming back. Only
// a retry inside the running session can move this.
await setFail(false);
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${THIRD + 1}')`,
  'the scan RETRIES after the outage clears', 30_000);
check(true, `the scan retried on its own and found index ${THIRD} → ${await evaluate(text('w-path'))}`);
await waitFor(`document.getElementById('w-balance').textContent.startsWith('1,384')`,
  'balance reflects all three funded indices', 30_000);
check(true, `and all three funded indices are counted: ${await balance()} DGB`);
await b.shot('113-receive-index-retry-after-outage.png');

console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
