// The broadcast journal (#C1). Three separable properties, each with its own
// failure mode:
//   txidFromSignedHex        — a WRONG txid is worse than none (every recovery
//                              decision downstream would be about another tx),
//                              so it is pinned against Core-captured fixtures.
//   createBroadcastLog       — must never throw out of a method: a storage
//                              failure has to degrade the trace, not the send.
//   classifyBroadcastError   — must fail AMBIGUOUS. Getting this backwards
//                              reintroduces the finding while looking fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSpend, buildSignedSpendTx } from 'digidollar-js';
import {
  txidFromSignedHex, createBroadcastLog, classifyBroadcastError, BROADCAST_LOG_KEY,
} from '../public/broadcastlog.js';
import { friendlyRejectError } from '../public/dderrors.js';

const fixture = (name) => JSON.parse(
  readFileSync(new URL(`../../../packages/digidollar-js/test/fixtures/${name}.json`, import.meta.url), 'utf8'),
).result;

// ---- txidFromSignedHex ----

test('reproduces the real Core txid for every captured DigiDollar tx shape', () => {
  // Core-captured hex→txid pairs: these pin the witness-stripping rule against
  // the real consensus serialization, not against our own encoder.
  for (const name of ['mint-tx', 'spend-tx', 'transfer-tx', 'redeem-tx']) {
    const { hex, txid } = fixture(name);
    assert.equal(txidFromSignedHex(hex), txid, name);
  }
});

test('parses a locally built tx with mixed P2TR + P2WPKH witnesses', () => {
  // A v0 input's witness is [DER sig, pubkey] — two items of variable length,
  // where taproot has one fixed-length item. The parser must skip both.
  const utxos = [
    { txidHex: 'aa'.repeat(32), vout: 0, valueSats: 500_000_000n, privKeyHex: '71'.repeat(32) },
    { txidHex: 'bb'.repeat(32), vout: 1, valueSats: 300_000_000n, privKeyHex: '72'.repeat(32), type: 'p2wpkh' },
  ];
  const recipientScriptHex = '5120' + '73'.repeat(32);
  const amountSats = 750_000_000n;
  const plan = planSpend({ utxos, amountSats, recipientScriptHex });
  assert.equal(plan.inputs.length, 2, 'both inputs are needed for this amount');
  const { hex } = buildSignedSpendTx({
    utxos: plan.inputs,
    recipientScriptHex,
    amountSats,
    changeScriptHex: '5120' + '74'.repeat(32),
    feeSats: plan.feeSats,
  });
  const txid = txidFromSignedHex(hex);
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.equal(txidFromSignedHex(hex), txid, 'pure — the in-place reverse must not leak between calls');
});

test('refuses malformed hex instead of inventing a plausible txid', () => {
  assert.throws(() => txidFromSignedHex('abc'), /hex/i, 'odd-length');
  assert.throws(() => txidFromSignedHex('zz'.repeat(20)), /hex/i, 'non-hex');
  assert.throws(() => txidFromSignedHex(''), /hex/i, 'empty');
  assert.throws(() => txidFromSignedHex(undefined), /hex/i);
  // truncation is the dangerous one: the parse "succeeds" and only the
  // trailing-byte assertion catches it
  const { hex } = fixture('spend-tx');
  assert.throws(() => txidFromSignedHex(hex.slice(0, -40)), /trailing bytes|truncated/i);
});

// ---- createBroadcastLog ----

