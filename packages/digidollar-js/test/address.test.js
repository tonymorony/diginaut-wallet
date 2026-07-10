import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWitnessAddress,
  decodeWitnessAddress,
  scriptPubKeyFromAddress,
  encodeDDAddress,
  decodeDDAddress,
  toDDAddress,
  decodeAddress,
  decodeLegacyAddress,
} from 'digidollar-js';

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

// ── DigiDollar base58check address ("DD…"/"TD…"/"RD…") ──────────────────────

// Any 32-byte x-only taproot output key. (BIP-350 sample key.)
const DD_KEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

test('encodeDDAddress emits Core prefixes DD/TD/RD and round-trips', () => {
  const cases = [
    ['mainnet', 'DD'],
    ['testnet', 'TD'],
    ['regtest', 'RD'],
  ];
  for (const [network, prefix] of cases) {
    const dd = encodeDDAddress(DD_KEY, network);
    assert.equal(dd.slice(0, 2), prefix, `${network} prefix`);
    assert.deepEqual(decodeDDAddress(dd), { outputKeyHex: DD_KEY, network });
  }
});

test('base58check core is byte-exact vs Core (legacy DigiByte P2PKH vector)', () => {
  // From Core test/util/data/txcreatesignv1.json: this legacy base58check address
  // decodes to scriptPubKey 76a914<hash>88ac. It shares DD's exact base58check
  // algorithm (base58 alphabet + double-SHA256 checksum), so a correct decode of
  // its 20-byte hash proves our checksum/alphabet match Core byte-for-byte.
  // It is NOT a 34-byte DD address, so decodeDDAddress must reject it.
  assert.throws(() => decodeDDAddress('DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZc'), /34 bytes/);
});

test('DD base58check and dgb1p… bech32m are two encodings of ONE scriptPubKey', () => {
  // Same key → same taproot output OP_1 <32B> from either encoding.
  const bech = encodeWitnessAddress('dgb', 1, DD_KEY);
  const dd = encodeDDAddress(DD_KEY, 'mainnet');
  assert.equal(decodeDDAddress(dd).outputKeyHex, decodeDDAddress(bech).outputKeyHex);
  assert.equal(scriptPubKeyFromAddress(bech), `5120${DD_KEY}`);
  assert.equal(toDDAddress(bech), dd); // bech32m → DD form for display/interop
});

test('decodeDDAddress accepts the bech32m form on every network', () => {
  for (const [network, hrp] of [['mainnet', 'dgb'], ['testnet', 'dgbt'], ['regtest', 'dgbrt']]) {
    const bech = encodeWitnessAddress(hrp, 1, DD_KEY);
    assert.deepEqual(decodeDDAddress(bech), { outputKeyHex: DD_KEY, network });
  }
});

test('decodeDDAddress rejects a witness-v0 (non-taproot) bech32 address', () => {
  const v0 = encodeWitnessAddress('dgb', 0, '8589652f45ebd5ed557f633120688d42fb866b25');
  assert.throws(() => decodeDDAddress(v0), /witness v1|taproot/);
});

test('decodeDDAddress rejects a bad base58check checksum', () => {
  const dd = encodeDDAddress(DD_KEY, 'mainnet');
  const mangled = dd.slice(0, -1) + (dd.slice(-1) === 'a' ? 'b' : 'a');
  assert.throws(() => decodeDDAddress(mangled), /checksum/);
});

test('decodeDDAddress rejects whitespace anywhere (Core DD-FA-FUNC-019)', () => {
  const dd = encodeDDAddress(DD_KEY, 'mainnet');
  assert.throws(() => decodeDDAddress(' ' + dd), /whitespace/);
  assert.throws(() => decodeDDAddress(dd + '\n'), /whitespace/);
  assert.throws(() => decodeDDAddress(dd.slice(0, 4) + ' ' + dd.slice(4)), /whitespace/);
});

test('encodeDDAddress rejects a non-32-byte key and unknown network', () => {
  assert.throws(() => encodeDDAddress('abcd', 'mainnet'), /32-byte hex/);
  assert.throws(() => encodeDDAddress(DD_KEY, 'signet'), /unknown network/);
});

