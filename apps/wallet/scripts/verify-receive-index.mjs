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
import { connectCdp } from './lib/cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const IDX_PORT = Number(process.env.IDX_PORT) || 8899;
const APP_PORT = Number(process.env.APP_PORT) || 8898;
const PASS = 'receive index driver';
// BIP39 vector #3 — restored verbatim in part B, so both halves share a chain
const MNEMONIC = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const HANDOUT = 3; // clicks past the gap-free window (watched = 0…2 at index 0)

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
await click('w-restore-go');
await waitFor(visible('w-open'), 'restored wallet open');
check(await evaluate(`document.getElementById('w-path').textContent.endsWith('/0')`),
  'a restored wallet starts at index 0 — it has no counter to read');

// Nothing on this device knows about index 3; only the chain does. Wait on the
// PATH, not the balance: w-balance still holds the pre-erase figure (the money
// grid is hidden on teardown, not blanked), so a balance wait passes on stale
// text before the scan has run.
await waitFor(`document.getElementById('w-path').textContent.endsWith('/${HANDOUT}')`, 'chain scan advances the index', 30_000);
check(true, `the chain scan re-finds the funded index → ${await evaluate(text('w-path'))}`);
await waitFor(`document.getElementById('w-balance').textContent.startsWith('1,234')`, 'balance recounts the funds', 30_000);
check(true, `and the funds are in the balance again: ${await balance()} DGB`);
await b.shot('111-receive-index-rediscovered.png');

// a gap must not stop the scan short of a funded index further down
const deep = await evaluate(`(async () => {
  const el = document.getElementById('w-address');
  for (let i = 0; i < 6; i++) { document.getElementById('w-next').click(); await new Promise((r) => setTimeout(r, 50)); }
  return el.textContent;
})()`);
await fund(deep, '5000000000', 'b'.repeat(64));
await waitFor(`document.getElementById('w-balance').textContent.startsWith('1,284')`, 'deep index counted', 30_000);
check(true, `an index ${HANDOUT + 6} deep is watched too: ${await balance()} DGB`);

console.log(process.exitCode ? '\nRED' : '\nall green');
process.exit(process.exitCode || 0);
