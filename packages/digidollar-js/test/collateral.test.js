import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_TIERS, requiredCollateralSats } from 'digidollar-js';

// Expected values mirror DigiByte Core v9.26.4 arithmetic
// (src/digidollar/txbuilder.cpp CalculateRequiredCollateral):
// ceil((ddCents * COIN * effectiveRatio * 100) / priceMicroUsd), then +1% margin (floor).

test('mints $100 DigiDollar on the 1-hour tier at $0.00631/DGB', () => {
  const sats = requiredCollateralSats({
    ddCents: 10_000n,              // $100.00
    tierId: '1hour',               // 240 blocks, 1000% collateral
    oraclePriceMicroUsd: 6_310n,   // $0.00631 per DGB
  });
  assert.equal(sats, 16_006_339_144_216n); // ~160,063 DGB incl. 1% safety margin
});

test('exposes the ten consensus lock tiers from Core v9.26.4', () => {
  const table = LOCK_TIERS.map((t) => [t.id, t.lockBlocks, t.ratioPercent]);
  assert.deepEqual(table, [
    ['1hour', 240, 1000],
    ['30days', 172_800, 500],
    ['3months', 518_400, 400],
    ['6months', 1_036_800, 350],
    ['1year', 2_102_400, 300],
    ['2years', 4_204_800, 275],
    ['3years', 6_307_200, 250],
    ['5years', 10_512_000, 225],
    ['7years', 14_716_800, 212],
    ['10years', 21_024_000, 200],
  ]);
});

test('cheapest tier (10 years, 200%) needs 5x less collateral than the 1-hour tier', () => {
  const sats = requiredCollateralSats({
    ddCents: 10_000n,
    tierId: '10years',
    oraclePriceMicroUsd: 6_310n,
  });
  assert.equal(sats, 3_201_267_828_843n); // ~32,013 DGB incl. margin
});

test('rejects invalid mint inputs with clear errors', () => {
  const good = { ddCents: 10_000n, tierId: '6months', oraclePriceMicroUsd: 6_310n };
  assert.throws(() => requiredCollateralSats({ ...good, tierId: 'forever' }), /unknown lock tier/i);
  assert.throws(() => requiredCollateralSats({ ...good, oraclePriceMicroUsd: 0n }), /oracle price/i);
  assert.throws(() => requiredCollateralSats({ ...good, oraclePriceMicroUsd: -5n }), /oracle price/i);
  assert.throws(() => requiredCollateralSats({ ...good, ddCents: 0n }), /amount/i);
  assert.throws(() => requiredCollateralSats({ ...good, ddCents: -100n }), /amount/i);
});

test('rejects results exceeding MAX_MONEY (Core overflow guard)', () => {
  // $100k DD at 1000% ratio at a 1 micro-USD price → astronomically more DGB than exists
  assert.throws(
    () => requiredCollateralSats({ ddCents: 10_000_000n, tierId: '1hour', oraclePriceMicroUsd: 1n }),
    /MAX_MONEY/,
  );
});

test('degraded system health raises collateral via DCA basis points', () => {
  // 6-month tier (350%) at 12500 bps → ceil(350 * 12500 / 10000) = 438% effective
  const sats = requiredCollateralSats({
    ddCents: 10_000n,
    tierId: '6months',
    oraclePriceMicroUsd: 6_310n,
    dcaMultiplierBps: 12_500n,
  });
  assert.equal(sats, 7_010_776_545_167n); // vs 5_602_218_700_475n at healthy 10000 bps
});

test('every Core DCA health tier scales the quote (#62 honest quotes)', () => {
  // Core dca.cpp HEALTH_TIERS: 10000 healthy / 12500 warning / 15000 critical /
  // 20000 emergency. 6-month tier (350%) at $0.00631/DGB, $100 mint.
  const quote = (dcaMultiplierBps) => requiredCollateralSats({
    ddCents: 10_000n, tierId: '6months', oraclePriceMicroUsd: 6_310n, dcaMultiplierBps,
  });
  assert.equal(quote(10_000n), 5_602_218_700_475n); // healthy — the old implicit default
  assert.equal(quote(15_000n), 8_403_328_050_713n); // critical: ceil(350×1.5) = 525%
  assert.equal(quote(20_000n), 11_204_437_400_951n); // emergency: 700%
  // Emergency doubles the most expensive tier too (1 hour, 1000% → 2000%)
  assert.equal(
    requiredCollateralSats({ ddCents: 10_000n, tierId: '1hour', oraclePriceMicroUsd: 6_310n, dcaMultiplierBps: 20_000n }),
    32_012_678_288_431n,
  );
});
