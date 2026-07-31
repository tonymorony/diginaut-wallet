import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDgbCoin } from '../public/coinpick.js';

// pickDgbCoin decides which coin pays the DGB side of EVERY DigiDollar flow —
// the transfer/redeem fee and the whole mint funding. Inline in app.js it had
// no test: inverting the tier order, or taking the largest coin instead of the
// smallest, left every suite and driver in the repo green. The regtest drivers
// only reach the two failure ends (fragmented, and one lone sub-fee coin), so
// the ordering rules are pinned here.

const FEE = 12_000_000n; // the 0.12 DGB transfer fee
const KEY_A = 'aa'.repeat(32); // the "preferred" key — the DD coin's own key
const KEY_B = 'bb'.repeat(32);

const p2tr = (valueSats, privKeyHex, id) => ({ txidHex: id, vout: 0, valueSats, privKeyHex, height: 100 });
const twin = (valueSats, privKeyHex, id) => ({ ...p2tr(valueSats, privKeyHex, id), type: 'p2wpkh' });

test('the preferred key beats a LARGER P2TR coin on another key', () => {
  // Core's own anatomy: the DD coin's key paying its own fee. Cheapest witness,
  // and it keeps a transfer to a single key. Deliberately not "smallest wins".
  const coins = [p2tr(20_000_000n, KEY_A, 'a'), p2tr(13_000_000n, KEY_B, 'b')];
  assert.equal(pickDgbCoin(coins, FEE, KEY_A).txidHex, 'a');
});

test('any wallet P2TR coin beats the preferred key\'s own P2WPKH twin', () => {
  // Tier 2 before tier 3: a key-path leg is 42 wu lighter than a witness-v0 one.
  const coins = [twin(20_000_000n, KEY_A, 'twin'), p2tr(13_000_000n, KEY_B, 'other')];
  assert.equal(pickDgbCoin(coins, FEE, KEY_A).txidHex, 'other');
});

test('a P2WPKH twin is used when it is the only sufficient coin (#38)', () => {
  // The whole point of the flexible leg: a mint leaves its change on the twin,
  // and refusing it stranded the wallet behind a coin it already held.
  const coins = [p2tr(1_000_000n, KEY_A, 'dust'), twin(20_000_000n, KEY_B, 'twin')];
  assert.equal(pickDgbCoin(coins, FEE, KEY_A).txidHex, 'twin');
});

test('within a tier, the SMALLEST sufficient coin wins so a big one stays whole', () => {
  const coins = [p2tr(90_000_000n, KEY_B, 'big'), p2tr(13_000_000n, KEY_B, 'small'), p2tr(40_000_000n, KEY_B, 'mid')];
  assert.equal(pickDgbCoin(coins, FEE, KEY_A).txidHex, 'small');
  // …and the same rule inside the preferred-key tier
  const preferred = [p2tr(90_000_000n, KEY_A, 'bigA'), p2tr(13_000_000n, KEY_A, 'smallA')];
  assert.equal(pickDgbCoin(preferred, FEE, KEY_A).txidHex, 'smallA');
});

test('a coin exactly the size of the fee qualifies; one satoshi under does not', () => {
  assert.equal(pickDgbCoin([p2tr(FEE, KEY_A, 'exact')], FEE, KEY_A).txidHex, 'exact');
  assert.equal(pickDgbCoin([p2tr(FEE - 1n, KEY_A, 'short')], FEE, KEY_A), undefined);
});

test('undefined when no SINGLE coin covers the fee — the fragmentation gate', () => {
  // The sum is comfortably over the fee; the wallet must still refuse, because
  // the DGB leg is one input. This is what reveals the Consolidate offer.
  const coins = [p2tr(7_000_000n, KEY_A, 'a'), twin(7_000_000n, KEY_B, 'b')];
  assert.equal(pickDgbCoin(coins, FEE, KEY_A), undefined);
});

test('a mint passes no preferred key and still picks the smallest P2TR coin', () => {
  const coins = [twin(90_000_000n, KEY_A, 'twin'), p2tr(40_000_000n, KEY_B, 'mid'), p2tr(20_000_000n, KEY_A, 'small')];
  assert.equal(pickDgbCoin(coins, FEE, undefined).txidHex, 'small');
});

test('an empty wallet yields undefined, not a throw', () => {
  assert.equal(pickDgbCoin([], FEE, KEY_A), undefined);
});
