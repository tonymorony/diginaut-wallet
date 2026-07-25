import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autolockMinutes, AUTOLOCK_DEFAULT_MIN, AUTOLOCK_KEY } from '../public/autolock.js';

// Auto-lock is what drops the vault key and the plaintext mnemonics on an
// unattended device. The regression these tests exist for: the delay was read
// as Number(localStorage.getItem(key)), and an absent key gives Number(null) ===
// 0, which is the "Never" setting — so the documented 5-minute default silently
// became no auto-lock at all for every profile that had never opened the
// setting. The default path had no test because it was inline in app.js.

test('an absent preference means the DEFAULT, never "Never"', () => {
  // localStorage.getItem returns null for a key that was never written
  assert.equal(autolockMinutes(null), AUTOLOCK_DEFAULT_MIN);
  assert.equal(autolockMinutes(undefined), AUTOLOCK_DEFAULT_MIN);
  assert.notEqual(autolockMinutes(null), 0, 'absent must not resolve to Never');
  assert.equal(AUTOLOCK_DEFAULT_MIN, 5, 'spec §5: default 5 minutes of inactivity');
});

test('"Never" is only reachable by explicitly choosing 0', () => {
  assert.equal(autolockMinutes('0'), 0);
  assert.equal(autolockMinutes(0), 0);
});

test('every ladder value the markup offers round-trips', () => {
  for (const mins of [1, 5, 15, 60]) {
    assert.equal(autolockMinutes(String(mins)), mins);
    assert.equal(autolockMinutes(String(mins)) * 60_000, mins * 60_000);
  }
});

test('an unusable preference falls back to the default, not to Never', () => {
  for (const junk of ['', '   ', 'abc', 'NaN', '-1', '-0.5', 'Infinity', '[]', '{}']) {
    assert.equal(autolockMinutes(junk), AUTOLOCK_DEFAULT_MIN, `junk value ${JSON.stringify(junk)}`);
  }
});

test('the storage key is device-scoped and stable (a rename orphans every choice)', () => {
  assert.equal(AUTOLOCK_KEY, 'diginaut.autolock');
});
