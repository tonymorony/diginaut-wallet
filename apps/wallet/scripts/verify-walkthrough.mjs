// Release gate (#17): the FULL user journey with no dead ends, all through the
// UI — Faucet → Mint → Transfer (A→B) → wallet switch → Transfer back (B→A) →
// Redeem — across two wallets in the same browser. Every step asserts what a
// user would see. The stablecoin sections must be on WITHOUT any feature flag
// (ADR-0002: mint ships together with transfer and redeem, or not at all).
//
// Setup (all local, regtest):
//   - DigiByte node RPC on 18500 (dd/ddpass) with the funded 'stand' wallet
//   - indexer on 8789 (DGB_HRP=dgbrt), wallet app on 8791 (NO FEATURE_MINT env)
//   - faucet on 8790 with a FRESH FAUCET_DATA_FILE (one claim per IP per 24h —
//     e.g. FAUCET_DATA_FILE=/tmp/faucet-claims-walkthrough-$RANDOM.json)
//   - headless Chrome CDP on 9224 with a FRESH user-data-dir (clean IndexedDB)
import { writeFileSync } from 'node:fs';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const INDEXER = 'http://127.0.0.1:8789';
const OUT = new URL('.', import.meta.url).pathname;
const RPC = 'http://127.0.0.1:18500';
const PASS = 'walkthrough pass';
// BIP39 test vector #2 — wallet B is deterministic so the driver knows its
// addresses. Its coins may carry DD from earlier sessions: assert RELATIVE
// deltas via the indexer, never absolutes.
const MNEMONIC_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

async function nodeRpc(method, params = [], wallet) {
  const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('dd:ddpass').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'drv', method, params }),
  });
  const json = JSON.parse(await res.text());
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
const cdp = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await cdp('Page.enable', {}, sessionId);
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error('page threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  return result.value;
}
async function waitFor(expr, label, timeoutMs = 60000) {
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout: ' + label);
}
async function shot(name) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(OUT + name, Buffer.from(data, 'base64'));
  console.log('  [screenshot]', name);
}
const text = (id) => `document.getElementById('${id}').textContent`;
const setVal = (id, v) => evaluate(`{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input',{bubbles:true})); }`);
const click = (id) => evaluate(`document.getElementById('${id}').click()`);
let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };
const num = (s) => Number(String(s).replace(/,/g, ''));

// The mock oracle's quote goes stale between calls, and BOTH mempool acceptance
// and the BLOCK TEMPLATE silently drop DigiDollar txs on a stale quote — so
// refresh the price before every broadcast and every mine.
const miner = await nodeRpc('getnewaddress', [], 'stand');
async function mine(blocks = 1) {
  await nodeRpc('setmockoracleprice', [13_420]);
  await nodeRpc('generatetoaddress', [blocks, miner], 'stand');
}

// Wallet B's watched addresses (index 0 + the UI's 2-address lookahead).
const seedB = mnemonicToSeed(MNEMONIC_B);
const bAddrs = [0, 1, 2].map((index) => deriveTaprootAddress(seedB, { ...HD_NETWORKS.regtest, index }).address);
const addrB = bAddrs[0];
const ddOf = async (addr) =>
  BigInt((await (await fetch(`${INDEXER}/api/address/${addr}/dd-utxos`)).json()).totalCents);
const bCents0Before = await ddOf(addrB);

// ---- 0. Stablecoin sections are on by default: no flag anywhere.
const cfg = await (await fetch(APP + '/api/config')).json();
check(!('mint' in cfg), 'server config carries no mint feature flag (#17 removed it, ADR-0002)');

// ---- 1. Wallet A: create in the UI, back up the seed phrase.
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet A unlocked');
await click('w-backup-done'); // skip the backup ceremony overlay (spec §2)
const addrA = await evaluate(text('w-address'));
check(await evaluate(`document.getElementById('w-mint').style.display !== 'none'`)
  && await evaluate(`document.getElementById('w-transfer').style.display !== 'none'`),
  'mint AND transfer sections visible with no feature flag (ADR-0002: all or nothing)');
