// Drive #6: send DGB between two of the wallet's own addresses through the full
// real stack (regtest node + ElectrumX + indexer + faucet + wallet app).
// Proves: confirmation screen BEFORE signing, client-signed broadcast, pending
// history entry, and post-mining balances on both addresses. Setup:
//   PORT=8791 DGB_RPC_URL=http://127.0.0.1:18500 DGB_RPC_USER=dd DGB_RPC_PASS=ddpass \
//     FAUCET_URL=http://127.0.0.1:8790 INDEXER_URL=http://127.0.0.1:8789 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-send.mjs        # exit 0 = all checks green
import { writeFileSync } from 'node:fs';

const CDP_PORT = 9224;
const APP = 'http://127.0.0.1:8791';
const OUT = new URL('.', import.meta.url).pathname;
const RPC = 'http://127.0.0.1:18500';

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

// ---- Arrange: fresh wallet, funded by the faucet, confirmed.
await cdp('Page.navigate', { url: APP }, sessionId);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await setVal('w-create-pass', 'send flow pass');
await setVal('w-create-pass2', 'send flow pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'unlocked');
await click('w-backup-done'); // skip the backup ceremony overlay (spec §2)
const addr0 = await evaluate(text('w-address'));

// Fund directly from the stand wallet (the faucet path is #7's verify; its
// 24h per-IP rate limit would make this driver single-shot otherwise).
await nodeRpc('sendtoaddress', [addr0, 500], 'stand');
await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress', [], 'stand')], 'stand');
await waitFor(`${text('w-balance')} !== '0' && ${text('w-balance')} !== '—'`, 'faucet funds confirmed');
const balanceBefore = await evaluate(text('w-balance'));
check(true, `wallet funded and confirmed: ${balanceBefore} DGB on ${addr0.slice(0, 16)}…`);

// second own address = the recipient (AC: send between two own addresses)
await click('w-next');
const addr1 = await evaluate(text('w-address'));
check(addr1 !== addr0, `second own address derived: ${addr1.slice(0, 16)}…`);

// ---- Review: confirmation screen appears, NOTHING broadcast or signed yet.
await setVal('w-send-to', addr1);
await setVal('w-send-amount', '123.45');
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'confirmation screen');
const cTo = await evaluate(text('w-send-c-to'));
const cAmount = await evaluate(text('w-send-c-amount'));
const cFee = await evaluate(text('w-send-c-fee'));
check(cTo === addr1, `confirmation shows the recipient: ${cTo.slice(0, 16)}…`);
check(cAmount === '123.45', `confirmation shows the amount: ${cAmount} DGB`);
check(Number(cFee) > 0 && Number(cFee) < 0.01, `confirmation shows a standard relay fee: ${cFee} DGB (not the 0.1 DD floor)`);
const mempoolAtReview = await nodeRpc('getrawmempool');
check(mempoolAtReview.length === 0, 'nothing reached the node at review time (signing deferred)');
await shot('30-send-confirm.png');

// cancel really cancels
await click('w-send-cancel');
check(await evaluate(`document.getElementById('w-send-confirm').style.display === 'none'`), 'cancel dismisses the confirmation');
check((await nodeRpc('getrawmempool')).length === 0, 'cancel broadcasts nothing');
// Cancel ABANDONS the draft: resetSend() clears the amount (and disarms Max)
// so an abandoned draft can never be re-planned as a full drain (#116). The
// recipient survives; the amount must be re-entered — assert that, don't just
// work around it.
check((await evaluate(`document.getElementById('w-send-amount').value`)) === '',
  'cancel clears the amount field — an abandoned draft cannot be re-planned (#116)');

// ---- Confirm & send: client-signed tx hits the mempool, history shows pending.
await setVal('w-send-amount', '123.45');
await click('w-send-review');
await waitFor(`document.getElementById('w-send-confirm').style.display !== 'none'`, 'confirmation screen again');
await click('w-send-go');
await waitFor(`${text('w-send-out')}.startsWith('Sent')`, 'broadcast acknowledged');
const sentNote = await evaluate(text('w-send-out'));
const mempool = await nodeRpc('getrawmempool');
check(mempool.length === 1, `client-signed tx accepted into the mempool: ${mempool[0]?.slice(0, 16)}…`);
check(sentNote.includes(mempool[0]?.slice(0, 16)), `UI reports the same txid: "${sentNote}"`);
await waitFor(`${text('w-history')}.includes('pending')`, 'history shows the tx as pending');
check(true, 'transaction appears in history as PENDING before mining');
await shot('31-send-pending.png');

// the tx itself: vout[0] pays addr1 exactly 123.45 DGB
const sentTx = await nodeRpc('getrawtransaction', [mempool[0], true]);
check(sentTx.vout[0].scriptPubKey.address === addr1 && sentTx.vout[0].value === 123.45,
  `on-node tx pays ${sentTx.vout[0].value} DGB to the chosen own address`);
check(sentTx.version === 2, 'plain version-2 transaction (no DD envelope)');

// ---- Mine: funds arrive; total balance drops only by the fee.
await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress', [], 'stand')], 'stand');
// Once #69's enrichment lands the row shows the confirmation COUNT ("1 conf",
// "✓ final" at 6+), not the literal "confirmed" of the thin pre-enrichment row.
await waitFor(
  `/\\d+\\s*conf|✓\\s*final|confirmed/.test(${text('w-history')}) && !${text('w-history')}.includes('pending')`,
  'history confirmed');
// The UI rounds to 2 decimals, so measure the drop in sats via the indexer:
// both addresses are ours — the wallet total must shrink by exactly the fee.
const utxosOf = async (a) => (await (await fetch(`http://127.0.0.1:8789/api/address/${a}/utxos`)).json()).utxos;
const totalSats = (await utxosOf(addr0)).concat(await utxosOf(addr1))
  .reduce((s, u) => s + BigInt(u.valueSats), 0n);
const feeSats = BigInt(Math.round(Number(cFee) * 1e8));
check(totalSats === 50_000_000_000n - feeSats,
  `wallet total dropped by exactly the fee: ${totalSats} = 500 DGB − ${feeSats} sats`);
check((await utxosOf(addr1)).some((u) => u.valueSats === '12345000000' && u.height > 0),
  'indexer sees the 123.45 DGB UTXO confirmed on the second address');
await shot('32-send-confirmed.png');

console.log('\nDone.');
ws.close();
