import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NET_TIMEOUT_MS, isTimeoutError, timeoutMessage } from '../public/nettimeout.js';

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

test('timeout copy names the peer and claims nothing about the far side', () => {
  const msg = timeoutMessage('the node');
  assert.match(msg, /^the node did not answer in time/);
  // The same wrapper carries sendrawtransaction: a timeout there may well mean
  // the broadcast landed. Never promise nothing happened, and never invite a
  // re-send — the broadcast path adds its own ambiguity copy.
  assert.doesNotMatch(msg, /try again|send again|resend|nothing was changed/i);
});
