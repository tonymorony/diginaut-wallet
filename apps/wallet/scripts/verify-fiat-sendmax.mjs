// Drive #70: fiat (USD) amount entry + send-max on the DGB send, through the
// real wallet frontend against a FAKE indexer (apps/wallet/scripts/fake-indexer.mjs).
// No regtest node needed — MOCK rpc supplies a fresh oracle price ($0.01342/DGB),
// the fake indexer supplies canned confirmed UTXOs (incl. a 0-value DD-token
// output that send-max must exclude), and the mock broadcaster acks the tx.
//
// Setup:
//   PORT=8799 node apps/wallet/scripts/fake-indexer.mjs &
//   PORT=8798 INDEXER_URL=http://127.0.0.1:8799 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-fiat-sendmax.mjs      # exit 0 = all checks green
import { writeFileSync } from 'node:fs';

const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
const APP = process.env.APP || 'http://127.0.0.1:8798';
const INDEXER = process.env.INDEXER || 'http://127.0.0.1:8799';
const OUT = new URL('.', import.meta.url).pathname;

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
const val = (id) => `document.getElementById('${id}').value`;
const setVal = (id, v) => evaluate(`{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input',{bubbles:true})); }`);
const click = (id) => evaluate(`document.getElementById('${id}').click()`);
let step = 0;
const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

// ---- Arrange: fresh wallet, funded via the fake indexer (two confirmed coins
// worth 500 DGB + one 0-value DD-token output that must never be spent).
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'fiat sendmax pass');
await setVal('w-create-pass2', 'fiat sendmax pass');
await click('w-create');
await waitFor(`document.getElementById('w-backup-view').style.display !== 'none'`, 'seed backup shown');
await click('w-backup-done'); // dismiss the one-time backup view like a real user
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
const addr0 = await evaluate(text('w-address'));

await fetch(`${INDEXER}/__fund`, {
  method: 'POST',
  body: JSON.stringify({
    address: addr0,
    utxos: [
      { txid: 'aa'.repeat(32), vout: 0, valueSats: '30000000000', height: 100 }, // 300 DGB
      { txid: 'bb'.repeat(32), vout: 1, valueSats: '20000000000', height: 100 }, // 200 DGB
      { txid: 'cc'.repeat(32), vout: 1, valueSats: '0', height: 100 },            // DD token — excluded
    ],
  }),
});
await waitFor(`${text('w-balance')} !== '0' && ${text('w-balance')} !== '—'`, 'balance reflects the funded coins');
check((await evaluate(text('w-balance'))) === '500', `balance shows 500 DGB (0-value DD output adds nothing): ${await evaluate(text('w-balance'))}`);

// open the Send modal the way a user does
await click('act-send');
await waitFor(`document.getElementById('send-modal').classList.contains('open')`, 'send modal open');

// ---- Fiat entry: switch to USD, type $3.00, verify the live DGB conversion.
// $0.01342/DGB → 3 / 0.01342 = 223.54694485 DGB (integer-floored to sats).
const EXPECTED_DGB = '223.54694485';
check(!(await evaluate(`document.getElementById('w-send-ccy').disabled`)), 'USD toggle is enabled while the oracle price is fresh');
await click('w-send-ccy');
check((await evaluate(text('w-send-amount-label'))) === 'Amount (USD)', 'label switches to "Amount (USD)"');
await setVal('w-send-amount', '3.00');
const eq = await evaluate(text('w-send-amount-eq'));
check(eq === `≈ ${EXPECTED_DGB} DGB`, `live conversion shows the DGB equivalent: "${eq}"`);

await setVal('w-send-to', addr0);
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'USD send confirmation');
const cAmt = await evaluate(text('w-send-c-amount'));
const cUsd = await evaluate(text('w-send-c-amount-usd'));
check(cAmt === EXPECTED_DGB, `review shows the converted DGB the tx is built from: ${cAmt} DGB (no re-quote)`);
check(cUsd.includes('$3.00'), `review shows both currencies: "${cAmt} DGB${cUsd}"`);
await shot('33-send-usd-entry.png');
await click('w-send-cancel');

// ---- Send-max: drain the wallet. Two 250-DGB-ish P2TR inputs, one output, no
// change. The 0-value DD token must be excluded, so the fee is the 2-input fee
// (0.000169 DGB), NOT the 3-input fee (0.000226) it would be if DD were spent.
await click('w-send-ccy'); // back to DGB
check((await evaluate(text('w-send-amount-label'))) === 'Amount (DGB)', 'toggled back to DGB entry');
await setVal('w-send-amount', ''); // clear the $3.00 left from the USD test
await click('w-send-max');
await waitFor(`${val('w-send-amount')} === '499.999831'`, 'max fills the amount field with the drained balance');
check((await evaluate(val('w-send-amount'))) === '499.999831', `max = full balance − fee: ${await evaluate(val('w-send-amount'))} DGB`);
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'max send confirmation');
const maxAmt = await evaluate(text('w-send-c-amount'));
const maxFee = await evaluate(text('w-send-c-fee'));
check(maxAmt === '499.999831', `review shows the drained amount: ${maxAmt} DGB`);
check(maxFee === '0.000169', `fee is the 2-input fee → DD-token output excluded from the max: ${maxFee} DGB`);
await shot('34-send-max.png');

// ---- Broadcast the max send: mock rpc acks, zero-change tx goes out.
await click('w-send-go');
await waitFor(`${text('w-send-out')}.startsWith('Sent')`, 'max send broadcast acknowledged');
check(true, `max send broadcast: "${await evaluate(text('w-send-out'))}"`);

console.log('\nDone.');
ws.close();
