import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NET_TIMEOUT_MS, isTimeoutError, timeoutMessage,
  INDEXER_RETRY_MS, INDEXER_RETRY_BUDGET_MS, transientIndexerFailure,
} from '../public/nettimeout.js';

// #H1: every frontend fetch carries AbortSignal.timeout(budget). These are the
// invariants the budgets must keep — the wiring itself lives in app.js and is
// exercised by the browser drivers.

test('isTimeoutError recognises both abort flavours and nothing else', () => {
  // AbortSignal.timeout rejects with DOMException 'TimeoutError'; an explicit
  // abort (or an older engine) gives 'AbortError'.
  assert.equal(isTimeoutError({ name: 'TimeoutError' }), true);
  assert.equal(isTimeoutError({ name: 'AbortError' }), true);
  assert.equal(isTimeoutError(new Error('fetch failed')), false);
  assert.equal(isTimeoutError(new TypeError('Failed to fetch')), false);
  assert.equal(isTimeoutError(undefined), false);
  assert.equal(isTimeoutError(null), false);
});

test('every budget is a positive whole number of milliseconds', () => {
  const budgets = Object.entries(NET_TIMEOUT_MS);
  assert.ok(budgets.length > 0);
  for (const [name, ms] of budgets) {
    assert.ok(Number.isInteger(ms) && ms > 0, `${name} = ${ms}`);
  }
});

// The client must outlive the wallet server's own upstream budget for the same
// path, so the server's descriptive 502 wins the race instead of being replaced
// by a generic client timeout. server.js: rpc/indexer 15s, faucet 30s.
test('client budgets outlive the wallet server upstream budgets', () => {
  assert.ok(NET_TIMEOUT_MS.rpc > 15_000, `rpc ${NET_TIMEOUT_MS.rpc}`);
  assert.ok(NET_TIMEOUT_MS.indexer > 15_000, `indexer ${NET_TIMEOUT_MS.indexer}`);
  assert.ok(NET_TIMEOUT_MS.faucet > 30_000, `faucet ${NET_TIMEOUT_MS.faucet}`);
});

test('the budget table is frozen — no runtime edits to a security budget', () => {
  assert.ok(Object.isFrozen(NET_TIMEOUT_MS));
});

// fetchIndexer's ladder. The retry decision is the whole safety question here:
// retry a dead hop, never retry an answer.
test('a dead browser↔wallet-server hop is retried', () => {
  assert.equal(transientIndexerFailure({ transport: 'timeout' }), true);
  assert.equal(transientIndexerFailure({ transport: 'network' }), true);
});

// The deploy shape: `docker compose up -d` bounces the indexer, not the wallet
// server, so the failure arrives as a NORMAL 502 response from our own proxy.
// Both spellings must retry — the message this tree relays today, and the
// `cause` token of the indexer error contract — so neither branch disarms the
// other whichever lands first.
test('the wallet proxy relaying a dead indexer hop is retried, in both spellings', () => {
  assert.equal(transientIndexerFailure({ status: 502, body: { error: 'indexer unreachable: fetch failed' } }), true);
  assert.equal(transientIndexerFailure({
    status: 502, body: { error: 'the balance index is unavailable', cause: 'indexer-unreachable' },
  }), true);
});

test('an answer is never retried — retrying one only makes the honest error slower', () => {
  assert.equal(transientIndexerFailure({ status: 404, body: { error: 'unknown indexer path' } }), false);
  assert.equal(transientIndexerFailure({ status: 400, body: { error: 'bad address' } }), false);
  // fail-closed config/guard answers: waiting changes nothing about either
  assert.equal(transientIndexerFailure({ status: 503, body: { error: 'no indexer configured' } }), false);
  assert.equal(transientIndexerFailure({ status: 502, body: { error: 'faucet unreachable: fetch failed' } }), false);
  // a shape refusal never reaches the ladder as a response, but it must not
  // qualify if it ever grows a status
  assert.equal(transientIndexerFailure({ status: 200, body: { error: 'indexer unreachable' } }), false);
  assert.equal(transientIndexerFailure({}), false);
  assert.equal(transientIndexerFailure(), false);
});

// The time bound, not just an attempt count: a HUNG hop costs a full
// NET_TIMEOUT_MS.indexer per rung, so an attempt-counted ladder stacks ~83s of
// blank loading veil. Keeping the budget under one hop's timeout means one
// stall ends the ladder by itself.
test('the retry budget cannot outlive a single stalled hop', () => {
  assert.ok(INDEXER_RETRY_BUDGET_MS < NET_TIMEOUT_MS.indexer,
    `${INDEXER_RETRY_BUDGET_MS} vs ${NET_TIMEOUT_MS.indexer}`);
  // …while still leaving room for every rung of the fast-failing case
  const rungs = INDEXER_RETRY_MS.reduce((a, b) => a + b, 0);
  assert.ok(rungs < INDEXER_RETRY_BUDGET_MS, `rungs ${rungs}`);
  assert.ok(Object.isFrozen(INDEXER_RETRY_MS));
});

test('timeout copy names the peer and claims nothing about the far side', () => {
  const msg = timeoutMessage('the node');
  assert.match(msg, /^the node did not answer in time/);
  // The same wrapper carries sendrawtransaction: a timeout there may well mean
  // the broadcast landed. Never promise nothing happened, and never invite a
  // re-send — the broadcast path adds its own ambiguity copy.
  assert.doesNotMatch(msg, /try again|send again|resend|nothing was changed/i);
});
