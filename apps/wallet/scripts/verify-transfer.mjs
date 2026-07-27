// Drive #15: DigiDollar transfer between two wallets through the full real
// stack. Wallet A mints in the UI, transfers to wallet B's address; the driver
// then restores wallet B in the same browser and sees the DigiDollar arrive.
// Also proves the distinct error states: non-taproot recipient, insufficient
// DigiDollar, and no fee coin on the DD-holding address.
// Setup: same as verify-mint.mjs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = fileURLToPath(new URL('.', import.meta.url));
const RPC = 'http://127.0.0.1:18500';
// BIP39 test vector #2 — wallet B is deterministic so the driver knows its address
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
async function waitFor(expr, label, timeoutMs = 40000) {
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

// ---- Arrange: wallet A (fresh), funded, mints $20 in the UI.
const addrB = deriveTaprootAddress(mnemonicToSeed(MNEMONIC_B), { ...HD_NETWORKS.regtest, index: 0 }).address;
const ddOfB = async () =>
  BigInt((await (await fetch(`http://127.0.0.1:8789/api/address/${addrB}/dd-utxos`)).json()).totalCents);
const bCentsBefore = await ddOfB();

await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'transfer flow pass');
await setVal('w-create-pass2', 'transfer flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet A unlocked');
await click('w-backup-done'); // skip the backup ceremony overlay (spec §2)
const addrA = await evaluate(text('w-address'));
const miner = await nodeRpc('getnewaddress', [], 'stand');
await nodeRpc('sendtoaddress', [addrA, 6_000], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} === '6,000'`, 'wallet A funded');
await nodeRpc('setmockoracleprice', [13_420]);

await setVal('w-mint-amount', '20');
await evaluate(`document.getElementById('w-mint-tier').value = '6months'`);
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display !== 'none'`, 'mint confirmation');
await click('w-mint-go');
await waitFor(`${text('w-mint-out')}.startsWith('Minted')`, 'mint broadcast');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-dd-balance')} === '20.00'`, 'wallet A holds $20 spendable DigiDollar');
check(true, 'wallet A minted $20 via the UI; DigiDollar (spendable) shows $20.00');

// ---- Error 1: recipient must be a taproot address.
await setVal('w-tr-to', 'dgbrt1qskyk2t69a02764tlvvcjq6ydgtacv6e9nxuw5t'); // witness v0
await setVal('w-tr-amount', '5');
await click('w-tr-review');
// #72 routed this through decodeDDAddress, which rejects a witness-v0 recipient
// with "DigiDollar address must be a taproot (witness v1) output" — the old
// "not a DigiDollar-capable" copy is gone. Wait on the INTENT (an error that
// names taproot), which is what the check below actually asserts.
await waitFor(`/taproot/i.test(${text('w-tr-err')})`, 'non-taproot error');
check((await evaluate(text('w-tr-err'))).includes('taproot'),
  'invalid-address error explains DigiDollar needs a taproot address');

// ---- Error 2: insufficient DigiDollar — exact numbers.
await setVal('w-tr-to', addrB);
await setVal('w-tr-amount', '100');
await click('w-tr-review');
await waitFor(`${text('w-tr-err')}.includes('insufficient DigiDollar')`, 'insufficient DD error');
check((await evaluate(text('w-tr-err'))).includes('hold $20.00'),
  'insufficient-DigiDollar error is specific: sending $100, holding $20');

// ---- Error 3: mint change went to P2WPKH, so addr A has NO DGB fee coin now.
await setVal('w-tr-amount', '7.5');
await click('w-tr-review');
await waitFor(`${text('w-tr-err')}.includes('no DGB for the fee')`, 'no-fee-coin error');
check((await evaluate(text('w-tr-err'))).includes(addrA),
  'no-fee-coin error names the exact address to top up');
await shot('60-transfer-errors.png');

// top up the fee coin and mine it. The balance is not '1': the mint's change
// went to the P2WPKH twin and counts toward it (#38) — wait for the +1 delta.
const balBeforeTopUp = await evaluate(text('w-balance'));
await nodeRpc('sendtoaddress', [addrA, 1], 'stand');
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-balance')} !== ${JSON.stringify(balBeforeTopUp)}`, 'fee coin confirmed');

// ---- Transfer $7.50 A → B with confirmation before signing.
await click('w-tr-review');
await waitFor(`document.getElementById('w-tr-confirm').style.display !== 'none'`, 'transfer confirmation');
check((await evaluate(text('w-tr-c-to'))) === addrB, 'confirmation shows the recipient');
check((await evaluate(text('w-tr-c-dd'))) === '7.50', 'confirmation shows the amount: $7.50');
check((await evaluate(text('w-tr-c-change'))) === '12.50', 'confirmation shows the DigiDollar change: $12.50');
check((await evaluate(text('w-tr-c-fee'))) === '0.12', 'confirmation shows the 0.12 DGB fee');
check((await nodeRpc('getrawmempool')).length === 0, 'nothing signed or broadcast at review time');
await shot('61-transfer-confirm.png');

await click('w-tr-go');
await waitFor(`${text('w-tr-out')}.startsWith('Transferred')`, 'broadcast acknowledged');
const mempool = await nodeRpc('getrawmempool');
check(mempool.length === 1, `client-signed transfer accepted into the mempool: ${mempool[0]?.slice(0, 16)}…`);
await nodeRpc('generatetoaddress', [1, miner], 'stand');
await waitFor(`${text('w-dd-balance')} === '12.50'`, "wallet A's DigiDollar drops to the change");
check(true, "wallet A reflects the transfer: DigiDollar (spendable) = $12.50");

// ---- Wallet B: restore in the same browser, DigiDollar arrived.
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
await setVal('w-create-pass', 'transfer flow pass');
await setVal('w-create-pass2', 'transfer flow pass');
await click('w-restore-go');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet B unlocked');
check((await evaluate(text('w-address'))) === addrB, 'wallet B derives the expected address');
const bExpected = ((Number(bCentsBefore) + 750) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
await waitFor(`${text('w-dd-balance')} === ${JSON.stringify(bExpected)}`, 'wallet B sees the DigiDollar');
check(true, `wallet B reflects the transfer: DigiDollar (spendable) = $${bExpected}`);
await shot('62-transfer-received.png');

console.log('\nDone.');
ws.close();
