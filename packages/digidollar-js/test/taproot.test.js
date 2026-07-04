import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ddTokenOutputKey } from 'digidollar-js';

// Ground truth from the real regtest mint (test/fixtures/mint-tx.json):
// the OP_RETURN owner key, key-path-only tap-tweaked (BIP-341, no merkle root),
// must equal the DD token output key at vout[1].
const OWNER_KEY = 'c20a139635a064cbfb7ee7c8f1d4362de68f5d6b02e8cf1f6906f0c0e760c034';
const DD_TOKEN_KEY = '0b1869065a47f4d36a8061e10b6942de58a132db1c1c5b5f7c8f7f4909a4d14a';

test('derives the DD token P2TR output key from the owner key (fixture match)', () => {
  assert.equal(ddTokenOutputKey(OWNER_KEY), DD_TOKEN_KEY);
});

test('derives the collateral P2TR output key via the 2-leaf MAST (fixture match)', async () => {
  const { collateralOutputKey } = await import('digidollar-js');
  // vout[0] of the real mint: NUMS internal key + MAST(Normal, ERR) for
  // lockHeight 1037552, ddAmount 10000 cents, the fixture owner key.
  assert.equal(
    collateralOutputKey({ ownerKeyHex: OWNER_KEY, lockHeight: 1_037_552, ddCents: 10_000n }),
    '4c5c825657b08b09807abe224ca33c39ace00915e2dc31f29d7e7532336b2457',
  );
});
