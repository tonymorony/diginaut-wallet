// Prove real transaction history (#69): drive the wallet UI against an inline
// fake indexer that serves the new /api/tx/:txid enrichment, and assert the
// Activity list shows direction, signed amounts, fees, dates, confirmation
// state, DD-type labels, and "Show more" pagination.
//
// Self-contained except Chrome. The wallet runs in-process (mock testnet node)
// with INDEXER_URL pointed at the fake. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-history.mjs   # exit 0 = all green
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

const now = Math.floor(Date.now() / 1000);

// ---- Canned chain data. The fake pins the FIRST address the wallet queries as
// "WALLET" (whatever the fresh in-browser seed derived) and serves history for
// it; every tx detail references WALLET on the wallet's side and made-up
// external addresses as counterparts. ----
const EXT_Y = 'dgbt1qpayee00000000000000000000000000payee0';
const EXT_X = 'dgbt1qsender0000000000000000000000000sendr0';
const EXT_COLL = 'dgbt1qcollateral0000000000000000000000coll0';
const TIP = 1_284_512; // = the mock node's `blocks`, or every confirm screen carries the stale-index warning (#H5)
const tx32 = (p) => p.repeat(64).slice(0, 64);

let WALLET = null;
const details = {}; // txid -> enriched /api/tx body
const history = []; // {txid, height}

function addTx(txid, height, body) { history.push({ txid, height }); details[txid] = { txid, ...body }; }

function build() {
  addTx(tx32('d3'), 0, { confirmations: 0, time: null, type: 'dgb',
    feeSats: null,
    vin: [{ address: EXT_X, valueSats: '500000000' }],
    vout: [{ n: 0, address: WALLET, valueSats: '500000000', ddCents: null }] });               // pending received +5
  // Self-consolidation with >40 wallet inputs: the indexer caps prevout
  // resolution, so inputs 41+ arrive null. The old net = ΣmyOut − ΣmyIn math
  // undercounted inMine and rendered a spurious "+X / Received"; the output-flow
  // model must call this "Sent to self" (nothing left the wallet). Regression
  // guard for the #69 review finding.
  addTx(tx32('f4'), 996, { confirmations: 8, time: now - 1800, type: 'dgb', feeSats: null,
    vin: [...Array.from({ length: 40 }, () => ({ address: WALLET, valueSats: '100000000' })),
          ...Array.from({ length: 5 }, () => ({ address: null, valueSats: null }))],
    vout: [{ n: 0, address: WALLET, valueSats: '4499000000', ddCents: null }] });               // 45 DGB in → one self output
  addTx(tx32('a0'), 995, { confirmations: 5, time: now - 3600, type: 'dgb',
    feeSats: '100000',
    vin: [{ address: WALLET, valueSats: '3000000000' }],
    vout: [{ n: 0, address: EXT_Y, valueSats: '1000000000', ddCents: null },
           { n: 1, address: WALLET, valueSats: '1999900000', ddCents: null }] });               // sent −10.001, fee 0.001, 5 conf
  addTx(tx32('b1'), 990, { confirmations: 10, time: now - 7200, type: 'mint',
    feeSats: '1000000',
    vin: [{ address: WALLET, valueSats: '20000000000' }],
    vout: [{ n: 0, address: EXT_COLL, valueSats: '19999000000', ddCents: null }] });             // mint −200
  addTx(tx32('c2'), 985, { confirmations: 15, time: now - 86400, type: 'dgb',
    feeSats: null,
    vin: [{ address: EXT_X, valueSats: '5000000000' }],
    vout: [{ n: 0, address: WALLET, valueSats: '5000000000', ddCents: null }] });                // received +50, final
  for (let i = 0; i < 6; i++) {
    addTx(tx32(String.fromCharCode(101) + i), 984 - i, { confirmations: 20, time: now - 200000 - i, type: 'dgb',
      feeSats: null,
      vin: [{ address: EXT_X, valueSats: '100000000' }],
      vout: [{ n: 0, address: WALLET, valueSats: '100000000', ddCents: null }] });               // +1 filler (pagination)
  }
}