// seed capture is re-auth gated now (spec §5): password → tap to reveal
await click('w-backup');
await waitFor(`document.getElementById('reauth-modal').classList.contains('open')`, 're-auth prompt');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(`document.getElementById('w-seed').style.display !== 'none'`, 'seed view after re-auth');
await click('w-seed-show'); // un-blur: swaps the decoys for the REAL words
await waitFor(`${text('w-seed-words')}.trim().split(/\\s+/).length === 12`, 'seed phrase shown');
const mnemonicA = (await evaluate(text('w-seed-words'))).trim().split(/\s+/).join(' ');
await click('w-backup'); // hide it again
check(mnemonicA.split(/\s+/).length === 12, 'wallet A seed phrase captured from the backup UI (12 words)');

// ---- 2. Faucet claim through the UI button → mine → balance visible.
await nodeRpc('setmockoracleprice', [13_420]); // faucet 503s on a stale quote
await click('w-faucet');
await waitFor(`${text('w-faucet-out')}.startsWith('Sent')`, 'faucet dispensed', 40000);
const faucetOut = await evaluate(text('w-faucet-out'));
await mine();
await waitFor(`document.getElementById('w-money').style.display !== 'none' && ${text('w-balance')}.length > 0 && ${text('w-balance')} !== '0'`, 'balance visible');
const balAfterFaucet = num(await evaluate(text('w-balance')));
check(balAfterFaucet >= 7527, `faucet claim is mint-meaningful: balance ${balAfterFaucet.toLocaleString('en-US')} DGB covers a $10 1-hour mint ("${faucetOut.slice(0, 40)}…")`);
await shot('80-walkthrough-faucet.png');

// ---- 3. Mint $10 at the 1-hour tier (240-block lock — the only tier a driver
// can wait out) → mine → position visible.
await setVal('w-mint-amount', '10');
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'mint confirmation');
// $10 · 1000% ÷ $0.01342 × 1.01 = 7,526.08 DGB (hand-computed, as in verify-redeem)
check((await evaluate(text('w-mint-c-coll'))) === '7,526.08', 'mint confirmation shows the exact collateral: 7,526.08 DGB');
await nodeRpc('setmockoracleprice', [13_420]);
await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'mint broadcast');
await mine();
await waitFor(`${text('w-dd-balance')} === '10.00'`, 'DigiDollar balance $10.00');
await waitFor(`${text('w-positions')}.includes('$10.00')`, 'position rendered');
check((await evaluate(text('w-positions'))).includes('locked until'), 'mint position visible, correctly still locked');
await shot('81-walkthrough-minted.png');

// ---- 4. Transfer $2.50 A → B. Mint change went to P2WPKH by consensus, so
// first give A's taproot address a fee coin (a user would faucet/receive DGB).
await nodeRpc('sendtoaddress', [addrA, 2], 'stand');
await mine();
await waitFor(`Number(${text('w-balance')}.replace(/,/g,'')) >= ${balAfterFaucet - 7527 + 2}`, 'fee coin confirmed');
await setVal('w-tr-to', addrB);
await setVal('w-tr-amount', '2.5');
await click('w-tr-review');
await waitFor(`document.getElementById('w-tr-confirm').style.display !== 'none'`, 'transfer confirmation');
check((await evaluate(text('w-tr-c-to'))) === addrB && (await evaluate(text('w-tr-c-dd'))) === '2.50',
  'transfer confirmation: $2.50 to wallet B');
await nodeRpc('setmockoracleprice', [13_420]);
await click('w-tr-go');
await waitFor(`${text('w-tr-out')}.startsWith('Transferred')`, 'transfer broadcast');
await mine();
await waitFor(`${text('w-dd-balance')} === '7.50'`, "wallet A's DigiDollar drops to $7.50");
check(await ddOf(addrB) === bCents0Before + 250n,
  "indexer: wallet B's address gained exactly +$2.50 (relative delta)");
await shot('82-walkthrough-transferred.png');

