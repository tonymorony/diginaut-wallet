// LIVE mainnet readiness (#59 groundwork): a NO-FUNDS smoke against the
// DEPLOYED mainnet stack. Everything here is read-only or local-key-only —
// no faucet exists on mainnet and this driver never funds anything. It proves:
//   1. HTTP: /api/config is live-mainnet-shaped (mock=false, NO faucet,
//      indexer wired, chain pinned to "main") and the RPC proxy answers
//      getblockchaininfo on "main" (waits up to 3 min for a warming node).
//   2. Browser: RED mainnet banner + MAINNET pill, and the one-time BLOCKING
//      mainnet acknowledgment interstitial appears and can be accepted.
//   3. A THROWAWAY wallet (keys client-side only, zero funds): the v2 backup
//      ceremony overlays create (blur + Tap to reveal) and on mainnet is
//      SEALED (#C3) — no "Remind me later", no Close; "Not backed up" badge
//      shows until the quiz is passed (which happens after step 4).
//   4. Receive: dgb1p… mainnet address on m/86'/20'/0'/0/0, DD… interop
//      address, and the backup interception fires on the unbacked wallet.
//   5. Beta posture, fund-free: mint UI surfaces the $100 consensus floor
//      and the $500/tx beta cap; the send modal's DD-transfer leg surfaces
//      the cap too (a DGB-send cap check needs funds — later, HITL).
//   6. Erase via the type-ERASE ceremony — leaves no keystore state behind.
//
// Receive/send WITH funds is deliberately out of scope (later, human-in-the-
// loop). Setup — Chrome only, no local server (this drives the LIVE URL):
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-mainnet-live.mjs [url]   # exit 0 = all green
// A FRESH user-data-dir per run is REQUIRED: it gives a fresh IndexedDB (no
// wallet) and fresh localStorage (the one-time interstitial must appear).
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';

const APP = (process.argv[2] || 'https://diginaut.ludere.space').replace(/\/$/, '');
const OUT = fileURLToPath(new URL('.', import.meta.url));
const RPC_WARMUP_MS = 3 * 60_000; // node may still be verifying blocks (-28)
const PASS = 'mainnet live smoke';

