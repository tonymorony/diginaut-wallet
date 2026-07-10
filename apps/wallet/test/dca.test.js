import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dcaBpsFromMultiplier, describeDca } from '../public/dca.js';

// getdcamultiplier returns the multiplier as a JSON double (1.0 / 1.25 / 1.5 / 2.0,
// Core dca.cpp HEALTH_TIERS). digidollar-js wants basis points as BigInt — the
// conversion must be exact for every tier Core can emit.

test('converts every Core health-tier multiplier to exact basis points', () => {
  assert.equal(dcaBpsFromMultiplier(1.0), 10_000n); // healthy
  assert.equal(dcaBpsFromMultiplier(1.25), 12_500n); // warning
  assert.equal(dcaBpsFromMultiplier(1.5), 15_000n); // critical
  assert.equal(dcaBpsFromMultiplier(2.0), 20_000n); // emergency
});

test('survives float noise without drifting a basis point', () => {
  assert.equal(dcaBpsFromMultiplier(1.2500000000000002), 12_500n);
  assert.equal(dcaBpsFromMultiplier(1.4999999999999998), 15_000n);
});

test('rejects garbage multipliers instead of quoting from them', () => {
  for (const bad of [0, -1, NaN, Infinity, undefined, null, 'high']) {
    assert.throws(() => dcaBpsFromMultiplier(bad), RangeError, String(bad));
  }
});

test('healthy system needs no DCA note on the quote', () => {
  assert.equal(describeDca({ multiplier: 1.0, tier_status: 'healthy' }), null);
});

test('degraded system yields a human-readable DCA note naming the tier', () => {
  const note = describeDca({ multiplier: 1.5, tier_status: 'critical' });
  assert.match(note, /1\.5×/);
  assert.match(note, /critical/);
});

test('missing tier status still yields a usable note', () => {
  const note = describeDca({ multiplier: 2.0 });
  assert.match(note, /2×|2\.0×/);
});
