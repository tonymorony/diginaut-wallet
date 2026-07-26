import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dd from 'digidollar-js';
import {
  MAX_MONEY, MAX_HEIGHT, LOCKTIME_THRESHOLD, TIER_IDS,
  validateUtxosResponse, validateHistoryResponse, validatePositionsResponse,
  validateDdUtxosResponse, validateTxDetail,
} from '../public/validate.js';

// #H2: indexer JSON is untrusted and reaches the signers. Signing shapes refuse
// the whole answer on one bad entry; display shapes drop the bad and keep the
// good. #L5 folds position lock-height validation into the same gate.

const ADDR = 'dgb1qexampleaddress0000000000000000000000';
const TXID = 'ab'.repeat(32);
const TXID2 = 'cd'.repeat(32);

/** Assert the thrown error is the machine-flagged malformed-data error. */
const rejects = (fn, why) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${why}: expected the answer to be refused`);
  // app.js branches on this flag, never on instanceof or on the copy
  assert.equal(err.indexerData, true, `${why}: carries the indexerData flag`);
  assert.match(err.message, /malformed data/, why);
};

// ---- constants must not drift from the protocol library ----

test('mirrored constants match digidollar-js', () => {
  // validate.js re-declares these because it must load in both the browser and
  // node:test; this is the drift guard that makes the copy safe.
  assert.equal(MAX_MONEY, dd.MAX_MONEY);
  assert.deepEqual([...TIER_IDS], dd.LOCK_TIERS.map((t) => t.id));
  assert.equal(LOCKTIME_THRESHOLD, 500_000_000); // Core's LOCKTIME_THRESHOLD
});

// ---- /address/:a/utxos — STRICT (feeds every signer input) ----

const utxosJson = (utxos, address = ADDR) => ({ address, utxos });

test('utxos: a well-formed answer survives with canonical values', () => {
  const out = validateUtxosResponse(
    utxosJson([{ txid: TXID, vout: 3, valueSats: '123456789', height: 900 }]), ADDR);
  assert.deepEqual(out, { address: ADDR, utxos: [{ txid: TXID, vout: 3, valueSats: '123456789', height: 900 }] });
  // decimal STRING, not BigInt: callers do Number() for balance and BigInt() for signing
  assert.equal(typeof out.utxos[0].valueSats, 'string');
});

test('utxos: mempool (0) and unconfirmed-parent (-1) heights are legitimate', () => {
  for (const height of [0, -1]) {
    const out = validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats: '1', height }]), ADDR);
    assert.equal(out.utxos[0].height, height);
  }
  rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats: '1', height: -2 }]), ADDR),
    'height below the Electrum floor');
  rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats: '1', height: MAX_HEIGHT + 1 }]), ADDR),
    'height beyond any plausible chain');
  rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats: '1', height: 1.5 }]), ADDR),
    'fractional height');
});

test('utxos: a malformed txid is refused, not silently serialized short', () => {
  // txbuild.js does hexToBytes(txidHex).reverse() with no length check — a
  // 62-char "txid" produces a 31-byte outpoint in a signed transaction.
  rejects(() => validateUtxosResponse(utxosJson([{ txid: 'ab'.repeat(31), vout: 0, valueSats: '1', height: 1 }]), ADDR),
    '62-char txid');
  rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID.toUpperCase(), vout: 0, valueSats: '1', height: 1 }]), ADDR),
    'uppercase txid');
  rejects(() => validateUtxosResponse(utxosJson([{ txid: 'zz'.repeat(32), vout: 0, valueSats: '1', height: 1 }]), ADDR),
    'non-hex txid');
  rejects(() => validateUtxosResponse(utxosJson([{ txid: null, vout: 0, valueSats: '1', height: 1 }]), ADDR),
    'null txid');
});

test('utxos: output index must be a real u32', () => {
  for (const vout of [-1, 1.5, '0', null, 0x1_0000_0000]) {
    rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID, vout, valueSats: '1', height: 1 }]), ADDR),
      `vout ${String(vout)}`);
  }
});

test('utxos: values must be canonical non-negative decimal strings within MAX_MONEY', () => {
  for (const valueSats of ['-1', '1.5', '1e9', '007', ' 1', '', 1000, null, String(MAX_MONEY + 1n)]) {
    rejects(() => validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats, height: 1 }]), ADDR),
      `valueSats ${String(valueSats)}`);
  }
  const out = validateUtxosResponse(utxosJson([{ txid: TXID, vout: 0, valueSats: String(MAX_MONEY), height: 1 }]), ADDR);
  assert.equal(out.utxos[0].valueSats, String(MAX_MONEY));
});

test('utxos: a repeated outpoint is refused — planSpend would count it twice', () => {
  rejects(() => validateUtxosResponse(utxosJson([
    { txid: TXID, vout: 0, valueSats: '5', height: 1 },
    { txid: TXID, vout: 0, valueSats: '5', height: 1 },
  ]), ADDR), 'duplicate outpoint');
  // same txid, different index is a perfectly normal pair
  const out = validateUtxosResponse(utxosJson([
    { txid: TXID, vout: 0, valueSats: '5', height: 1 },
    { txid: TXID, vout: 1, valueSats: '5', height: 1 },
  ]), ADDR);
  assert.equal(out.utxos.length, 2);
});

test('utxos: an answer for another address is refused', () => {
  rejects(() => validateUtxosResponse(utxosJson([], 'dgb1qsomeoneelse'), ADDR), 'mixed-up address');
  rejects(() => validateUtxosResponse({ utxos: [] }, ADDR), 'missing address');
  rejects(() => validateUtxosResponse(null, ADDR), 'null body');
  rejects(() => validateUtxosResponse([], ADDR), 'array body');
  rejects(() => validateUtxosResponse({ address: ADDR, utxos: 'nope' }, ADDR), 'utxos not an array');
  rejects(() => validateUtxosResponse({ address: ADDR, utxos: [null] }, ADDR), 'null entry');
});

test('utxos: __proto__ in the payload cannot ride along', () => {
  const json = JSON.parse(
    `{"address":"${ADDR}","utxos":[{"txid":"${TXID}","vout":0,"valueSats":"7","height":2,"__proto__":{"polluted":1}}]}`);
  const out = validateUtxosResponse(json, ADDR);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.keys(out.utxos[0]), ['txid', 'vout', 'valueSats', 'height']);
});

// ---- /address/:a/history — TOLERANT (a dropped row costs a list entry) ----

test('history: garbage rows are dropped, good rows kept in order', () => {
  const out = validateHistoryResponse({
    address: ADDR,
    history: [
      { txid: TXID, height: 10 },
      { txid: 'nope', height: 11 },
      null,
      { txid: TXID2, height: -1 },
      { txid: TXID2, height: 'soon' },
    ],
  }, ADDR);
  assert.deepEqual(out.history, [{ txid: TXID, height: 10 }, { txid: TXID2, height: -1 }]);
});

test('history: only a structurally broken body throws', () => {
  rejects(() => validateHistoryResponse({ address: ADDR }, ADDR), 'missing history array');
  rejects(() => validateHistoryResponse(null, ADDR), 'null body');
  assert.deepEqual(validateHistoryResponse({ address: ADDR, history: [] }, ADDR), { address: ADDR, history: [] });
});

// ---- /address/:a/positions — STRICT (feeds the redeem signer + nLockTime) ----

const position = (over = {}) => ({
  txid: TXID, height: 900, ddCents: '10000', tierId: '1year',
  tierLabel: '1 year', unlockHeight: 1_000_000, collateralSats: '5000000000', ...over,
});
const positionsJson = (positions, over = {}) => ({ address: ADDR, tipHeight: 950_000, positions, ...over });

test('positions: a well-formed answer survives with canonical money strings', () => {
  const out = validatePositionsResponse(positionsJson([position()]), ADDR);
  assert.equal(out.tipHeight, 950_000);
  assert.deepEqual(out.positions, [position()]);
});

test('positions: the unlock height must stay a block height (#L5)', () => {
  // It becomes the transaction's nLockTime verbatim; at or above Core's
  // LOCKTIME_THRESHOLD consensus reads it as a unix timestamp instead.
  const ok = validatePositionsResponse(positionsJson([position({ unlockHeight: LOCKTIME_THRESHOLD - 1 })]), ADDR);
  assert.equal(ok.positions[0].unlockHeight, LOCKTIME_THRESHOLD - 1);
  rejects(() => validatePositionsResponse(positionsJson([position({ unlockHeight: LOCKTIME_THRESHOLD })]), ADDR),
    'unlockHeight at the timestamp threshold');
  // null/''/'1000' all coerce to a plausible-looking number via Number() — the
  // exact trap #L5 calls out — so the type check must be on the raw value.
  for (const unlockHeight of [null, undefined, '', '1000', 0, -5, 1.5, NaN, true]) {
    rejects(() => validatePositionsResponse(positionsJson([position({ unlockHeight })]), ADDR),
      `unlockHeight ${String(unlockHeight)}`);
  }
});

test('positions: amounts, collateral, tier and tip are all checked', () => {
  rejects(() => validatePositionsResponse(positionsJson([position({ ddCents: '0' })]), ADDR), 'zero DigiDollar amount');
  rejects(() => validatePositionsResponse(positionsJson([position({ ddCents: '-1' })]), ADDR), 'negative amount');
  rejects(() => validatePositionsResponse(positionsJson([position({ collateralSats: '0' })]), ADDR), 'zero collateral');
  rejects(() => validatePositionsResponse(positionsJson([position({ collateralSats: String(MAX_MONEY + 1n) })]), ADDR),
    'collateral over MAX_MONEY');
  rejects(() => validatePositionsResponse(positionsJson([position({ tierId: '4years' })]), ADDR), 'unknown tier id');
  rejects(() => validatePositionsResponse(positionsJson([position({ tierLabel: 42 })]), ADDR), 'non-string tier label');
  rejects(() => validatePositionsResponse(positionsJson([position({ tierLabel: 'x'.repeat(65) })]), ADDR), 'oversized tier label');
  rejects(() => validatePositionsResponse(positionsJson([position()], { tipHeight: -1 }), ADDR), 'negative tip');
  rejects(() => validatePositionsResponse(positionsJson([position()], { tipHeight: '950000' }), ADDR), 'tip as a string');
  // an un-tiered position is legitimate: the indexer emits null for a lock tier
  // it does not recognise
  const out = validatePositionsResponse(positionsJson([position({ tierId: null })]), ADDR);
  assert.equal(out.positions[0].tierId, null);
});

test('positions: a duplicated position cannot inflate the DigiDollar total', () => {
  const out = validatePositionsResponse(positionsJson([position(), position()]), ADDR);
  assert.equal(out.positions.length, 1);
});

// ---- /address/:a/dd-utxos — STRICT (feeds Transfer and Redemption) ----

test('dd-utxos: the total is recomputed, and a disagreeing one is refused', () => {
  const utxos = [
    { txid: TXID, vout: 0, cents: '2500', height: 10 },
    { txid: TXID2, vout: 1, cents: '1500', height: 11 },
  ];
  const out = validateDdUtxosResponse({ address: ADDR, totalCents: '4000', utxos }, ADDR);
  assert.equal(out.totalCents, '4000');
  assert.equal(out.utxos.length, 2);
  rejects(() => validateDdUtxosResponse({ address: ADDR, totalCents: '9999', utxos }, ADDR), 'total disagrees');
  rejects(() => validateDdUtxosResponse({ address: ADDR, totalCents: 4000, utxos }, ADDR), 'total not a string');
});

test('dd-utxos: coin shape is as strict as a DGB coin', () => {
  const one = (over) => ({ address: ADDR, totalCents: '100', utxos: [{ txid: TXID, vout: 0, cents: '100', height: 3, ...over }] });
  assert.equal(validateDdUtxosResponse(one({}), ADDR).utxos[0].cents, '100');
  rejects(() => validateDdUtxosResponse(one({ txid: 'ab' }), ADDR), 'short txid');
  rejects(() => validateDdUtxosResponse(one({ vout: -1 }), ADDR), 'negative vout');
  rejects(() => validateDdUtxosResponse(one({ height: 'soon' }), ADDR), 'non-numeric height');
  rejects(() => validateDdUtxosResponse({
    address: ADDR, totalCents: '200', utxos: [
      { txid: TXID, vout: 0, cents: '100', height: 3 },
      { txid: TXID, vout: 0, cents: '100', height: 3 },
    ],
  }, ADDR), 'duplicate DigiDollar outpoint');
});

// ---- /tx/:txid — TOLERANT and never throws (Activity enrichment) ----

test('tx detail: a junk body yields a safe empty shape instead of throwing', () => {
  for (const junk of [null, undefined, 'string', 42, []]) {
    const out = validateTxDetail(junk);
    assert.deepEqual(out.vin, []);
    assert.deepEqual(out.vout, []);
    assert.equal(out.confirmations, 0);
    assert.equal(out.type, 'dgb');
  }
});

test('tx detail: vin/vout keep their positions — a dropped output changes the amount', () => {
  const out = validateTxDetail({
    txid: TXID,
    confirmations: '7',
    time: 1_700_000_000,
    type: 'mint',
    feeSats: '100000',
    vin: [{ address: 'dgb1qsender', valueSats: '500' }, null, { address: null, valueSats: null }],
    vout: [{ n: 0, address: 'dgb1qother', valueSats: '400' }, 'garbage', { n: 2, address: ADDR, valueSats: 'nope', ddCents: '250' }],
  });
  assert.equal(out.confirmations, 7);
  assert.equal(out.type, 'mint');
  assert.equal(out.feeSats, '100000');
  assert.equal(out.vin.length, 3);
  // an unresolved input stays null/null — the coinbase test reads exactly that
  assert.deepEqual(out.vin[1], { address: null, valueSats: null });
  assert.equal(out.vout.length, 3);
  assert.deepEqual(out.vout[1], { n: 1, address: null, valueSats: '0', ddCents: null });
  assert.equal(out.vout[2].valueSats, '0'); // unparseable value reads as zero, never as markup
  assert.equal(out.vout[2].ddCents, '250');
});

test('tx detail: nonsense scalars are normalised, not trusted', () => {
  const out = validateTxDetail({ txid: 'not-a-txid', confirmations: -5, time: 'yesterday', feeSats: '1e9' });
  assert.equal(out.txid, null);
  assert.equal(out.confirmations, 0);
  assert.equal(out.time, null);
  assert.equal(out.feeSats, null);
});
