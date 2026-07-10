import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyDDError } from '../public/dderrors.js';

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
