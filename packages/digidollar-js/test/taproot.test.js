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

// Ground truth from the real regtest redemption (test/fixtures/redeem-tx.json,
// txid b834557b…): vin[0] spends the collateral of mint 4f30aa8f… (1hour tier,
// lockHeight 1064, $100) via the Normal tapscript path. Witness stack:
//   [ <64B schnorr sig>, <Normal leaf script>, <control block> ]
const REDEEM = {
  ownerKeyHex: '9c42c105e9be2f6712b004953174a956d9bd7674fd26ccd5d17f5c50e88bd3ef',
  lockHeight: 1_064,
  ddCents: 10_000n,
};
const REDEEM_LEAF_HEX =
  '022804b175bb021027bc209c42c105e9be2f6712b004953174a956d9bd7674fd26ccd5d17f5c50e88bd3efac';
const REDEEM_CONTROL_HEX =
  'c150929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0' +
  'a36330a39a4429bdb4f00a4749005bb9e9709fc2f976fa7d992290cce4fcef3b';

test('rebuilds the Normal redemption leaf script byte-for-byte (fixture match)', async () => {
  const { normalRedemptionLeafHex } = await import('digidollar-js');
  assert.equal(normalRedemptionLeafHex(REDEEM), REDEEM_LEAF_HEX);
});

test('rebuilds the collateral control block byte-for-byte (fixture match)', async () => {
  // 33 + 32 bytes: (leaf version 0xc0 | output-key parity) ++ NUMS internal
  // key ++ ERR-leaf sibling hash. Parity here is odd (0xc1).
  const { collateralControlBlockHex } = await import('digidollar-js');
  assert.equal(collateralControlBlockHex(REDEEM), REDEEM_CONTROL_HEX);
});

test('the redeemed collateral output key matches the creating mint (fixture cross-check)', async () => {
  const { collateralOutputKey } = await import('digidollar-js');
  const { readFile } = await import('node:fs/promises');
  const mint = JSON.parse(
    await readFile(new URL('./fixtures/redeem-mint-tx.json', import.meta.url), 'utf8'),
  ).result;
  assert.equal(collateralOutputKey(REDEEM), mint.vout[0].scriptPubKey.hex.slice(4));
});