function fakeStorage(seed) {
  const mem = new Map();
  if (seed !== undefined) mem.set(BROADCAST_LOG_KEY, seed);
  return {
    mem,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}
const rec = (n, over = {}) => ({
  txid: String(n).padStart(2, '0').repeat(32),
  hex: '0200000000',
  kind: 'send',
  chain: 'testnet',
  walletId: 'w1',
  summary: `record ${n}`,
  at: Date.now(),
  state: 'pending',
  attempts: 1,
  lastError: null,
  ...over,
});

test('record → list roundtrip keeps the fields the recovery card renders', () => {
  const log = createBroadcastLog(fakeStorage());
  log.record(rec(1, { summary: '10 DGB to dgb1qexample' }));
  const [got] = log.list();
  assert.equal(got.txid, '01'.repeat(32));
  assert.equal(got.summary, '10 DGB to dgb1qexample');
  assert.equal(got.kind, 'send');
  assert.equal(got.chain, 'testnet');
  assert.equal(got.state, 'pending');
  assert.equal(got.hex, '0200000000');
});

test('record upserts by txid rather than duplicating a rebroadcast', () => {
  const log = createBroadcastLog(fakeStorage());
  log.record(rec(1, { summary: 'first' }));
  log.record(rec(1, { summary: 'second' }));
  assert.equal(log.list().length, 1);
  assert.equal(log.list()[0].summary, 'second');
});

test('a BigInt amount is stringified, never handed to JSON.stringify raw', () => {
  // The #1 way to kill this module silently: JSON.stringify THROWS on a BigInt,
  // so the write is lost and the whole protection is dead while looking present.
  const log = createBroadcastLog(fakeStorage());
  assert.doesNotThrow(() => log.record(rec(2, { summary: 1_000_000n })));
  assert.equal(log.list()[0].summary, '1000000');
});

test('list is newest-first and trimmed to the cap', () => {
  const log = createBroadcastLog(fakeStorage());
  for (let i = 1; i <= 25; i += 1) log.record(rec(i, { at: Date.now() + i }));
  const got = log.list();
  assert.equal(got.length, 20);
  assert.equal(got[0].txid, '25'.repeat(32), 'newest first');
  assert.ok(!got.some((r) => r.txid === '01'.repeat(32)), 'oldest trimmed');
});

test('records older than the retention window are pruned on READ', () => {
  // pruning only on write would let a record written once and never revisited
  // live forever
  const old = JSON.stringify([rec(3, { at: Date.now() - 31 * 24 * 3600 * 1000 })]);
  assert.equal(createBroadcastLog(fakeStorage(old)).list().length, 0);
});

test('drop, markAmbiguous and bumpAttempt mutate the stored record', () => {
  const log = createBroadcastLog(fakeStorage());
  log.record(rec(4));
  const txid = '04'.repeat(32);
  log.markAmbiguous(txid, 'the node did not answer in time');
  assert.equal(log.get(txid).state, 'ambiguous');
  assert.equal(log.get(txid).attempts, 2);
  assert.match(log.get(txid).lastError, /did not answer/);
  log.bumpAttempt(txid);
  assert.equal(log.get(txid).attempts, 3);
  log.drop(txid);
  assert.equal(log.get(txid), null);
  assert.equal(log.list().length, 0);
});

test('a storage that refuses to write never aborts the broadcast', () => {
  const storage = fakeStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const log = createBroadcastLog(storage);
  assert.doesNotThrow(() => log.record(rec(5)));
  assert.doesNotThrow(() => log.drop('05'.repeat(32)));
  assert.deepEqual(log.list(), []);
});

test('corrupt or hostile stored JSON yields an empty list, not a throw', () => {
  assert.deepEqual(createBroadcastLog(fakeStorage('not json at all')).list(), []);
  assert.deepEqual(createBroadcastLog(fakeStorage('{"nope":1}')).list(), []);
  // entries that are not usable records are dropped individually
  const mixed = JSON.stringify([null, 42, 'x', { txid: 'nope' }, rec(6)]);
  const got = createBroadcastLog(fakeStorage(mixed)).list();
  assert.equal(got.length, 1);
  assert.equal(got[0].txid, '06'.repeat(32));
});

test('the storage default is resolved lazily, so import works without webstorage', () => {
  // node --test has no localStorage; a module-scope read would have thrown on
  // import long before this line ran
  assert.equal(typeof globalThis.localStorage, 'undefined');
  const log = createBroadcastLog();
  assert.doesNotThrow(() => log.record(rec(7)));
  assert.equal(log.get('07'.repeat(32))?.txid, '07'.repeat(32));
});

// ---- classifyBroadcastError ----

const kindOf = (err) => classifyBroadcastError(err).kind;

test('recognised consensus rejects are definite', () => {
  assert.equal(kindOf(new Error('bad-txns-inputs-missingorspent')), 'reject');
  assert.equal(kindOf(new Error('txn-mempool-conflict')), 'reject');
  assert.equal(kindOf(new Error('minting-frozen-volatility')), 'reject');
  assert.equal(kindOf(new Error('bad-mint-multiple-collateral-outputs')), 'reject');
});

test('a definite reject passes its message through UNMODIFIED', () => {
  // verify-honest-quotes.mjs pins the mint-freeze copy: it must contain the raw
  // token, read as English first, and carry no classifier prefix
  const raw = 'minting-frozen-volatility, DigiDollar: Minting frozen due to high volatility';
  const { message } = classifyBroadcastError(new Error(raw));
  assert.equal(message, friendlyRejectError(raw));
  assert.match(message, /minting-frozen-volatility/);
  assert.ok(!message.startsWith('minting-frozen-volatility'));
});

test('server-side refusals are definite — nothing was broadcast', () => {
  assert.equal(kindOf(new Error('method not allowed: dumpprivkey')), 'reject');
  assert.equal(kindOf(new Error('invalid JSON body')), 'reject');
  assert.equal(kindOf(new Error('refusing to serve: this deployment expects chain "test"')), 'reject');
  assert.equal(kindOf(new Error('no indexer configured')), 'reject');
  // #H4's own limiter answers before the request reaches the node, so these two
  // are definite too — verbatim from server.js (413 and 429), em dash included
  assert.equal(kindOf(new Error('request body too large (limit 65536 bytes)')), 'reject');
  assert.equal(kindOf(new Error('too many requests — this server limits how often one client may call the node; retry in 12s')), 'reject');
});

test('an already-known transaction is success, not failure', () => {
  assert.equal(kindOf(new Error('txn-already-in-mempool')), 'already');
  assert.equal(kindOf(new Error('Transaction already in block chain')), 'already');
});

test('anything the node did not positively answer is AMBIGUOUS', () => {
  // Each of these can follow a node that ACCEPTED the transaction. Calling any
  // of them a definite failure is the finding.
  for (const raw of [
    'The operation was aborted due to timeout',
    'fetch failed',
    'Failed to fetch',
    'Load failed',
    'NetworkError when attempting to fetch resource.',
    'HTTP 502',
    'HTTP 500',
    'Node returned non-JSON (HTTP 500): <html>',
    'Unexpected token < in JSON at position 0',
    'min relay fee not met',
    '',
  ]) {
    assert.equal(kindOf(new Error(raw)), 'ambiguous', raw);
  }
  assert.equal(kindOf(undefined), 'ambiguous');
});

test('apiFetch’s transport flag is the PRIMARY signal, ahead of any text', () => {
  // #H1 owns this copy and may reword it (Safari says 'Load failed', the wrapper
  // says something friendlier); the flag is the contract. A classifier that
  // string-matched instead would silently mis-handle a timed-out broadcast.
  const timeout = Object.assign(new Error('the node did not answer in time — it may be down, or the connection dropped.'), { transport: 'timeout' });
  const network = Object.assign(new Error('could not reach the node (Failed to fetch)'), { transport: 'network' });
  assert.equal(kindOf(timeout), 'ambiguous');
  assert.equal(kindOf(network), 'ambiguous');
  // even text that WOULD read as a node verdict cannot beat the flag
  const flagged = Object.assign(new Error('bad-txns-inputs-missingorspent'), { transport: 'timeout' });
  assert.equal(kindOf(flagged), 'ambiguous');
});

test('an indexer-shape refusal is not a node verdict', () => {
  const e = Object.assign(new Error('indexer returned malformed data'), { indexerData: true });
  assert.equal(kindOf(e), 'ambiguous');
});
