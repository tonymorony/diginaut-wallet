// Indexer JSON is untrusted (#H2): INDEXER_URL may be a third-party service, and
// the txids/vouts/values/lock heights it returns end up inside transactions the
// user signs — digidollar-js validates none of it (txbuild.js serializes
// `hexToBytes(txidHex).reverse()` and `u32le(vout)` as given, and a position's
// unlockHeight becomes the tx's nLockTime verbatim).
//
// Signing shapes are STRICT: one bad entry refuses the whole answer, because a
// silently-dropped UTXO is a wrong balance and a silently-dropped position is a
// coin the user cannot see. Display-only shapes are TOLERANT: drop the bad,
// render the good.
//
// Every validator returns FRESH object literals — never a spread of the parsed
// JSON — so `__proto__`/`constructor` keys in the payload cannot ride along.
//
// Zero imports on purpose: this module must load both in the browser
// (`import … from '/validate.js'`) and under node:test. `/lib/index.js` is a
// browser-only absolute path and the bare `digidollar-js` specifier is absent
// from index.html's importmap, so neither works on both sides.

// Mirrors digidollar-js src/index.js (COIN * 21e9). Duplicated rather than
// imported, per above; test/validate.test.js asserts equality with the real
// export so the copy cannot drift.
export const MAX_MONEY = 21_000_000_000n * 100_000_000n;
// DigiDollar cents share the money ceiling as a pure sanity bound. Deliberately
// NOT DD_TX_LIMITS: those are PER-TRANSACTION consensus limits, and totalCents
// or a redeem burn set are legitimate aggregates that can exceed them.
export const MAX_DD_CENTS = MAX_MONEY;
// ~47 years of 15s blocks. Anything above is not a chain height.
export const MAX_HEIGHT = 100_000_000;
// nLockTime below this is a block height, above it a unix timestamp (Core's
// LOCKTIME_THRESHOLD). A position's unlockHeight becomes nLockTime verbatim
// (digidollar-js txbuild.js), so it MUST stay on the height side.
export const LOCKTIME_THRESHOLD = 500_000_000;
// digidollar-js src/index.js LOCK_TIERS ids, in order.
export const TIER_IDS = Object.freeze([
  '1hour', '30days', '3months', '6months', '1year',
  '2years', '3years', '5years', '7years', '10years',
]);

export class IndexerDataError extends Error {
  constructor(detail) {
    super(`indexer returned malformed data — refusing to use it (${detail})`);
    this.name = 'IndexerDataError';
    // Key off THIS, never `instanceof` (two module identities across the
    // browser/node split) and never the copy (which gets edited).
    this.indexerData = true;
  }
}

const bad = (d) => { throw new IndexerDataError(d); };
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTxid = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isVout = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff; // u32le in txbuild.js
// Electrum uses height 0 for a mempool tx and -1 for unconfirmed-with-
// unconfirmed-parents in get_history: requiring >= 0 would reject real chains.
const isHeight = (v) => Number.isInteger(v) && v >= -1 && v <= MAX_HEIGHT;
// Canonical non-negative decimal integer string — no sign, no leading zeros, no
// exponent: the exact shape apps/indexer emits via String(BigInt(…)).
const DECIMAL = /^(0|[1-9][0-9]{0,25})$/;

const asMoney = (v, cap, what) => {
  if (typeof v !== 'string' || !DECIMAL.test(v)) bad(`${what} is not a decimal integer string`);
  const n = BigInt(v);
  if (n > cap) bad(`${what} exceeds the maximum`);
  return n;
};

/** The envelope every address-scoped endpoint shares. `address` is the one the
 *  CALLER derived — checking it catches a mixed-up parallel response, not just
 *  a malformed one (refreshMoney fires 4 of these per address concurrently). */
const shell = (json, address, what) => {
  if (!isObj(json)) bad(`${what} response is not an object`);
  if (json.address !== address) bad(`${what} response is for a different address`);
};

