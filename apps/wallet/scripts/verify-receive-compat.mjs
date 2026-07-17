// Drive #103: receive compat toggle, unified twin-coin balance, and guided
// consolidation — MOCK MODE (mock /api/rpc + fake-indexer.mjs), no regtest.
// Proves:
//   1. (decision 1) the receive modal is taproot-first; the low-emphasis
//      "Sender can't pay this address?" link reveals the SAME index's P2WPKH
//      twin (dgb1q…) with its own QR + copy button, and the BIP21 request
//      amount applies to whichever address is shown; re-opening re-hides it.
//      The twin is verified INDEPENDENTLY: the driver re-derives it from the
//      revealed seed with digidollar-js, not by trusting the page.
//   2. (decision 3) a coin sitting on the twin address is part of the ONE
//      displayed DGB balance — no separate compatibility-coins line.
//   3. (decision 2) a fragmented mint error ("no single coin is large
//      enough") reveals a "Consolidate coins" offer; the modal plans ONE
//      self-spend of ALL confirmed coins (twin included) to the current
//      taproot address with the fee shown; Confirm signs + broadcasts. The
//      built tx is asserted structurally (2 segwit inputs = both funding
//      txids, exactly one output = the wallet's own P2TR script, no change).
//      The transfer fee-missing variant is driven too (DD on the current
//      address, DGB only on the twin → offer shown).
// Mock limits (say so honestly): the mock node accepts sendrawtransaction
// with a FAKE txid and the fake indexer never updates, so the consolidation
// cannot be observed confirming here — the tx SHAPE and the full confirm
// ceremony are asserted instead. The regtest e2e leg covers real broadcast +
// confirm + retry on the server.
//
// Setup (fresh --user-data-dir per run, mock wallet server + fake indexer):
//   PORT=8799 node apps/wallet/scripts/fake-indexer.mjs &
//   PORT=8791 INDEXER_URL=http://127.0.0.1:8799 node apps/wallet/server.js &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   cd apps/wallet/scripts && node verify-receive-compat.mjs
import { connectCdp } from './lib/cdp.mjs';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS, scriptPubKeyFromAddress } from 'digidollar-js';

const APP = process.env.APP_URL || 'http://127.0.0.1:8791';
const INDEXER = process.env.INDEXER_URL || 'http://127.0.0.1:8799';

const fund = (address, body) =>
  fetch(`${INDEXER}/__fund`, { method: 'POST', body: JSON.stringify({ address, ...body }) });

const b = await connectCdp();
const { evaluate, waitFor, shot, check, text, setVal, click } = b;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;

// ---- Arrange: fresh wallet in mock mode (chain 'test' → testnet addresses).
await b.navigate(APP);
await waitFor(visible('w-none'), 'no-wallet state');
await setVal('w-create-pass', 'compat flow pass');
await setVal('w-create-pass2', 'compat flow pass');
await click('w-create');
await waitFor(visible('w-open'), 'unlocked');
await click('w-backup-done'); // skip the backup ceremony overlay (spec §2)
await waitFor(`${text('w-address')}.startsWith('dgbt1p')`, 'taproot receive address rendered');
const addr0 = await evaluate(text('w-address'));

// capture the seed (re-auth → reveal) so the twin can be derived independently
await click('w-backup');
await waitFor(`document.getElementById('reauth-modal').classList.contains('open')`, 're-auth prompt');
await setVal('reauth-pass', 'compat flow pass');
await click('reauth-go');
await waitFor(visible('w-seed'), 'seed view');
await click('w-seed-show');
const mnemonic = (await evaluate(text('w-seed-words'))).trim().split(/\s+/).join(' ');
await click('w-backup'); // hide again
const derived = deriveTaprootAddress(mnemonicToSeed(mnemonic), { ...HD_NETWORKS.testnet, index: 0 });
check(derived.address === addr0, `driver re-derives the SAME taproot address from the seed: ${addr0.slice(0, 20)}…`);
const expectedTwin = derived.p2wpkhAddress;

