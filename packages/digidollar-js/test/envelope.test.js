import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDDVersion, parseDDVersion } from 'digidollar-js';

// Ground truth: real regtest mint e9dcc4fc… (test/fixtures/mint-tx.json) has
// nVersion 0x01000770 — marker 0x0770 in the low 16 bits, tx type in bits 24–31.
// Core reference: src/consensus/digidollar.cpp HasDigiDollarMarker/GetDigiDollarTxType.

test('builds and parses the DigiDollar nVersion marker', () => {
  assert.equal(buildDDVersion('mint'), 0x01000770);
  assert.equal(buildDDVersion('transfer'), 0x02000770);
  assert.equal(buildDDVersion('redeem'), 0x03000770);

  assert.deepEqual(parseDDVersion(0x01000770), { isDigiDollar: true, type: 'mint' });
  assert.deepEqual(parseDDVersion(0x03000770), { isDigiDollar: true, type: 'redeem' });
  assert.deepEqual(parseDDVersion(2), { isDigiDollar: false, type: null }); // plain DGB tx
  assert.deepEqual(parseDDVersion(0x7f000770), { isDigiDollar: true, type: null }); // marker ok, type out of range
});

// Real OP_RETURN from the fixture mint (all fields cross-checked against
// listdigidollarpositions on the same node):
//   6a 024444 0101 021027 03f0d40f 0103 20<32-byte owner key>
const MINT_META_HEX =
  '6a024444010102102703f0d40f010320c20a139635a064cbfb7ee7c8f1d4362de68f5d6b02e8cf1f6906f0c0e760c034';
const OWNER_KEY_HEX = 'c20a139635a064cbfb7ee7c8f1d4362de68f5d6b02e8cf1f6906f0c0e760c034';

test('parses the mint OP_RETURN metadata from a real regtest mint', async () => {
  const { parseMintMetadata } = await import('digidollar-js');
  assert.deepEqual(parseMintMetadata(MINT_META_HEX), {
    ddCents: 10_000n,
    unlockHeight: 1_037_552,
    lockTier: 3,
    ownerKeyHex: OWNER_KEY_HEX,
  });
});

test('rebuilds the mint OP_RETURN byte-for-byte (round-trip)', async () => {
  const { buildMintMetadata } = await import('digidollar-js');
  const hex = buildMintMetadata({
    ddCents: 10_000n,
    unlockHeight: 1_037_552,
    lockTier: 3,
    ownerKeyHex: OWNER_KEY_HEX,
  });
  assert.equal(hex, MINT_META_HEX);
});