// ---- 5. Switch wallets: erase A (seed is backed up!), restore B → DD arrived.
await click('w-lock');
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked');
await evaluate(`document.getElementById('w-forget').click()`);
// erase is a ceremony now (spec §5): type ERASE to arm, then confirm
await waitFor(`document.getElementById('w-erase-view').style.display !== 'none'`, 'erase ceremony');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'erased');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC_B);
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-restore-go');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet B unlocked');
check((await evaluate(text('w-address'))) === addrB, 'wallet B derives the expected first address');
// B may hold DD from earlier sessions: expected UI total = live indexer sum
// over B's watched addresses (which includes the +$2.50 asserted above).
const bTotal = (await Promise.all(bAddrs.map(ddOf))).reduce((s, c) => s + c, 0n);
const bExpected = (Number(bTotal) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
await waitFor(`${text('w-dd-balance')} === ${JSON.stringify(bExpected)}`, 'wallet B sees the DigiDollar');
check(true, `wallet B restored in the same browser sees the transfer land (DD balance $${bExpected})`);
await shot('83-walkthrough-wallet-b.png');

// ---- 6. B sends the $2.50 back (redemption burns the FULL minted $10, so the
// journey routes the DigiDollar home — no dead end). Fee coins for whichever
// watched address holds the picked DD coin.
const bBalBefore = num(await evaluate(text('w-balance')));
for (const a of bAddrs) await nodeRpc('sendtoaddress', [a, 2], 'stand');
await mine();
await waitFor(`Number(${text('w-balance')}.replace(/,/g,'')) >= ${bBalBefore + 6 - 0.01}`, "B's fee coins confirmed");
await setVal('w-tr-to', addrA);
await setVal('w-tr-amount', '2.5');
await click('w-tr-review');
await waitFor(`document.getElementById('w-tr-confirm').style.display !== 'none'`, 'B→A transfer confirmation');
check((await evaluate(text('w-tr-c-to'))) === addrA, 'confirmation shows wallet A as the recipient');
await nodeRpc('setmockoracleprice', [13_420]);
await click('w-tr-go');
await waitFor(`${text('w-tr-out')}.startsWith('Transferred')`, 'B→A transfer broadcast');
await mine();
await waitFor(`${text('w-dd-balance')} !== ${JSON.stringify(bExpected)}`, "wallet B's DD balance drops");
check(await ddOf(addrA) === 1000n, "indexer: wallet A's address holds the full $10.00 again");
check(true, `wallet B sent $2.50 back through the same UI (B's DD: $${bExpected} → $${await evaluate(text('w-dd-balance'))})`);

// ---- 7. Restore wallet A from the captured seed phrase.
await click('w-lock');
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked again');
await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(`document.getElementById('w-erase-view').style.display !== 'none'`, 'erase ceremony again');
await setVal('w-erase-input', 'ERASE');
await click('w-erase-go');
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'B erased');
await click('w-show-restore');
await setVal('w-restore-seed', mnemonicA);
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-restore-go');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet A restored');
check((await evaluate(text('w-address'))) === addrA, 'wallet A restores to the same address from the backed-up seed');
await waitFor(`${text('w-dd-balance')} === '10.00'`, 'wallet A holds $10.00 DigiDollar again');
await waitFor(`${text('w-positions')}.includes('$10.00')`, 'the open position survived the erase/restore');

// ---- 8. Wait out the CLTV lock (240 blocks + 100 buffer) → Redeem → confirm.
await mine(345);
await waitFor(`document.querySelector('#w-positions [data-redeem]') !== null`, 'redeem button appears after expiry', 90000);
const balBeforeRedeem = num(await evaluate(text('w-balance')));
await evaluate(`document.querySelector('#w-positions [data-redeem]').click()`);
await waitFor(`document.getElementById('w-redeem-confirm').style.display !== 'none'`, 'redeem confirmation');
check((await evaluate(text('w-rd-c-dd'))) === '10.00' && (await evaluate(text('w-rd-c-coll'))) === '7,526.08',
  'redeem confirmation: burn $10.00, get 7,526.08 DGB collateral back');
await shot('84-walkthrough-redeem-confirm.png');
await nodeRpc('setmockoracleprice', [13_420]);
await click('w-rd-go');
await waitFor(`${text('w-rd-out')}.startsWith('Redeemed')`, 'redeem broadcast');
await mine();
await waitFor(`${text('w-positions')} === 'No open positions.'`, 'position closed');
check(true, 'position closes after the redemption confirms');
await waitFor(`${text('w-dd-balance')} === '0.00'`, 'burned DigiDollar gone');
// collateral (7,526.08) returns, minus the 0.12 DGB redeem fee
await waitFor(`Math.abs(Number(${text('w-balance')}.replace(/,/g,'')) - ${balBeforeRedeem + 7526.08 - 0.12}) < 0.02`, 'collateral back');
check(true, `collateral is back in wallet A's DGB balance (${balBeforeRedeem.toLocaleString('en-US')} → ${await evaluate(text('w-balance'))} DGB)`);
await shot('85-walkthrough-redeemed.png');

console.log('\nWalkthrough complete: Faucet → Mint → Transfer → Redeem, two wallets, no dead ends.');
ws.close();
