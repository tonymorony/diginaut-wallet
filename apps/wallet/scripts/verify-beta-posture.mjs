// Beta posture UI (#63, spec = #54 resolution): drive the wallet against a
// MAINNET-shaped node (DD active) and prove all of it:
//   - one-time BLOCKING interstitial (Cancel keeps it blocked, Continue
//     persists the ack in localStorage and never shows it again),
//   - RED danger banner with the #54 copy + always-visible MAINNET pill
//     that floats when the topbar scrolls away,
//   - the $500/tx beta cap on all four flows (send / mint / transfer / redeem),
//   - decision 6: a DGB send with NO price feed is warned on the confirm
//     screen but allowed,
//   - testnet regression: no interstitial, amber banner, no cap chrome.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-beta-posture.mjs   # exit 0 = all green
// Fresh localStorage comes for free: port 0 gives each run a fresh origin.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

// ---- stub DigiByte node: mainnet, DD ACTIVE, fresh oracle at $0.01342/DGB ----
const HEIGHT = 23_900_000;
let chain = 'main';       // flipped to 'test' for the regression scenario
let oracleDown = false;   // flipped to prove decision 6 (warn-allow, no price)
let oracleStale = false;  // flipped to prove a stale quote → warn-allow, not silent enforce
function nodeResult(method) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain, blocks: HEIGHT, headers: HEIGHT, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: { type: 'bip9', active: true, bip9: { status: 'active' } },
          taproot: { type: 'bip9', active: true, bip9: { status: 'active' } },
        },
      };
    case 'getoracleprice':
      if (oracleDown) throw new Error('no oracle price available');
      return { price_micro_usd: 13_420, price_cents: 1, price_usd: 0.01342, is_stale: oracleStale, oracle_count: 35, status: 'ok' };
    case 'getoracles':
      return Array.from({ length: 35 }, (_, i) => ({
        oracle_id: i, name: `oracle-${i}`, is_active: true, in_consensus: true,
        active_oracle_count: 35, total_oracle_slots: 35, consensus_threshold: 7,
      }));
    case 'getdcamultiplier':
      return { multiplier: 1.0, tier_status: 'healthy', system_health: 200, description: 'No additional collateral required (healthy system)' };
    case 'getprotectionstatus':
      return {
        oracle: { available: true, status: 'available', minting_restricted: false },
        volatility: { protection_active: false, minting_restricted: false },
        overall: { status: 'secure', active_protections: [], warnings: [] },
      };
    default:
      throw new Error(`stub node: no handler for ${method}`);
  }
}
const node = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const { method, id } = JSON.parse(raw);
  // resolve the result BEFORE writeHead — a throwing method (oracle down)
  // must not double-write headers
  let body;
  try {
    body = { id, result: nodeResult(method) };
  } catch (e) {
    body = { id, error: { message: String(e.message) } };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((r) => node.listen(0, r));

// ---- inline indexer stub (fake-indexer.mjs shape, plus fundable positions) ----
const funded = new Map(); // address → { utxos, ddCents, ddUtxos, positions }
const TIP = 100_000;
const indexer = createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = req.url.match(/^\/api\/address\/([a-zA-Z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
  if (!m) return json(404, { error: 'unknown path' });
  const [, address, what] = m;
  const e = funded.get(address) || { utxos: [], ddCents: '0', ddUtxos: [], positions: [] };
  if (what === 'utxos') return json(200, { address, utxos: e.utxos });
  if (what === 'history') return json(200, { address, history: e.utxos.map((u) => ({ txid: u.txid, height: u.height })) });
  if (what === 'positions') return json(200, { address, positions: e.positions, tipHeight: TIP });
  if (what === 'dd-utxos') return json(200, { address, totalCents: e.ddCents, utxos: e.ddUtxos });
});
await new Promise((r) => indexer.listen(0, r));

// real mode (creds set) so the stub node is queried like a live one
const server = startServer({
  port: 0,
  rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
  indexerUrl: `http://127.0.0.1:${indexer.address().port}`,
});
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

// ---- CDP plumbing lives in ./lib/cdp.mjs — one copy for all drivers ----
const b = await connectCdp();
const { evaluate, waitFor, shot, text, setVal, click, check } = b;
const ackOpen = () => `document.getElementById('mainnet-ack-modal').classList.contains('open')`;

// ================= 1. Interstitial: blocking, Cancel blocks, Continue persists =================
await b.navigate(APP);
await waitFor(ackOpen(), 'mainnet interstitial opens on first mainnet load');
check(true, 'first mainnet load opens the blocking interstitial');

const ackBody = (await evaluate(`document.querySelector('#mainnet-ack-modal .modal').textContent`)).replace(/\s+/g, ' ');
check(/Real money ahead/.test(ackBody), 'interstitial title: "Real money ahead"');
check(/real funds/.test(ackBody) && /no warranty/.test(ackBody), 'copy: real funds + no warranty');
check(/\$500/.test(ackBody), 'copy: the $500/tx cap is stated');
// copy pass (spec §6): the bullet now points at the backup flow instead of
// declaring "no backup" — the warning it must carry is unchanged
check(/without a backup/.test(ackBody) && /funds are gone/.test(ackBody) && /all risk/.test(ackBody),
  'copy: funds gone without a backup + user bears all risk');
check(!(await evaluate(`document.querySelector('#mainnet-ack-modal [data-close]')`)), 'no close button — the two choices are the only way out');
await shot('95-mainnet-interstitial.png');

// BLOCKING for the keyboard, not just the pointer (adversarial review): a
// background control that grabs focus must be snapped back into the modal, so
// a user cannot Tab past the interstitial into the wallet and transact unacked.
const trapped = await evaluate(`(() => {
  const bg = document.getElementById('hero-connect') || document.getElementById('w-connect');
  if (bg) bg.focus();
  return document.activeElement && document.activeElement.id === 'mainnet-ack-continue';
})()`);
check(trapped, 'focus trap: focus escaping to the background snaps back into the modal');
check(await evaluate(ackOpen()), 'Escape does not dismiss the interstitial');

await click('mainnet-ack-cancel');
check(await evaluate(ackOpen()), 'Cancel does NOT dismiss it — the wallet stays blocked');
check(await evaluate(`document.getElementById('mainnet-ack-note').style.display === 'block'`), 'Cancel explains the wallet stays blocked');

await click('mainnet-ack-continue');
await waitFor(`!(${ackOpen()})`, 'interstitial closes on Continue');
check(await evaluate(`localStorage.getItem('diginaut-mainnet-ack') === '1'`), 'Continue persists the ack in localStorage');

// ================= 2. Banner + pill: red, correct copy, survives scroll =================
await waitFor(`!document.getElementById('net-banner').hidden`, 'banner renders');
const banner = await evaluate(text('net-banner'));
check(/MAINNET BETA/.test(banner) && /real funds at risk/.test(banner) && /\$500\/tx cap/.test(banner),
  `mainnet banner carries the #54 copy: "${banner}"`);
check(await evaluate(`document.getElementById('net-banner').classList.contains('danger')`), 'mainnet banner is danger-red, not amber');
check(await evaluate(`!document.getElementById('net-pill').hidden && ${text('net-pill')} === 'MAINNET'`), 'MAINNET pill shows in the topbar');
check(await evaluate(`document.getElementById('net-pill').classList.contains('danger')`), 'pill is danger-styled');
await evaluate(`{ document.body.style.minHeight = '3000px'; window.scrollTo(0, 600); }`);
await waitFor(`document.getElementById('net-pill').classList.contains('floating')`, 'pill floats once the topbar scrolls away');
check(true, 'pill survives scroll (floats to a fixed corner)');
await evaluate(`{ window.scrollTo(0, 0); document.body.style.minHeight = ''; }`);
await shot('96-mainnet-banner-pill.png');

// ---- reload: the ack is remembered, no interstitial again ----
await b.navigate(APP);
await waitFor(`!document.getElementById('net-banner').hidden`, 'reload reaches banner');
check(!(await evaluate(ackOpen())), 'reload after ack: interstitial does not reappear');

// ================= 3. Wallet + $500/tx cap on all four flows =================
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await click('w-create-choice');
await setVal('w-create-pass', 'beta posture pass');
await setVal('w-create-pass2', 'beta posture pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet created + unlocked');
await click('w-backup-done');
const addr = await evaluate(text('w-address'));
const ddAddr = await evaluate(text('w-dd-address'));
check(/^dgb1p/.test(addr) && /^DD/.test(ddAddr), `mainnet addresses derived (${addr.slice(0, 12)}…, ${ddAddr.slice(0, 6)}…)`);

// fund: one 100,000-DGB coin (≈ $1,342 at $0.01342) + an over-cap $600 position
funded.set(addr, {
  utxos: [{ txid: 'ab'.repeat(32), vout: 0, valueSats: '10000000000000', height: 99_000 }],
  ddCents: '0',
  ddUtxos: [],
  positions: [{
    txid: 'cd'.repeat(32), ddCents: '60000', tierLabel: '1 year',
    collateralSats: '5000000000000', unlockHeight: 99_000, // < tip → redeemable
  }],
});
await waitFor(`${text('w-balance')} === '100,000'`, 'funded balance renders');

// ---- send: over the cap → blocked with the beta message ----
await click('act-send');
await setVal('w-send-to', addr);
await setVal('w-send-amount', '50000'); // ≈ $671 > $500
await click('w-send-review');
await waitFor(`${text('w-send-err')}.includes('capped at $500')`, 'over-cap send blocked');
const sendErr = await evaluate(text('w-send-err'));
check(/mainnet beta/.test(sendErr) && /\$500/.test(sendErr) && /≈/.test(sendErr),
  `send > $500 blocked with the USD estimate: "${sendErr}"`);
await shot('97-send-over-cap.png');

// ---- send: under the cap → confirm screen, NO cap warning ----
await setVal('w-send-amount', '1000'); // ≈ $13.42
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'under-cap send reaches confirm');
check(await evaluate(`document.getElementById('w-send-c-capnote').style.display === 'none'`), 'priced send shows no cap warning');
await click('w-send-cancel');

// ---- mint: USD-native, $600 → blocked before any signing ----
await click('act-mint');
await setVal('w-mint-amount', '600');
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('capped at $500')`, 'over-cap mint blocked');
check(true, `mint > $500 blocked: "${await evaluate(text('w-mint-err'))}"`);
await evaluate(`document.querySelector('#mint-modal [data-close]').click()`);

// ---- transfer: USD-native, $600 → blocked ----
await click('act-send');
await evaluate(`{ const s = document.getElementById('send-asset'); s.value = 'dd'; s.dispatchEvent(new Event('change', { bubbles: true })); }`);
await setVal('w-tr-to', ddAddr);
await setVal('w-tr-amount', '600');
await click('w-tr-review');
await waitFor(`${text('w-tr-err')}.includes('capped at $500')`, 'over-cap transfer blocked');
check(true, `transfer > $500 blocked: "${await evaluate(text('w-tr-err'))}"`);
await evaluate(`document.querySelector('#send-modal [data-close]').click()`);

// ---- redeem: the $600 position → blocked with a pointer at Core ----
await waitFor(`document.querySelector('#w-positions [data-redeem]')`, 'redeemable position renders');
await evaluate(`document.querySelector('#w-positions [data-redeem]').click()`);
await waitFor(`${text('w-rd-err')}.includes('capped at $500')`, 'over-cap redeem blocked');
const rdErr = await evaluate(text('w-rd-err'));
check(/DigiByte Core/.test(rdErr), `redeem > $500 blocked, points at Core: "${rdErr.slice(0, 120)}…"`);

// ================= 4. Decision 6: no price feed → warn-allow on DGB send =================
oracleDown = true;
await b.navigate(APP);
await waitFor(`!document.getElementById('net-banner').hidden`, 'reload reaches banner (oracle down)');
check(!(await evaluate(ackOpen())), 'ack persists across the oracle-down reload');
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked state');
await setVal('w-unlock-pass', 'beta posture pass');
await click('w-unlock');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
await waitFor(`${text('w-balance')} === '100,000'`, 'balance back');
await click('act-send');
await setVal('w-send-to', addr);
await setVal('w-send-amount', '50000'); // would be ≈ $671 — but NO price feed
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'unpriced send reaches confirm (warn-allow)');
check(await evaluate(`document.getElementById('w-send-c-capnote').style.display === 'block'`),
  'confirm screen warns: could not verify the $500 cap (no price feed)');
check((await evaluate(text('w-send-c-capnote'))).includes('$500'), 'the warning names the cap');
await shot('98-send-capnote-noprice.png');
await click('w-send-cancel');

// ============= 4b. Stale quote → warn-allow, NOT silent enforcement at the stale rate =============
// A stale price is "couldn't verify" (adversarial review): the cap must not
// enforce against it. An over-cap send under a stale feed takes the warn-allow
// path (capnote + reaches confirm) rather than being blocked at the stale rate.
oracleDown = false;
oracleStale = true;
await b.navigate(APP);
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked state (stale oracle)');
await setVal('w-unlock-pass', 'beta posture pass');
await click('w-unlock');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked (stale oracle)');
await waitFor(`${text('w-balance')} === '100,000'`, 'balance back (stale oracle)');
await click('act-send');
await setVal('w-send-to', addr);
await setVal('w-send-amount', '50000'); // ≈ $671 at the stale rate — must NOT enforce
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'stale-priced send reaches confirm (warn-allow, not blocked)');
check(await evaluate(`document.getElementById('w-send-c-capnote').style.display === 'block'`),
  'stale quote is treated as unverifiable: warn-allow, not silent enforcement at the stale rate');
check(!(await evaluate(text('w-send-err'))).includes('capped'), 'stale-priced over-cap send is not blocked at the stale rate');
await click('w-send-cancel');

// ================= 5. Testnet regression: none of the mainnet chrome =================
chain = 'test';
oracleDown = false;
oracleStale = false;
// same build, different chain — use a FRESH target so no mainnet state lingers
const b2 = await b.newTarget();
// same origin as the mainnet run — clear the stored ack BEFORE app.js boots so
// "no interstitial on testnet" proves the chain gate, not the persisted ack
await b2.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.removeItem('diginaut-mainnet-ack') } catch {}` });
const evaluate2 = b2.evaluate;
await b2.navigate(APP);
await b2.waitFor(`!document.getElementById('net-banner').hidden`, 'testnet banner renders');
check(/TESTNET ONLY/.test(await evaluate2(text('net-banner'))), 'testnet banner still amber TESTNET ONLY');
check(await evaluate2(`!document.getElementById('net-banner').classList.contains('danger')`), 'testnet banner is NOT danger-red');
check(await evaluate2(`${text('net-pill')} === 'TESTNET' && document.getElementById('net-pill').classList.contains('warn')`), 'TESTNET pill, warn-styled');
check(!(await evaluate2(ackOpen())), 'no mainnet interstitial on testnet');

console.log('\nDone.');
b.close();
node.close();
indexer.close();
server.close();
process.exit(process.exitCode || 0);
