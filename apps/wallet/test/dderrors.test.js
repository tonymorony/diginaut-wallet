import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDDError, friendlyRejectError, isAlreadyBroadcast, isNodeRejectString } from '../public/dderrors.js';

// Consensus reject strings from DigiByte Core v9.26.4 (digidollar/validation.cpp,
// consensus/digidollar_transaction_validation.cpp). The node surfaces them raw in
// sendrawtransaction errors; the wallet must translate them to something a human
// can act on (#62) while keeping the raw token visible for support.

test('volatility mint freeze (≥20%/1h) explains the freeze and that funds are safe', () => {
  const msg = friendlyDDError('minting-frozen-volatility');
  assert.match(msg, /frozen/i);
  assert.match(msg, /20%/);
  assert.match(msg, /minting-frozen-volatility/); // raw token preserved
});

test('the freeze-candidate variant maps to the same explanation, full token preserved', () => {
  const msg = friendlyDDError('minting-frozen-volatility-candidate');
  assert.match(msg, /frozen/i);
  assert.match(msg, /minting-frozen-volatility-candidate/); // not truncated to the prefix
});

test('full freeze (≥50%/7d) says ALL DigiDollar operations are paused', () => {
  const msg = friendlyDDError('all-operations-frozen');
  assert.match(msg, /all DigiDollar operations/i);
  assert.match(msg, /50%/);
});

test('bad-dd-mint-amount points at the consensus mint limits', () => {
  const msg = friendlyDDError('bad-dd-mint-amount');
  assert.match(msg, /limit/i);
  assert.match(msg, /bad-dd-mint-amount/);
});

test('bad-oracle-price says the price quote was rejected, suggests retrying', () => {
  const msg = friendlyDDError('bad-oracle-price');
  assert.match(msg, /oracle price/i);
  assert.match(msg, /try again/i);
});

test('reject tokens embedded in longer node text are still recognized', () => {
  const msg = friendlyDDError('sendrawtransaction failed: minting-frozen-volatility (code -26)');
  assert.match(msg, /frozen/i);
});

test('unknown bad-mint-* kin get a mint-family explanation with the raw token', () => {
  const msg = friendlyDDError('bad-mint-multiple-collateral-outputs');
  assert.match(msg, /mint/i);
  assert.match(msg, /bad-mint-multiple-collateral-outputs/);
});

test('unknown bad-redeem-* kin get a redeem-family explanation', () => {
  const msg = friendlyDDError('bad-redeem-dd-not-burned');
  assert.match(msg, /rede/i);
  assert.match(msg, /bad-redeem-dd-not-burned/);
});

test('unknown bad-dd-* kin get a generic DigiDollar-consensus explanation', () => {
  const msg = friendlyDDError('bad-dd-tx-version');
  assert.match(msg, /bad-dd-tx-version/);
});

test('non-DigiDollar errors pass through untranslated (null)', () => {
  assert.equal(friendlyDDError('min relay fee not met'), null);
  assert.equal(friendlyDDError('Node returned non-JSON (HTTP 500)'), null);
  assert.equal(friendlyDDError(''), null);
  assert.equal(friendlyDDError(undefined), null);
});

// ---- Spend/broadcast reject families (#H3) ----
// These strings are met AFTER an ambiguous broadcast, where the first attempt
// usually DID land. The raw token invites "rebuild and send again", which
// spends the same coins twice — the copy exists to stop exactly that.

test('missingorspent explains the coins are gone and forbids re-sending', () => {
  const msg = friendlyRejectError('bad-txns-inputs-missingorspent');
  assert.match(msg, /already gone/i);
  assert.match(msg, /do NOT rebuild and send it again/);
  assert.match(msg, /bad-txns-inputs-missingorspent/); // raw token preserved for support
});

test('missingorspent leads with the explanation, not the raw token', () => {
  // same house rule the mint driver pins: a user must meet English first
  assert.ok(!friendlyRejectError('bad-txns-inputs-missingorspent').startsWith('bad-txns-'));
});

test('mempool conflict names the same-coins cause and says do not send again', () => {
  const msg = friendlyRejectError('txn-mempool-conflict');
  assert.match(msg, /same coins/i);
  assert.match(msg, /do NOT send again/);
  assert.match(msg, /txn-mempool-conflict/);
});

test('the bad-txns- catch-all never shadows the two specific spend messages', () => {
  // ordering regression guard: a catch-all placed first still passes a loose
  // /rejected/ assertion while destroying the only messages that matter here
  assert.match(friendlyRejectError('bad-txns-inputs-missingorspent'), /already gone/i);
  assert.match(friendlyRejectError('bad-txns-nonstandard-inputs'), /consensus level/i);
});

test('DigiDollar consensus strings still delegate to friendlyDDError unchanged', () => {
  assert.equal(friendlyRejectError('minting-frozen-volatility'), friendlyDDError('minting-frozen-volatility'));
  assert.equal(friendlyRejectError('bad-mint-multiple-collateral-outputs'),
    friendlyDDError('bad-mint-multiple-collateral-outputs'));
});

test('unrecognised text still passes through untranslated (null)', () => {
  assert.equal(friendlyRejectError('min relay fee not met'), null);
  assert.equal(friendlyRejectError(''), null);
  assert.equal(friendlyRejectError(undefined), null);
});

test('already-broadcast answers are recognised as success, not failure', () => {
  assert.equal(isAlreadyBroadcast('txn-already-in-mempool'), true);
  assert.equal(isAlreadyBroadcast('Transaction already in block chain'), true);
  assert.equal(isAlreadyBroadcast('Transaction outputs already in utxo set'), true);
  const msg = friendlyRejectError('txn-already-in-mempool');
  assert.match(msg, /broadcast successfully/i);
});

test('already-broadcast patterns stay anchored — a genuine reject is not swallowed', () => {
  assert.equal(isAlreadyBroadcast('bad-txns-inputs-missingorspent'), false);
  assert.equal(isAlreadyBroadcast(''), false);
  assert.equal(isAlreadyBroadcast(undefined), false);
});

test('transport failures are NOT node verdicts — the ambiguity must survive', () => {
  // isNodeRejectString returning true here would let the classifier call a
  // timed-out broadcast a definite failure and drop the recovery record (#C1)
  assert.equal(isNodeRejectString('The operation was aborted due to timeout'), false);
  assert.equal(isNodeRejectString('fetch failed'), false);
  assert.equal(isNodeRejectString('HTTP 502'), false);
  assert.equal(isNodeRejectString('the node did not answer in time — it may be down, or the connection dropped.'), false);
  assert.equal(isNodeRejectString(''), false);
});

test('recognised node verdicts are reported as definite', () => {
  assert.equal(isNodeRejectString('bad-mint-multiple-collateral-outputs'), true);
  assert.equal(isNodeRejectString('bad-txns-inputs-missingorspent'), true);
  assert.equal(isNodeRejectString('txn-already-in-mempool'), true);
});