const entriesOf = (json, key, what) => {
  if (!Array.isArray(json[key])) bad(`${what}.${key} is not an array`);
  return json[key];
};

/** STRICT — feeds spendableUtxos() and therefore every signer input. */
export function validateUtxosResponse(json, address) {
  shell(json, address, 'utxos');
  const seen = new Set();
  const utxos = entriesOf(json, 'utxos', 'utxos').map((u, i) => {
    if (!isObj(u)) bad(`utxo ${i} is not an object`);
    if (!isTxid(u.txid)) bad(`utxo ${i} has a malformed txid`);
    if (!isVout(u.vout)) bad(`utxo ${i} has a malformed output index`);
    if (!isHeight(u.height)) bad(`utxo ${i} has a malformed height`);
    const valueSats = asMoney(u.valueSats, MAX_MONEY, `utxo ${i} value`);
    // A repeated outpoint would be counted twice by planSpend and then signed
    // twice into one transaction, which consensus rejects outright.
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key)) bad(`utxo ${i} repeats outpoint ${key}`);
    seen.add(key);
    // Decimal string, not BigInt: callers do both `Number(u.valueSats)`
    // (balance) and `BigInt(u.valueSats)` (signing) on this field.
    return { txid: u.txid, vout: u.vout, valueSats: String(valueSats), height: u.height };
  });
  return { address, utxos };
}

/** TOLERANT — only `.length` and the txid/height pair are ever read, and a
 *  dropped row costs an Activity entry, not money. */
export function validateHistoryResponse(json, address) {
  if (!isObj(json)) bad('history response is not an object');
  if (!Array.isArray(json.history)) bad('history.history is not an array');
  const history = json.history
    .filter((h) => isObj(h) && isTxid(h.txid) && isHeight(h.height))
    .map((h) => ({ txid: h.txid, height: h.height }));
  // Deliberately no dedupe/sort: refreshMoney already does both across addresses.
  return { address, history };
}

/** STRICT — `openPositions` feeds the redeem signer: `collateralSats` becomes
 *  the input value and `unlockHeight` becomes nLockTime + the CLTV push in the
 *  tapscript leaf. Validating here rather than in renderPositions keeps the
 *  render path and the signing path behind ONE gate (#L5 fix 1); note that a
 *  null/'' unlockHeight must NOT survive — `Number(null)` is 0, which is a
 *  perfectly plausible-looking height that unlocks everything immediately. */
export function validatePositionsResponse(json, address) {
  shell(json, address, 'positions');
  if (!Number.isInteger(json.tipHeight) || json.tipHeight < 0 || json.tipHeight > MAX_HEIGHT) {
    bad('positions tipHeight is not a chain height');
  }
  const seen = new Set();
  const positions = [];
  entriesOf(json, 'positions', 'positions').forEach((p, i) => {
    if (!isObj(p)) bad(`position ${i} is not an object`);
    if (!isTxid(p.txid)) bad(`position ${i} has a malformed txid`);
    if (!isHeight(p.height)) bad(`position ${i} has a malformed height`);
    const ddCents = asMoney(p.ddCents, MAX_DD_CENTS, `position ${i} amount`);
    if (ddCents <= 0n) bad(`position ${i} has a non-positive amount`);
    const collateralSats = asMoney(p.collateralSats, MAX_MONEY, `position ${i} collateral`);
    if (collateralSats <= 0n) bad(`position ${i} has non-positive collateral`);
    if (!Number.isInteger(p.unlockHeight) || p.unlockHeight <= 0 || p.unlockHeight >= LOCKTIME_THRESHOLD) {
      bad(`position ${i} has a malformed unlock height`);
    }
    if (!(p.tierId === null || TIER_IDS.includes(p.tierId))) bad(`position ${i} names an unknown lock tier`);
    if (typeof p.tierLabel !== 'string' || p.tierLabel.length > 64) bad(`position ${i} has a malformed tier label`);
    // A duplicated position would inflate the DigiDollar total before
    // renderPositions' own dedupe ever sees it.
    if (seen.has(p.txid)) return;
    seen.add(p.txid);
    positions.push({
      txid: p.txid,
      height: p.height,
      ddCents: String(ddCents),
      tierId: p.tierId,
      tierLabel: p.tierLabel,
      unlockHeight: p.unlockHeight,
      collateralSats: String(collateralSats),
    });
  });
  return { address, tipHeight: json.tipHeight, positions };
}