// ---- Decision 1: taproot-first receive with the compat toggle.
await click('act-receive');
await waitFor(`document.getElementById('receive-modal').classList.contains('open')`, 'receive modal open');
await click('w-receive-anyway'); // not backed up → interception first (spec §3), then the body
await waitFor(visible('w-receive-body'), 'receive body after the guard');
check(!(await evaluate(visible('w-compat-section'))), 'compat section hidden by default — receive stays taproot-first');
check((await evaluate(text('w-compat-toggle'))).includes('pay this address'),
  'low-emphasis toggle link present: ' + await evaluate(text('w-compat-toggle')));
await click('w-compat-toggle');
await waitFor(visible('w-compat-section'), 'compat section revealed');
const twin = await evaluate(text('w-compat-address'));
check(twin === expectedTwin && twin.startsWith('dgbt1q'),
  `twin shown IS the same key's P2WPKH (independently derived, same index): ${twin.slice(0, 20)}…`);
check(await evaluate(`document.querySelectorAll('#w-compat-qr svg').length === 1`), 'twin has its own QR');
// BIP21 request amount applies to whichever address is shown
await setVal('w-req-amount', '12.5');
check(await evaluate(visible('w-copy-uri')), 'request amount → taproot payment-request button appears');
check(await evaluate(visible('w-compat-copy-uri')), 'request amount → twin payment-request button appears too');
await shot('97-receive-compat.png');
await setVal('w-req-amount', '');
check(!(await evaluate(visible('w-compat-copy-uri'))), 'clearing the amount reverts the twin view to bare address');
// re-opening the modal must re-hide the twin (taproot-first every open)
await evaluate(`document.getElementById('receive-modal').classList.remove('open')`);
await click('act-receive');
await click('w-receive-anyway');
check(!(await evaluate(visible('w-compat-section'))), 're-open → compat section hidden again');
await evaluate(`document.getElementById('receive-modal').classList.remove('open')`);

// ---- Decision 3: a twin coin is part of the ONE displayed balance.
const txidA = 'aa'.repeat(31) + '01'; // P2TR coin
const txidB = 'bb'.repeat(31) + '02'; // twin (P2WPKH) coin
await fund(addr0, { utxos: [{ txid: txidA, vout: 0, valueSats: '4000000000000', height: 100 }] });
await fund(expectedTwin, { utxos: [{ txid: txidB, vout: 1, valueSats: '4000000000000', height: 101 }] });
await waitFor(`${text('w-balance')} === '80,000'`, 'balance includes the twin coin');
check(true, 'DGB balance is UNIFIED: 40k P2TR + 40k twin → shows 80,000 (no separate compatibility line)');
check((await evaluate(text('as-dgb'))) === '80,000', 'asset row shows the same unified figure');

