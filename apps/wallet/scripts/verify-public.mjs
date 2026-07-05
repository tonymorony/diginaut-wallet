// Public-deployment smoke (#8 AC1): the full user journey against a DEPLOYED
// stack over HTTPS — real testnet, real oracle feed, real faucet, natural
// block cadence (no mock oracle, no on-demand mining, generous timeouts).
// Journey: create wallet → faucet claim → confirm → mint → position →
// transfer to a second wallet → restore it → see the DigiDollar arrive.
//   APP_URL=https://dgb.ludere.space node apps/wallet/scripts/verify-public.mjs
// Chrome setup: same as every other driver (CDP 9224, fresh profile).
import { writeFileSync } from 'node:fs';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';

const CDP_PORT = 9224;
const APP = process.env.APP_URL || 'https://dgb.ludere.space';
const OUT = new URL('.', import.meta.url).pathname;
// BIP39 vector #3 — a dedicated public-testnet counterparty wallet
const MNEMONIC_B = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

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
async function waitFor(expr, label, timeoutMs = 300_000) { // real blocks: minutes, not ms
  const t0 = Date.now();
  const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(guarded)) return;
    await new Promise((r) => setTimeout(r, 1000));
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
const ddOf = async (addr) => BigInt(
  (await (await fetch(`${APP}/api/indexer/address/${addr}/dd-utxos`)).json()).totalCents ?? 0);

// ---- Live deployment health.
const cfg = await (await fetch(`${APP}/api/config`)).json();
check(cfg.mock === false && cfg.faucet === true && cfg.indexer === true,
  `deployed config is LIVE with faucet+indexer: ${JSON.stringify(cfg)}`);

const addrB = deriveTaprootAddress(mnemonicToSeed(MNEMONIC_B), { ...HD_NETWORKS.testnet, index: 0 }).address;
const bBefore = await ddOf(addrB);

await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none' || document.getElementById('w-locked').style.display !== 'none'`, 'wallet UI loads');
await waitFor(`${text('s-chain')} === 'test'`, 'node reports testnet');
await waitFor(`${text('s-dd')}.includes('active')`, 'DigiDollar softfork active');
await waitFor(`${text('o-price')}.startsWith('$')`, 'live oracle price');
check(true, `public UI on testnet: chain=test, DD active, oracle ${await evaluate(text('o-price'))}`);

// ---- Wallet A + faucet claim (the real deployed faucet).
await setVal('w-create-pass', 'public smoke pass');
await setVal('w-create-pass2', 'public smoke pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet created');
check(await evaluate(`document.getElementById('w-mint').style.display !== 'none'`), 'stablecoin flows on by default (no flag)');
await click('w-backup');
const seedA = await evaluate(text('w-seed-words'));
await click('w-backup'); // hide again
check(seedA.split(' ').length === 12, 'wallet A seed captured for the restore leg');

await click('w-faucet');
await waitFor(`${text('w-faucet-out')}.startsWith('Sent')`, 'faucet dispensed', 120_000);
const claim = await evaluate(text('w-faucet-out'));
check(/Sent [\d,]+ DGB/.test(claim), `real faucet dispensed: "${claim.slice(0, 60)}"`);
await waitFor(`${text('w-balance')} !== '0' && ${text('w-balance')} !== '—'`, 'claim confirmed by a real block', 600_000);
const balance = await evaluate(text('w-balance'));
check(true, `claim confirmed on testnet: balance ${balance} DGB`);
await shot('80-public-funded.png');

// ---- Mint $100 (the consensus MINIMUM outside regtest) at the cheapest-
// collateral tier. A $100 mint at 10 years ≈ 200%·1.01 ≈ \$202 of DGB.
await setVal('w-mint-amount', '100');
await evaluate(`document.getElementById('w-mint-tier').value = '10years'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'mint confirmation');
const cPrice = await evaluate(text('w-mint-c-price'));
const cColl = await evaluate(text('w-mint-c-coll'));
check(/^\$0\.\d+ \/ DGB$/.test(cPrice), `confirmation uses the live oracle price: ${cPrice}`);
check(Number(cColl.replace(/,/g, '')) > 0, `exact collateral shown: ${cColl} DGB`);
await shot('81-public-mint-confirm.png');
await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'mint broadcast accepted by the public node');
await waitFor(`${text('w-positions')}.includes('$100.00')`, 'position appears after a real block', 600_000);
check((await evaluate(text('w-positions'))).includes('locked until'),
  `position live with its CLTV state: "${(await evaluate(text('w-positions'))).slice(0, 90)}…"`);
await waitFor(`${text('w-dd-balance')} === '100.00'`, 'spendable DigiDollar shows $100.00', 300_000);

// ---- Transfer $25 to wallet B (consensus min DD output is $1).
await setVal('w-tr-to', addrB);
await setVal('w-tr-amount', '25');
await click('w-tr-review');
await waitFor(`document.getElementById('w-tr-confirm').style.display !== 'none'`, 'transfer confirmation');
await click('w-tr-go');
await waitFor(`${text('w-tr-out')}.startsWith('Transferred')`, 'transfer broadcast');
await waitFor(`${text('w-dd-balance')} === '75.00'`, "A's DigiDollar drops to \$75.00", 600_000);
check(true, "wallet A reflects the transfer: \$75.00 spendable");

// ---- Wallet B: erase A (seed captured), restore B, DigiDollar arrived.
await click('w-lock');
await waitFor(`document.getElementById('w-locked').style.display !== 'none'`, 'locked');
await evaluate(`document.getElementById('w-forget').click()`);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'erased');
await click('w-show-restore');
await setVal('w-restore-seed', MNEMONIC_B);
await setVal('w-create-pass', 'public smoke pass');
await setVal('w-create-pass2', 'public smoke pass');
await click('w-restore-go');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet B restored');
const bExpected = ((Number(bBefore) + 2500) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
await waitFor(`${text('w-dd-balance')} === ${JSON.stringify(bExpected)}`, 'wallet B sees the DigiDollar', 300_000);
check(true, `wallet B reflects the transfer over the public stack: $${bExpected}`);
await shot('82-public-received.png');

console.log(`\nwallet A seed (for the future redeem once the lock expires): ${seedA}`);
console.log('Done.');
ws.close();
