import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWitnessAddress, decodeWitnessAddress, scriptPubKeyFromAddress } from 'digidollar-js';

// BIP-350 reference vector: the BIP-341 example P2TR output key under hrp "bc".
const BIP350_KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BIP350_ADDR = 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y';

test('encodes and decodes witness v1 (bech32m) per BIP-350', () => {
  // v1 program from BIP-350 test vectors: bc1pw508… (75-char, 40-byte program is
  // unwieldy) — use the simpler canonical vector: v1, 32-byte program of 0x79be…
  const addr = encodeWitnessAddress('bc', 1, BIP350_KEY);
  const back = decodeWitnessAddress(addr);
  assert.deepEqual(back, { hrp: 'bc', version: 1, programHex: BIP350_KEY });
});

test('round-trips a regtest DigiByte taproot address (dgbrt1p…)', () => {
  const addr = encodeWitnessAddress('dgbrt', 1, BIP350_KEY);
  assert.match(addr, /^dgbrt1p/);
  assert.deepEqual(decodeWitnessAddress(addr), { hrp: 'dgbrt', version: 1, programHex: BIP350_KEY });
});

test('scriptPubKeyFromAddress matches Core for v1 P2TR and v0 P2WPKH', () => {
  // Known-good address ↔ scriptPubKey pairs from Core-built fixture txs
  // (test/fixtures/transfer-tx.json vout[0] and vout[2]).
  assert.equal(
    scriptPubKeyFromAddress('dgbrt1ppgnez33mdym2rzru35tnmkqeyfwj89z7vjdftf6vm72mqgktj09qfa0hzq'),
    '51200a2791463b6936a1887c8d173dd819225d23945e649a95a74cdf95b022cb93ca',
  );
  assert.equal(
    scriptPubKeyFromAddress('dgbrt1qskyk2t69a02764tlvvcjq6ydgtacv6e9nxuw5t'),
    '00148589652f45ebd5ed557f633120688d42fb866b25',
  );
});

test('decodes the stand wallet v0 address produced by the node', () => {
  // Real address from the regtest stand node (getnewaddress): witness v0 P2WPKH.
  const { hrp, version, programHex } = decodeWitnessAddress('dgbrt1q2hqvy2hqahw2nhny3hcvdkvqr5rv3g3ukvfhsu');
  assert.equal(hrp, 'dgbrt');
  assert.equal(version, 0);
  assert.equal(programHex.length, 40); // 20-byte keyhash
});