// ---- HTTP helpers (verify-dual-public.mjs pattern) ----
const getJson = async (path) => {
  const res = await fetch(APP + path, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rpc = (method) =>
  fetch(APP + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: [] }),
    signal: AbortSignal.timeout(20_000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

// ================= 1. HTTP: live mainnet config + RPC proxy =================
console.log(`— LIVE mainnet readiness: ${APP}`);
const cfg = await getJson('/api/config');
check(cfg.status === 200, '/api/config answers');
check(cfg.body?.mock === false, 'live node, not mock');
check(cfg.body?.faucet === false, 'NO faucet on mainnet (there is none to have)');
check(cfg.body?.indexer === true, 'indexer wired in config');
// exercise the wallet→indexer→ElectrumX chain, not just the config flag
// (verify-dual-public pattern): the probe txid doesn't exist, so an electrum/
// daemon error body means the trio answered end-to-end, while a transport
// error (ECONNREFUSED/timeout) means a link in the trio is down.
{
  const idx = await getJson(`/api/indexer/tx/${'0'.repeat(64)}`);
  const idxErr = String(idx.body?.error ?? '');
  const transportDown = /econnrefused|etimedout|unreachable|socket/i.test(idxErr);
  const answered = (idx.status < 500 || /daemon error|no such|not found/i.test(idxErr)) && !transportDown;
  check(answered, answered
    ? `indexer chain answers end-to-end (status ${idx.status})`
    : `indexer chain NOT READY: ${idxErr || `status ${idx.status}`} — ElectrumX link down/still syncing; deployment-not-ready, not a wallet bug`);
}
check(cfg.body?.expectedChain === 'main' && cfg.body?.chain === 'main' && cfg.body?.chainMismatch === false,
  `chain pinned and reported "main", no cross-wire (expected ${cfg.body?.expectedChain}, got ${cfg.body?.chain})`);

// getblockchaininfo through the proxy — tolerate a warming node (-28 /
// "Loading…"/"Verifying…" / transient 5xx) for up to 3 minutes, and say
// clearly how long the wait was. A node still warming after that is a
// deployment-not-ready condition, reported as such — the check is not weakened.
let info = null;
let warmupNote = '';
{
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < RPC_WARMUP_MS) {
    const r = await rpc('getblockchaininfo').catch((e) => ({ status: 0, body: { error: String(e) } }));
    if (r.status === 200 && r.body?.result?.chain) { info = r.body.result; break; }
    last = `status ${r.status}, ${JSON.stringify(r.body?.error ?? r.body).slice(0, 120)}`;
    const warming = r.status >= 500 || /-28|loading|warming|verifying|starting/i.test(last);
    if (!warming) break; // a hard error is not warm-up — fail now, loudly
    warmupNote = ` (waited ${Math.round((Date.now() - t0) / 1000)}s for RPC warm-up)`;
    await new Promise((res) => setTimeout(res, 5000));
  }
  if (info) {
    check(info.chain === 'main', `rpc proxy: getblockchaininfo on "main", height ${info.blocks}${warmupNote}`);
  } else {
    check(false, `rpc proxy NOT READY after ${Math.round(RPC_WARMUP_MS / 60000)} min — node still warming up or down (${last}). Deployment-not-ready, not a wallet bug.`);
  }
}
// DD activation state — pre-activation the mint modal refuses before it can
// show the floor/cap copy; fetched here so those checks can say so crisply.
const dep = (await rpc('getdeploymentinfo').catch(() => null))?.body?.result?.deployments?.digidollar;
const ddActive = dep?.active === true;
const ddStatus = dep ? `${dep.bip9?.status ?? (dep.active ? 'active' : '?')}${dep.bip9?.since ? ` since ${dep.bip9.since}` : ''}` : 'unknown';

// ================= 2. Browser: banner, pill, blocking interstitial =================
const b = await connectCdp({ out: OUT });
const { evaluate, waitFor, shot, text, setVal, click } = b;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const modalOpen = (id) => `document.getElementById('${id}').classList.contains('open')`;
const grid = async (id) => (await evaluate(text(id))).trim().split(/\s+/).join(' ');

await b.navigate(APP);
await waitFor(modalOpen('mainnet-ack-modal'), 'mainnet interstitial on first load', 45_000);
check(true, 'one-time blocking mainnet interstitial appears on a fresh profile');
const ackBody = (await evaluate(`document.querySelector('#mainnet-ack-modal .modal').textContent`)).replace(/\s+/g, ' ');
check(/Real money ahead/.test(ackBody) && /real funds/.test(ackBody) && /\$500/.test(ackBody),
  'interstitial copy: "Real money ahead", real funds, $500 cap');
await shot('85-live-interstitial.png');
await click('mainnet-ack-continue');
await waitFor(`!(${modalOpen('mainnet-ack-modal')})`, 'interstitial accepted', 15_000);
check(await evaluate(`localStorage.getItem('diginaut-mainnet-ack') === '1'`), 'Continue accepts and persists the ack');

await waitFor(`!document.getElementById('net-banner').hidden`, 'banner renders', 30_000);
const banner = await evaluate(text('net-banner'));
check(/MAINNET BETA/.test(banner) && await evaluate(`document.getElementById('net-banner').classList.contains('danger')`),
  `RED mainnet banner: "${banner}"`);
check(await evaluate(`!document.getElementById('net-pill').hidden && ${text('net-pill')} === 'MAINNET' && document.getElementById('net-pill').classList.contains('danger')`),
  'MAINNET pill visible, danger-styled');

// ================= 3. Throwaway wallet + v2 backup ceremony =================
// Keys exist only in this fresh browser profile and are never funded — safe
// against the live page. Erased at the end.
await waitFor(visible('w-none'), 'no-wallet state', 15_000);
await click('hero-connect');
await waitFor(modalOpen('w-connect-modal'), 'connect modal', 15_000);
await click('w-create-choice');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(visible('w-open'), 'wallet open under the ceremony overlay', 20_000);
await waitFor(visible('w-backup-view'), 'v2 backup ceremony overlays create', 15_000);
check(await evaluate(`document.getElementById('w-backup-reveal').classList.contains('blurred')`),
  'ceremony starts blurred (decoys under the veil)');
const decoys = await grid('w-backup-words');
await click('w-backup-show');
const words = (await grid('w-backup-words')).split(' ');
check(words.length === 12 && words.join(' ') !== decoys, 'Tap to reveal swaps decoys for the real 12 words');
// #C3: on mainnet there is no skip and no close — the coins are real. The
// ceremony stays open over the already-open wallet; section 4 runs against the
// still-un-backed-up wallet underneath it, and the quiz is passed after that.
check(!(await evaluate(visible('w-backup-done'))), 'mainnet ceremony offers no "Remind me later" (#C3)');
check(await evaluate(`document.getElementById('w-modal-close').style.display === 'none'`),
  'and Close is not the skip in disguise — the create-time ceremony is sealed');
check(await evaluate(visible('w-backup-sealed')), 'the sealed ceremony says why, instead of showing a dead end');
check(await evaluate(visible('w-backup-badge')) && /Not backed up/.test(await evaluate(text('w-backup-badge'))),
  '"Not backed up" badge shows while the ceremony is unfinished');
await shot('86-live-sealed-ceremony.png');

// ================= 4. Receive: mainnet addresses + backup interception =================
await waitFor(`${text('w-address')}.startsWith('dgb1p')`, 'mainnet address derived', 20_000);
const addr = await evaluate(text('w-address'));
const path = await evaluate(text('w-path'));
check(/^dgb1p[a-z0-9]{50,}$/.test(addr), `receive address carries the mainnet HRP: ${addr.slice(0, 16)}…`);
check(path === "m/86'/20'/0'/0/0", `SLIP-44 coin type 20 path (${path})`);
const ddAddr = await evaluate(text('w-dd-address'));
check(/^DD[1-9A-HJ-NP-Za-km-z]{20,}$/.test(ddAddr), `DD… mainnet interop address shown: ${ddAddr.slice(0, 10)}…`);
await click('act-receive');
await waitFor(modalOpen('receive-modal'), 'receive modal', 15_000);
check(await evaluate(visible('w-receive-guard')) && !(await evaluate(visible('w-receive-body'))),
  'receive interception fires: back-up warning before the address (unbacked wallet)');
check(/not backed up/.test(await evaluate(text('w-receive-guard'))), 'interception copy names the missing backup');
await click('w-receive-anyway');
await waitFor(visible('w-receive-body'), 'Continue anyway shows the address', 10_000);
check((await evaluate(text('w-address'))) === addr, 'receive view shows the same dgb1p… address');
await shot('87-live-receive-guard.png');
await evaluate(`document.getElementById('receive-modal').classList.remove('open')`);

// ---- the sealed ceremony's only exit: pass the quiz (#C3) ----
// The seal removes the SKIP, not the flow. Done here, after the receive
// interception above has been proven against the still-un-backed-up wallet.
await click('w-backup-show');
const seedWords = (await grid('w-backup-words')).split(' ');
await click('w-backup-continue');
await waitFor(visible('w-quiz-view'), 'quiz step', 15_000);
await evaluate(`{ const words = ${JSON.stringify(seedWords)};
  const idxs = [...document.querySelectorAll('#w-quiz-slots .qn')].map((e) => Number(e.textContent.match(/\\d+/)[0]) - 1);
  for (const n of idxs) [...document.querySelectorAll('#w-quiz-chips [data-chip]')].find((c) => !c.disabled && c.textContent === words[n]).click(); }`);
await click('w-quiz-verify');
await waitFor(visible('w-backup-success'), 'quiz pass → success beat', 15_000);
check(await evaluate(visible('w-backup-file')), 'the success beat offers the encrypted backup file (#M1)');
await click('w-backup-file');
await waitFor(modalOpen('reauth-modal'), 're-auth gate on the ceremony backup-file download', 15_000);
check(true, 'the backup-file download is password-gated like the switcher export (#M1)');
await click('reauth-cancel');
await click('w-backup-success-done');
await waitFor(`!(${modalOpen('w-connect-modal')})`, 'ceremony closes on Done', 15_000);
check(!(await evaluate(visible('w-backup-badge'))), 'the quiz pass clears the "Not backed up" badge');

// ================= 5. Beta posture: $100 mint floor + $500/tx cap, fund-free =================
// Both mint checks trip validation BEFORE any oracle/funding gate, so a
// zero-fund wallet exercises the real copy. Pre-activation the softfork gate
// fires first — that is the deployment timeline, reported crisply, not a bug.
await click('act-mint');
await waitFor(modalOpen('mint-modal'), 'mint modal', 15_000);
await setVal('w-mint-amount', '50'); // below the $100 consensus floor
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.length > 0`, 'under-floor mint rejected', 20_000);
const floorErr = await evaluate(text('w-mint-err'));
if (!ddActive && /not active/.test(floorErr)) {
  check(false, `mint $100 floor copy NOT VERIFIABLE yet: DigiDollar softfork is "${ddStatus}" (height ${info?.blocks ?? '?'}) — deployment timeline, not a wallet bug. Error shown: "${floorErr.slice(0, 90)}"`);
  check(false, `mint $500 cap copy NOT VERIFIABLE yet for the same reason (softfork "${ddStatus}")`);
} else {
  check(/consensus minimum is \$100\.00/.test(floorErr), `mint UI surfaces the $100 consensus floor: "${floorErr.slice(0, 90)}"`);
  await setVal('w-mint-amount', '600'); // over the $500/tx beta cap
  await click('w-mint-review');
  await waitFor(`${text('w-mint-err')}.includes('$500')`, 'over-cap mint rejected', 20_000);
  const mintCapErr = await evaluate(text('w-mint-err'));
  check(/capped at \$500/.test(mintCapErr) && /beta/.test(mintCapErr), `mint UI surfaces the $500/tx beta cap: "${mintCapErr.slice(0, 90)}"`);
}
await shot('88-live-mint-posture.png');
await evaluate(`document.querySelector('#mint-modal [data-close]').click()`);

// send modal, DD-transfer leg: cap trips before any UTXO lookup → fund-free.
// (The DGB-send cap check runs after coin selection, so it needs funds — the
// banner's "$500/tx cap" and this transfer leg cover the send modal's copy.)
check(/\$500\/tx cap/.test(banner), 'banner surfaces the $500/tx cap over the send UI');
await click('act-send');
await waitFor(modalOpen('send-modal'), 'send modal', 15_000);
await evaluate(`{ const s = document.getElementById('send-asset'); s.value = 'dd'; s.dispatchEvent(new Event('change', { bubbles: true })); }`);
await setVal('w-tr-to', ddAddr);
await setVal('w-tr-amount', '600');
await click('w-tr-review');
await waitFor(`${text('w-tr-err')}.length > 0`, 'over-cap transfer rejected', 20_000);
const trErr = await evaluate(text('w-tr-err'));
check(/capped at \$500/.test(trErr), `send modal (DD transfer) surfaces the $500/tx beta cap: "${trErr.slice(0, 90)}"`);
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);

// ================= 6. Erase the throwaway via the type-ERASE ceremony =================
await click('w-lock');
await waitFor(visible('w-locked'), 'locked', 15_000);
await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(visible('w-erase-view'), 'erase ceremony', 15_000);
await setVal('w-erase-input', 'erase'); // wrong case must not arm the button
check(await evaluate(`document.getElementById('w-erase-go').disabled`), 'erase armed only by a typed ERASE (exact)');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(visible('w-none'), 'erased back to the guest hero', 15_000);
const left = await evaluate(`(async () => {
  const ks = await import('/keystore.js');
  const { vault, primary } = await ks.loadKeystoreAny();
  return { vault: !!vault, primary: !!primary };
})()`);
check(!left.vault && !left.primary, 'no keystore state left behind (vault and legacy record both gone)');

console.log(process.exitCode ? '\nFAILED' : '\nall green');
b.close();
process.exit(process.exitCode || 0);
