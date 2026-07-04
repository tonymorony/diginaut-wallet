// HD wallet layer (BIP39 mnemonic → BIP86 taproot keys/addresses).
// Expected values are the OFFICIAL test vectors, not derived from our code:
//   - BIP39: trezor/python-mnemonic vectors.json (passphrase "TREZOR")
//   - BIP86: bitcoin/bips bip-0086.mediawiki
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mnemonicToSeed, deriveTaprootAddress, generateMnemonic, validateMnemonic, HD_NETWORKS } from '../src/hd.js';
import { decodeWitnessAddress } from '../src/address.js';

const bip39Vectors = JSON.parse(readFileSync(new URL('./fixtures/bip39-vectors.json', import.meta.url)));

test('BIP39: mnemonic → seed matches all 24 official trezor vectors (passphrase TREZOR)', () => {
  for (const { mnemonic, seed } of bip39Vectors) {
    const got = mnemonicToSeed(mnemonic, 'TREZOR');
    assert.equal(Buffer.from(got).toString('hex'), seed, `mnemonic: ${mnemonic.slice(0, 40)}…`);
  }
});

// bip-0086.mediawiki reference vectors (mnemonic "abandon …× 11 about", no passphrase).
const BIP86_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BIP86_VECTORS = [
  {
    path: "m/86'/0'/0'/0/0",
    change: 0, index: 0,
    internalKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
    outputKey: 'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c',
    address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
  },
  {
    path: "m/86'/0'/0'/0/1",
    change: 0, index: 1,
    internalKey: '83dfe85a3151d2517290da461fe2815591ef69f2b18a2ce63f01697a8b313145',
    outputKey: 'a82f29944d65b86ae6b5e5cc75e294ead6c59391a1edc5e016e3498c67fc7bbb',
    address: 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh',
  },
  {
    path: "m/86'/0'/0'/1/0",
    change: 1, index: 0,
    internalKey: '399f1b2f4393f29a18c937859c5dd8a77350103157eb880f02e8c08214277cef',
    outputKey: '882d74e5d0572d5a816cef0041a96b6c1de832f6f9676d9605c44d5e9a97d3dc',
    address: 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7',
  },
];

test('BIP86: derivation matches all official bip-0086 vectors (keys + address)', () => {
  const seed = mnemonicToSeed(BIP86_MNEMONIC);
  for (const v of BIP86_VECTORS) {
    const got = deriveTaprootAddress(seed, { hrp: 'bc', coinType: 0, change: v.change, index: v.index });
    assert.equal(got.path, v.path);
    assert.equal(got.internalKeyHex, v.internalKey, v.path);
    assert.equal(got.outputKeyHex, v.outputKey, v.path);
    assert.equal(got.address, v.address, v.path);
  }
});

test('BIP39: generated mnemonics are 12 words, valid, and non-repeating', () => {
  const a = generateMnemonic();
  const b = generateMnemonic();
  assert.equal(a.split(' ').length, 12);
  assert.ok(validateMnemonic(a));
  assert.ok(validateMnemonic(b));
  assert.notEqual(a, b);
});

test('BIP39: checksum failures and junk are rejected by validateMnemonic', () => {
  // last word altered → bad checksum
  assert.equal(validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'), false);
  assert.equal(validateMnemonic('definitely not a mnemonic'), false);
});

test('DigiByte networks: regtest derivation yields a dgbrt1p… address that decodes back to the output key', () => {
  const seed = mnemonicToSeed(BIP86_MNEMONIC);
  const { address, outputKeyHex, path } = deriveTaprootAddress(seed, { ...HD_NETWORKS.regtest, index: 0 });
  assert.equal(path, "m/86'/1'/0'/0/0"); // testnet-family coin type 1
  assert.ok(address.startsWith('dgbrt1p'), address);
  const dec = decodeWitnessAddress(address);
  assert.equal(dec.version, 1);
  assert.equal(dec.programHex, outputKeyHex);
  // mainnet uses DigiByte's SLIP-44 coin type
  assert.equal(HD_NETWORKS.mainnet.coinType, 20);
  assert.equal(HD_NETWORKS.mainnet.hrp, 'dgb');
  assert.equal(HD_NETWORKS.testnet.hrp, 'dgbt');
});