const json = (res, body) => { const s = JSON.stringify(body); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) }); res.end(s); };
const indexer = createServer((req, res) => {
  const txm = req.url.match(/^\/api\/tx\/([0-9a-f]{64})$/);
  if (txm) return details[txm[1]] ? json(res, details[txm[1]]) : json(res, { error: 'unknown tx' });
  const m = req.url.match(/^\/api\/address\/([a-z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
  if (!m) { res.writeHead(404).end('{}'); return; }
  const [, address, what] = m;
  if (!WALLET) { WALLET = address; build(); }        // pin the first-seen wallet address
  const mine = address === WALLET;
  if (what === 'utxos') return json(res, { address, utxos: mine ? [{ txid: tx32('c2'), vout: 0, valueSats: '5000000000', height: 985 }] : [] });
  if (what === 'history') return json(res, { address, history: mine ? history : [] });
  if (what === 'positions') return json(res, { address, positions: [], tipHeight: TIP });
  return json(res, { address, totalCents: '0', utxos: [] });
});
await new Promise((r) => indexer.listen(0, r));
const wallet = startServer({ port: 0, indexerUrl: `http://127.0.0.1:${indexer.address().port}` });
await once(wallet, 'listening');
const APP = `http://127.0.0.1:${wallet.address().port}`;

// ---- CDP plumbing lives in ./lib/cdp.mjs — one copy for all drivers ----
const b = await connectCdp();
const { evaluate, waitFor, shot, setVal, click, check } = b;
const histText = () => evaluate(`document.getElementById('w-history').textContent`);
const rowCount = () => evaluate(`document.querySelectorAll('#w-history .tx').length`);

const visible = (id) => `document.getElementById('${id}').offsetParent !== null`;
// app.js is a module (async): re-issue the click until the target view appears.
async function clickUntil(id, untilExpr, label) {
  await waitFor(`(() => { document.getElementById('${id}').click(); return ${untilExpr}; })()`, label);
}

try {
  await b.navigate(APP);
  await waitFor(visible('hero-guest'), 'guest hero visible (app booted, no wallet)');
  // create a fresh wallet
  await clickUntil('hero-connect', visible('w-create-choice'), 'connect modal opens');
  await clickUntil('w-create-choice', visible('w-create'), 'create form shows');
  await setVal('w-create-pass', 'history flow pass');
  await setVal('w-create-pass2', 'history flow pass');
  await click('w-create');
  await waitFor(visible('w-backup-done'), 'backup view');
  await click('w-backup-done');
  await waitFor(`document.getElementById('w-money').style.display !== 'none'`, 'money view');

  // wait for enrichment to land (thin "Transaction" rows become typed rows)
  await waitFor(`document.getElementById('w-history').textContent.includes('Received')`, 'history enriched');
  const t = await histText();

  check(/Sent/.test(t) && /Received/.test(t), 'sent and received are visually distinct rows');
  check(/−10 DGB/.test(t), 'sent shows the amount that left the wallet (−10 DGB, fee shown separately)');
  check(/\+50 DGB/.test(t), 'received shows a signed positive amount (+50 DGB)');
  check(/fee 0\.001 DGB/.test(t), 'own-sent tx shows its fee (0.001 DGB)');
  check(/Sent to self/.test(t), '>40-input self-consolidation is "Sent to self", not a spurious positive (review regression)');
  check(/Minted DigiDollar/.test(t), 'DD mint is labeled, not shown as an anonymous DGB move');
  check(/to dgbt1qpaye/.test(t), 'counterpart address shown for the sent tx (to …)');
  check(/from dgbt1qsend/.test(t), 'counterpart address shown for a received tx (from …)');
  check(/pending/.test(t), 'mempool tx shows pending');
  check(/5 conf/.test(t), 'partially-confirmed tx shows its confirmation count');
  check(/final/.test(t), 'a 6+ conf tx shows final (Android parity)');
  check(/ago|\d{4}-\d\d-\d\d/.test(t), 'entries carry a timestamp / relative date');
  await evaluate(`document.querySelector('#w-history').scrollIntoView({block:'center'})`);
  await shot('92-history-enriched.png');

  // pagination: 11 txs → 8 shown + "Show more" → 11
  const before = await rowCount();
  check(before === 8, `history capped at 8 rows initially (got ${before})`);
  check(await evaluate(`!!document.getElementById('w-history-more')`), '"Show more" offered when >8 txs');
  await click('w-history-more');
  await waitFor(`document.querySelectorAll('#w-history .tx').length === 11`, 'show more reveals the rest');
  check((await rowCount()) === 11, 'all 11 txs reachable after "Show more"');

  console.log('\nDone.');
} finally {
  b.close();
  wallet.close();
  indexer.close();
}
