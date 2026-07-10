import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkChrome } from '../public/netchrome.js';

// One build serves every network (#61): wording is decided at runtime from the
// node's reported chain, never baked into the HTML.

test('mainnet: neutral title, no network banner (beta warning is #63, not here)', () => {
  const c = networkChrome('main');
  assert.equal(c.banner, null);
  assert.equal(c.title, 'Diginaut · DigiDollar wallet');
});

test('testnet: TESTNET ONLY banner and testnet title', () => {
  const c = networkChrome('test');
  assert.match(c.banner, /TESTNET ONLY/);
  assert.match(c.banner, /no real value/);
  assert.match(c.title, /testnet/);
});

test('regtest: developer-network banner', () => {
  const c = networkChrome('regtest');
  assert.match(c.banner, /REGTEST/);
  assert.match(c.title, /regtest/);
});

test('unknown chain: neutral chrome, no banner claiming a network', () => {
  for (const chain of [undefined, null, '', 'signet', 'garbage']) {
    const c = networkChrome(chain);
    assert.equal(c.banner, null, String(chain));
    assert.equal(c.title, 'Diginaut · DigiDollar wallet', String(chain));
  }
});