// ---- Decision 2: fragmented mint error → Consolidate coins offer.
// $100 at the 1hour tier (1000%) at the mock $0.01342 needs ≈ 75,260 DGB in
// ONE P2TR coin — total 80,000 covers it, no single coin does.
await click('act-mint');
await waitFor(`document.getElementById('mint-modal').classList.contains('open')`, 'mint modal open');
await evaluate(`{ const s = document.getElementById('w-mint-tier'); s.value = '1hour'; s.dispatchEvent(new Event('change',{bubbles:true})); }`);
await setVal('w-mint-amount', '100');
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('no single coin')`, 'fragmented-funds error');
await waitFor(visible('w-mint-err-consolidate'), 'Consolidate coins offer revealed');
check(true, 'fragmentation error reveals the "Consolidate coins" offer (never automatic)');
await shot('98-consolidate-offer.png');

// capture the raw hex the page broadcasts, without blocking the mock reply
await evaluate(`{
  window.__sentHexes = [];
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (url === '/api/rpc' && opts?.body?.includes('sendrawtransaction')) {
      window.__sentHexes.push(JSON.parse(opts.body).params[0]);
    }
    return orig(url, opts);
  };
}`);

await click('w-mint-err-consolidate');
await waitFor(`document.getElementById('consolidate-modal').classList.contains('open')`, 'consolidate modal open');
await waitFor(visible('w-cons-confirm'), 'consolidation confirm ceremony planned');
check((await evaluate(text('w-cons-c-count'))) === '2', 'plan merges BOTH coins (twin included)');
check((await evaluate(text('w-cons-c-to'))) === addr0, 'destination is the wallet\'s current taproot address');
// fee model: 42 (overhead) + 230 (P2TR in) + 272 (P2WPKH in) + 172 (P2TR out)
// = 716 wu → 179 vB → 17,900 sats at the 100k sats/kvB relay rate
check((await evaluate(text('w-cons-c-fee'))) === '0.000179', 'fee shown and priced for the mixed input set: 0.000179 DGB');
check((await evaluate(text('w-cons-c-amount'))) === '79,999.999821', 'amount = full balance − fee (nothing left behind)');
await shot('99-consolidate-confirm.png');

await click('w-cons-go');
await waitFor(`document.getElementById('consolidate-modal').classList.contains('success')`, 'broadcast success view');
check((await evaluate(`document.querySelector('#consolidate-modal .tx-title').textContent`)) === 'Consolidation sent',
  'success view confirms the consolidation was sent');
check(/retry the action/.test(await evaluate(`document.querySelector('#consolidate-modal .tx-note').textContent`)),
  'success view tells the user to retry the original action once it confirms');

// ---- Structural assertions on the built tx (mock can't confirm it).
const hex = await evaluate(`window.__sentHexes[0]`);
const rev = (h) => h.match(/../g).reverse().join('');
check(typeof hex === 'string' && hex.startsWith('02000000' + '0001' + '02'),
  'built tx: version-2 segwit with exactly 2 inputs');
check(hex.includes(rev(txidA)) && hex.includes(rev(txidB)),
  'built tx spends BOTH funding coins — the P2WPKH twin is in the consolidation input set');
const script = scriptPubKeyFromAddress(addr0);
// inputs: 2 × (32 txid + 4 vout + 1 empty-script + 4 sequence) = 82 bytes; the
// output-count varint sits right after them → offset 8+4+2+2·82·2 chars
check(hex.slice(178, 180) === '01', 'built tx has exactly ONE output — a pure self-spend, no change');
check(hex.split('22' + script).length === 2, 'that output pays the wallet\'s own current taproot script');

// ---- Decision 2 (transfer variant): DD on the current address, DGB only on
// the twin → the fee gate fails and the SAME offer appears (consolidation
// would land the twin DGB as P2TR right where the fee is missing).
await evaluate(`document.getElementById('consolidate-modal').classList.remove('open')`);
await evaluate(`document.getElementById('mint-modal').classList.remove('open')`);
await fund(addr0, { utxos: [], ddCents: '500', ddUtxos: [{ txid: 'cc'.repeat(31) + '03', vout: 1, cents: '500', height: 102 }] });
await waitFor(`${text('w-dd-balance')} === '5.00'`, 'DD balance visible');
const ddAddr = await evaluate(text('w-dd-address'));
await click('act-send');
await evaluate(`{ const s = document.getElementById('send-asset'); s.value = 'dd'; s.dispatchEvent(new Event('change',{bubbles:true})); }`);
await setVal('w-tr-to', ddAddr);
await setVal('w-tr-amount', '2');
await click('w-tr-review');
await waitFor(`${text('w-tr-err')}.includes('no DGB for the fee')`, 'transfer fee-missing error');
await waitFor(visible('w-tr-err-consolidate'), 'transfer error also offers Consolidate coins');
check(true, 'fee-missing-on-current-address transfer error reveals the same guided consolidation');

console.log('\nDone.');
b.close();
process.exit(process.exitCode || 0);