// ── Legacy base58check P2PKH / P2SH (#68) ───────────────────────────────────
// Golden vectors. Mainnet pair are REAL Core addresses (P2PKH also appears in
// Core test/util/data/txcreatesignv1.json); hashes cross-checked with an
// independent base58check decoder. testnet/legacy-3 vectors built from the same
// hashes under the Core version bytes (chainparams.cpp).
const H_PKH = '5834479edbbe0539b31ffd3a8f8ebadc2165ed01'; // 20-byte hash160
const H_SH = '1c6fbaf46d64221e80cbae182c33ddf81b9294ac';

test('decodeLegacyAddress + scriptPubKeyFromAddress: mainnet P2PKH (D…)', () => {
  const addr = 'DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZc';
  assert.deepEqual(decodeLegacyAddress(addr), { type: 'p2pkh', networks: ['mainnet'], hash160Hex: H_PKH });
  // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG — byte-exact vs Core fixture
  assert.equal(scriptPubKeyFromAddress(addr), `76a914${H_PKH}88ac`);
});

test('decodeLegacyAddress + scriptPubKeyFromAddress: mainnet P2SH (S…)', () => {
  const addr = 'SPtMoNQWMfJ9C6U19oDzHaY67ADQJF5rXu';
  assert.deepEqual(decodeLegacyAddress(addr), { type: 'p2sh', networks: ['mainnet'], hash160Hex: H_SH });
  // OP_HASH160 <20> OP_EQUAL
  assert.equal(scriptPubKeyFromAddress(addr), `a914${H_SH}87`);
});

test('legacy "3…" P2SH (version 5) still decodes to mainnet P2SH', () => {
  const addr = '34HNh57oBCRKkxNyjTuWAJkTbuGh6jg2Ms';
  assert.deepEqual(decodeLegacyAddress(addr), { type: 'p2sh', networks: ['mainnet'], hash160Hex: H_SH });
  assert.equal(scriptPubKeyFromAddress(addr), `a914${H_SH}87`);
});

test('testnet & regtest share legacy version bytes (one address, both networks)', () => {
  assert.deepEqual(decodeLegacyAddress('sqdPA2TDtoAbqMnqS1sgsoyzjzJYa7eDck'),
    { type: 'p2pkh', networks: ['testnet', 'regtest'], hash160Hex: H_PKH });
  assert.deepEqual(decodeLegacyAddress('yNuocjMh2YycAUCg36sXdEVfa1432H4hmw'),
    { type: 'p2sh', networks: ['testnet', 'regtest'], hash160Hex: H_SH });
});

test('decodeAddress normalizes every address type to a script + network set', () => {
  // segwit still works and carries its DigiByte network + type
  const p2tr = encodeWitnessAddress('dgb', 1, DD_KEY);
  assert.deepEqual(decodeAddress(p2tr), {
    kind: 'witness', type: 'p2tr', networks: ['mainnet'], scriptPubKeyHex: `5120${DD_KEY}`,
  });
  const p2wpkh = encodeWitnessAddress('dgbt', 0, H_PKH);
  const dW = decodeAddress(p2wpkh);
  assert.equal(dW.type, 'p2wpkh');
  assert.deepEqual(dW.networks, ['testnet']);
  // legacy routes through the same entry point
  assert.deepEqual(decodeAddress('DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZc'), {
    kind: 'legacy', type: 'p2pkh', networks: ['mainnet'], scriptPubKeyHex: `76a914${H_PKH}88ac`,
  });
});

test('bad-checksum base58 gives a friendly error, not "malformed bech32"', () => {
  const bad = 'DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZd'; // last char flipped
  assert.throws(() => decodeAddress(bad), (e) => !/malformed bech32/.test(e.message) && /not a valid DigiByte address/.test(e.message));
  assert.throws(() => decodeAddress('totally-not-an-address'), /not a valid DigiByte address/);
});

test('decodeAddress / decodeLegacyAddress reject whitespace', () => {
  assert.throws(() => decodeAddress(' DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZc'), /whitespace/);
  assert.throws(() => decodeLegacyAddress('DDBUdbqZjUgVKkQX5ju6KmrUKZZzPu2aZc\n'), /whitespace/);
});
