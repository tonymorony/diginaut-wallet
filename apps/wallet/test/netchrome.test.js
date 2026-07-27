import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkChrome, betaCapError, backupSkipAllowed, BETA_TX_CAP_USD } from '../public/netchrome.js';

// One build serves every network (#61): wording is decided at runtime from the
// node's reported chain, never baked into the HTML. The mainnet beta posture
// (#54/#63) rides the same seam: red banner, MAINNET pill, $500/tx cap.

test('mainnet: red beta banner with the #54 copy, MAINNET pill', () => {
  const c = networkChrome('main');
  assert.match(c.banner, /MAINNET BETA/);
  assert.match(c.banner, /real funds at risk/);
  assert.match(c.banner, /no backup/);
  assert.ok(c.banner.includes(`$${BETA_TX_CAP_USD}/tx cap`), 'banner quotes the cap');
  assert.equal(c.level, 'danger');
  assert.equal(c.pill, 'MAINNET');
  assert.equal(c.title, 'Diginaut · DigiDollar wallet');
});

test('testnet: TESTNET ONLY banner stays amber (warn), TESTNET pill', () => {
  const c = networkChrome('test');
  assert.match(c.banner, /TESTNET ONLY/);
  assert.match(c.banner, /no real value/);
  assert.match(c.title, /testnet/);
  assert.equal(c.level, 'warn');
  assert.equal(c.pill, 'TESTNET');
});

test('regtest: developer-network banner, REGTEST pill', () => {
  const c = networkChrome('regtest');
  assert.match(c.banner, /REGTEST/);
  assert.match(c.title, /regtest/);
  assert.equal(c.level, 'warn');
  assert.equal(c.pill, 'REGTEST');
});

test('unknown chain: neutral chrome — no banner, no pill claiming a network', () => {
  for (const chain of [undefined, null, '', 'signet', 'garbage']) {
    const c = networkChrome(chain);
    assert.equal(c.banner, null, String(chain));
    assert.equal(c.pill, null, String(chain));
    assert.equal(c.level, null, String(chain));
    assert.equal(c.title, 'Diginaut · DigiDollar wallet', String(chain));
  }
});

// ---- $500/tx beta cap (#54): per-transaction, mainnet-only ----

test('beta cap: mainnet blocks above $500, allows at and below it', () => {
  assert.equal(BETA_TX_CAP_USD, 500);
  assert.equal(betaCapError('mainnet', 500), null, 'exactly $500 is allowed');
  assert.equal(betaCapError('mainnet', 0.01), null);
  assert.match(betaCapError('mainnet', 500.01), /\$500/);
  assert.match(betaCapError('mainnet', 100_000), /mainnet beta/);
  // both mainnet spellings cap — node chain 'main' vs wallet netName 'mainnet'
  assert.match(betaCapError('main', 500.01), /\$500/);
});

test('beta cap: testnet/regtest are never capped (no regression, #63 AC)', () => {
  for (const net of ['testnet', 'regtest']) {
    assert.equal(betaCapError(net, 1_000_000), null, net);
  }
});

test('beta cap: unknown USD value (no price feed) is warn-allow, not blocked', () => {
  assert.equal(betaCapError('mainnet', null), null);
  assert.equal(betaCapError('mainnet', undefined), null);
});

// ---- Seed-backup skip gate (#C3): mainnet and unknown chains fail strict ----

test('backup skip: mainnet forbids the skip in both spellings', () => {
  assert.equal(backupSkipAllowed('main'), false);
  assert.equal(backupSkipAllowed('mainnet'), false);
});

test('backup skip: testnet and regtest keep the frictionless flow', () => {
  for (const c of ['test', 'testnet', 'regtest']) assert.equal(backupSkipAllowed(c), true, c);
});

test('backup skip: an unknown chain fails STRICT — unlike betaCapError, which warn-allows', () => {
  for (const c of [undefined, null, '', 'signet', 'garbage', 0, {}]) {
    assert.equal(backupSkipAllowed(c), false, String(c));
  }
  // the two gates deliberately disagree on the unknown case; pin that contract
  assert.equal(betaCapError(null, 10_000), null);
  assert.equal(backupSkipAllowed(null), false);
});

test('backup skip: the allow-list is closed — no chain outside the three is skippable', () => {
  assert.deepEqual(['main', 'mainnet', 'test', 'testnet', 'regtest', 'signet', '']
    .filter(backupSkipAllowed), ['test', 'testnet', 'regtest']);
});