/** STRICT — feeds ddUtxosWithKeys(), i.e. the Transfer and Redemption signers. */
export function validateDdUtxosResponse(json, address) {
  shell(json, address, 'dd-utxos');
  const seen = new Set();
  let total = 0n;
  const utxos = entriesOf(json, 'utxos', 'dd-utxos').map((u, i) => {
    if (!isObj(u)) bad(`DigiDollar coin ${i} is not an object`);
    if (!isTxid(u.txid)) bad(`DigiDollar coin ${i} has a malformed txid`);
    if (!isVout(u.vout)) bad(`DigiDollar coin ${i} has a malformed output index`);
    if (!isHeight(u.height)) bad(`DigiDollar coin ${i} has a malformed height`);
    const cents = asMoney(u.cents, MAX_DD_CENTS, `DigiDollar coin ${i} amount`);
    if (cents <= 0n) bad(`DigiDollar coin ${i} has a non-positive amount`);
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key)) bad(`DigiDollar coin ${i} repeats outpoint ${key}`);
    seen.add(key);
    total += cents;
    return { txid: u.txid, vout: u.vout, cents: String(cents), height: u.height };
  });
  // The server sums the same coins the same way, so a disagreement is a tamper
  // or bug signal — and recomputing removes one trusted field entirely.
  if (json.totalCents !== String(total)) bad('dd-utxos total disagrees with its own coins');
  return { address, totalCents: String(total), utxos };
}

/** TOLERANT and never throws — Activity enrichment is decorative, and
 *  enrichVisible swallows failures anyway. POSITIONAL INTEGRITY: vin/vout
 *  entries are normalised in place, never dropped, because historyRow computes
 *  the displayed amount from output flow (Σ outputs to others / to us) and a
 *  missing member would silently change it. */
export function validateTxDetail(json) {
  const empty = { txid: null, confirmations: 0, time: null, type: 'dgb', feeSats: null, vin: [], vout: [] };
  if (!isObj(json)) return empty;
  const money = (v, cap) => (typeof v === 'string' && DECIMAL.test(v) && BigInt(v) <= cap ? v : null);
  const conf = Number.isFinite(Number(json.confirmations)) ? Math.max(0, Math.trunc(Number(json.confirmations))) : 0;
  const time = Number.isFinite(Number(json.time)) && Number(json.time) > 0 ? Math.trunc(Number(json.time)) : null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    txid: isTxid(json.txid) ? json.txid : null,
    confirmations: conf,
    time,
    // An unrecognised type is kept as-is: historyRow maps it through DD_LABEL
    // (falling back to a generic label) and never interpolates it raw.
    type: typeof json.type === 'string' && json.type.length <= 32 ? json.type : 'dgb',
    feeSats: money(json.feeSats, MAX_MONEY),
    // vin values stay null when unresolved — the coinbase test reads exactly
    // that (`address == null && valueSats == null`).
    vin: arr(json.vin).map((v) => (isObj(v)
      ? { address: typeof v.address === 'string' ? v.address : null, valueSats: money(v.valueSats, MAX_MONEY) }
      : { address: null, valueSats: null })),
    vout: arr(json.vout).map((o, i) => (isObj(o)
      ? {
        n: Number.isInteger(o.n) ? o.n : i,
        address: typeof o.address === 'string' ? o.address : null,
        valueSats: money(o.valueSats, MAX_MONEY) ?? '0',
        ddCents: money(o.ddCents, MAX_DD_CENTS),
      }
      : { n: i, address: null, valueSats: '0', ddCents: null })),
  };
}
