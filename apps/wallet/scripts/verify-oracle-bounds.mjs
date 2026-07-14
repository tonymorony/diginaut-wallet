// Oracle price bounds in the mint pre-check: consensus accepts $0.0001–$100
// per DGB (ORACLE_MIN/MAX_PRICE_MICRO_USD, Core primitives/oracle.h) — the
// wallet must NOT block sub-cent prices (DGB really trades around $0.0025;
// the old $0.01 floor froze every real-world mint). Prove all of it:
//   - price below $0.0001 → blocked BEFORE signing, message names the bounds,
//   - price above $100 → same,
//   - the real sub-cent price ($0.002546) → review proceeds to confirm,
//   - a 1-cent price (the old floor's edge) → still fine.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-oracle-bounds.mjs   # exit 0 = all green
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

// ---- stub DigiByte node: TESTNET (no interstitial), DD ACTIVE, settable price ----
const HEIGHT = 1_200_000;
let priceMicroUsd = 2_546; // real-world sub-cent DGB price, the case that was wrongly blocked
function nodeResult(method) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain: 'test', blocks: HEIGHT, headers: HEIGHT, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: { type: 'bip9', active: true, bip9: { status: 'active' } },
          taproot: { type: 'bip9', active: true, bip9: { status: 'active' } },
        },
      };
    case 'getoracleprice':
      return { price_micro_usd: priceMicroUsd, price_usd: priceMicroUsd / 1e6, is_stale: false, oracle_count: 35, status: 'ok' };
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

// ---- inline indexer stub (fake-indexer.mjs shape) ----
const funded = new Map(); // address → { utxos, ddCents, ddUtxos, positions }
const indexer = createServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = req.url.match(/^\/api\/address\/([a-zA-Z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
  if (!m) return json(404, { error: 'unknown path' });
  const [, address, what] = m;
  const e = funded.get(address) || { utxos: [], ddCents: '0', ddUtxos: [], positions: [] };
  if (what === 'utxos') return json(200, { address, utxos: e.utxos });
  if (what === 'history') return json(200, { address, history: e.utxos.map((u) => ({ txid: u.txid, height: u.height })) });
  if (what === 'positions') return json(200, { address, positions: e.positions, tipHeight: HEIGHT });
  if (what === 'dd-utxos') return json(200, { address, totalCents: e.ddCents, utxos: e.ddUtxos });
});
await new Promise((r) => indexer.listen(0, r));

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

// ================= wallet setup (testnet: no interstitial, no cap chrome) =================
await b.navigate(APP);
await waitFor(`document.getElementById('w-none').style.display !== 'none'`, 'no-wallet state');
await click('w-create-choice');
await setVal('w-create-pass', 'oracle bounds pass');
await setVal('w-create-pass2', 'oracle bounds pass');
await click('w-create');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet created + unlocked');
await click('w-backup-done');
const addr = await evaluate(text('w-address'));
check(/^dgbt1p/.test(addr), `testnet address derived (${addr.slice(0, 13)}…)`);

// fund: 10,000,000 tDGB — at $0.002546 the $100-min mint at 1000% needs ~3.93M DGB
funded.set(addr, {
  utxos: [{ txid: 'ab'.repeat(32), vout: 0, valueSats: '1000000000000000', height: HEIGHT - 1000 }],
  ddCents: '0', ddUtxos: [], positions: [],
});
await waitFor(`${text('w-balance')} === '10,000,000'`, 'funded balance renders');

// ================= 1. below the floor: $0.00005/DGB → blocked, names the real bounds =================
priceMicroUsd = 50;
await click('act-mint');
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await setVal('w-mint-amount', '100');
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('outside the consensus bounds')`, 'below-floor price blocked');
const errLow = await evaluate(text('w-mint-err'));
check(/\$0\.0001–\$100/.test(errLow) && /0\.00005/.test(errLow),
  `below $0.0001 blocked, message names the REAL bounds: "${errLow}"`);

// ================= 2. above the cap: $150/DGB → blocked =================
priceMicroUsd = 150_000_000;
await click('w-mint-review');
await waitFor(`${text('w-mint-err')}.includes('outside the consensus bounds')`, 'above-cap price blocked');
const errHigh = await evaluate(text('w-mint-err'));
check(/\$0\.0001–\$100/.test(errHigh) && /150/.test(errHigh), `above $100 blocked: "${errHigh}"`);

// ================= 3. THE fix: the real sub-cent price passes to confirm =================
priceMicroUsd = 2_546; // $0.002546/DGB — inside consensus bounds, was wrongly blocked before
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display === 'block'`, 'sub-cent price reaches the confirm screen');
const cPrice = await evaluate(text('w-mint-c-price'));
check(cPrice === '$0.002546 / DGB', `confirm screen quotes the sub-cent price EXACTLY (no 5-digit rounding): "${cPrice}"`);
check(!(await evaluate(text('w-mint-err'))), 'no error shown for the in-bounds sub-cent price');
await shot('99-subcent-mint-confirm.png');

// ================= 4. regression: a 1-cent price (the old wrong floor) still passes =================
priceMicroUsd = 10_000; // $0.01 — the boundary the old check used as its floor
await b.navigate(APP); // fresh flow state
await waitFor(`document.getElementById('w-unlock') !== null`, 'reload reaches unlock');
await setVal('w-unlock-pass', 'oracle bounds pass');
await click('w-unlock');
await waitFor(`document.getElementById('w-open').style.display !== 'none'`, 'wallet unlocked after reload');
await click('act-mint');
await evaluate(`document.getElementById('w-mint-tier').value = '1hour'`);
await setVal('w-mint-amount', '100');
await click('w-mint-review');
await waitFor(`document.getElementById('w-mint-confirm').style.display === 'block'`, '1-cent price reaches the confirm screen');
check(true, '$0.01/DGB still passes (old floor edge, regression)');

console.log(process.exitCode ? '\nFAILED' : '\nall green');
b.close();
node.close();
indexer.close();
server.close();
process.exit(process.exitCode || 0);
