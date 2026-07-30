// Generic BIP-341 tapscript layer (src/tapscript.js), pinned three ways:
//
//  1. UPSTREAM vectors — test/fixtures/bip341-wallet-vectors.json is a verbatim
//     copy of DigiByte Core v9.26.4 src/test/data/bip341_wallet_vectors.json.
//     Leaf hashes, merkle roots, output-key tweaks and control blocks come from
//     BIP-341 itself, so they are independent of every line in this package.
//  2. EQUIVALENCE — the collateral MAST driven through these generics must equal
//     taproot.js's hand-rolled exports, which are already pinned byte-for-byte
//     against real Core transactions (taproot.test.js, txbuild.test.js).
//  3. PROTOTYPE cross-pin — the bond leaf/output-key constants below are the
//     values prototypes/lock-earn/logic.js produces for the same inputs. The
//     prototype is a separate replica of the same BIP-341 math; its code is
//     deliberately NOT imported here (throwaway code stays out of the suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COLLATERAL_NUMS_KEY, collateralOutputKey, collateralControlBlockHex, normalRedemptionLeafHex } from 'digidollar-js';
import { NUMS_KEY, pushScriptNum, pushData, tapLeafHash, tapRootFromLeaves, tapOutputKey, controlBlockHex } from '../src/tapscript.js';

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const vectors = JSON.parse(
  await readFile(new URL('./fixtures/bip341-wallet-vectors.json', import.meta.url), 'utf8'),
);

// ---- push encodings ----

test('pushScriptNum encodes CScriptNum minimally, little-endian, with a length byte', () => {
  assert.deepEqual(pushScriptNum(0), [0x00]);          // OP_0 — empty push
  assert.deepEqual(pushScriptNum(1), [0x01, 0x01]);
  assert.deepEqual(pushScriptNum(1060), [0x02, 0x24, 0x04]);
  assert.deepEqual(pushScriptNum(128), [0x02, 0x80, 0x00]); // sign-padded: high bit set
  assert.deepEqual(pushScriptNum(10_000n), [0x02, 0x10, 0x27]);
  assert.throws(() => pushScriptNum(-1), RangeError);
});

test('pushData writes a direct-length push and refuses sizes needing OP_PUSHDATA', () => {
  assert.deepEqual(pushData(Uint8Array.from([0xaa, 0xbb])), [0x02, 0xaa, 0xbb]);
  // The prototype and taproot.js both hardcode 0x20 for 32-byte keys; this
  // generalization must produce that same byte.
  assert.equal(pushData(new Uint8Array(32))[0], 0x20);
  assert.throws(() => pushData(new Uint8Array(76)), /direct push/);
});

// ---- upstream BIP-341 vectors ----

test('tapLeafHash matches every leaf hash in the upstream BIP-341 vectors', () => {
  let leaves = 0;
  for (const v of vectors.scriptPubKey) {
    const tree = v.given.scriptTree;
    if (!tree) continue;
    const flat = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      flat.push(node);
    })(tree);
    // Upstream lists leafHashes in `id` order, not tree order.
    for (const leaf of flat) {
      assert.equal(
        bytesToHex(tapLeafHash(hexToBytes(leaf.script), leaf.leafVersion)),
        v.intermediary.leafHashes[leaf.id],
        `leaf ${leaf.id} of ${v.expected.scriptPubKey}`,
      );
      leaves += 1;
    }
  }
  assert.equal(leaves, 12); // 6 trees; every leaf in the file
});

test('tapOutputKey reproduces every upstream tweaked pubkey and scriptPubKey', () => {
  for (const v of vectors.scriptPubKey) {
    const root = v.intermediary.merkleRoot ? hexToBytes(v.intermediary.merkleRoot) : undefined;
    const { xHex } = tapOutputKey(v.given.internalPubkey, root);
    assert.equal(xHex, v.intermediary.tweakedPubkey);
    assert.equal(`5120${xHex}`, v.expected.scriptPubKey);
  }
});

test('tapRootFromLeaves folds the upstream 1- and 2-leaf trees to their merkle roots', () => {
  // Flat fold only. Nested trees (upstream vectors 5 and 6, three leaves each)
  // are NOT reproducible this way and are deliberately not asserted — no product
  // needs one, and controlBlockHex refuses them outright.
  const flatTrees = vectors.scriptPubKey.filter(
    (v) => v.intermediary.leafHashes && v.intermediary.leafHashes.length <= 2,
  );
  assert.equal(flatTrees.length, 4);
  for (const v of flatTrees) {
    assert.equal(
      bytesToHex(tapRootFromLeaves(v.intermediary.leafHashes.map(hexToBytes))),
      v.intermediary.merkleRoot,
    );
  }
});

test('controlBlockHex reproduces the upstream control blocks for 1- and 2-leaf trees', () => {
  const flatTrees = vectors.scriptPubKey.filter(
    (v) => v.intermediary.leafHashes && v.intermediary.leafHashes.length <= 2,
  );
  let checked = 0;
  for (const v of flatTrees) {
    const leafHashes = v.intermediary.leafHashes.map(hexToBytes);
    const versions = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      versions[node.id] = node.leafVersion;
    })(v.given.scriptTree);
    for (const [leafIndex, expected] of v.expected.scriptPathControlBlocks.entries()) {
      assert.equal(
        controlBlockHex({
          internalKeyHex: v.given.internalPubkey,
          leafHashes,
          leafIndex,
          leafVersion: versions[leafIndex],
        }),
        expected,
        `control block ${leafIndex} of ${v.expected.scriptPubKey}`,
      );
      // 33 bytes with no sibling, 65 with one.
      assert.equal(expected.length / 2, leafHashes.length === 1 ? 33 : 65);
      checked += 1;
    }
  }
  assert.equal(checked, 6);
});

test('tapRootFromLeaves needs a leaf, and controlBlockHex refuses trees deeper than one branch', () => {
  assert.throws(() => tapRootFromLeaves([]), /at least one leaf/);
  const leafHashes = [new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
  assert.throws(
    () => controlBlockHex({ internalKeyHex: NUMS_KEY, leafHashes, leafIndex: 0 }),
    /deeper trees/,
  );
  assert.throws(
    () => controlBlockHex({ internalKeyHex: NUMS_KEY, leafHashes: leafHashes.slice(0, 2), leafIndex: 2 }),
    /leafIndex/,
  );
});

// ---- equivalence with taproot.js (which is pinned to real Core transactions) ----

// The redeemed collateral of the Core fixture redeem-tx.json (txid b834557b…):
// 1hour tier, lockHeight 1064, $100.00. The ERR leaf is transcribed here from
// Core scripts.cpp's layout — <h> CLTV DROP <100> CHECKCOLLATERAL NOT VERIFY
// OP_DIGIDOLLAR <cents> OP_DDVERIFY <owner> CHECKSIG — so this test knows both
// leaves without reaching into taproot.js's private functions.
const REDEEM = {
  ownerKeyHex: '9c42c105e9be2f6712b004953174a956d9bd7674fd26ccd5d17f5c50e88bd3ef',
  lockHeight: 1_064,
  ddCents: 10_000n,
};
const ERR_LEAF_HEX = '022804b1750164be9169bb021027bc20' + REDEEM.ownerKeyHex + 'ac';

test('the collateral MAST through these generics equals taproot.js byte-for-byte', () => {
  const leafHashes = [
    tapLeafHash(hexToBytes(normalRedemptionLeafHex(REDEEM))),
    tapLeafHash(hexToBytes(ERR_LEAF_HEX)),
  ];
  const root = tapRootFromLeaves(leafHashes);
  assert.equal(tapOutputKey(NUMS_KEY, root).xHex, collateralOutputKey(REDEEM));
  assert.equal(
    controlBlockHex({ internalKeyHex: NUMS_KEY, leafHashes, leafIndex: 0 }),
    collateralControlBlockHex(REDEEM),
  );
});

test('NUMS_KEY is the same constant taproot.js exports as COLLATERAL_NUMS_KEY', () => {
  assert.equal(NUMS_KEY, COLLATERAL_NUMS_KEY);
});

// ---- pinned bond vectors (cross-checked against the prototype) ----
// Staker key = x-only pubkey of the fixed private key 32×0x07 (the
// connect.test.js convention); unlockHeight 1060 = the prototype's genesis
// 1000 + one 60-block epoch. Every constant below is what
// prototypes/lock-earn/logic.js computes for these inputs.

const STAKER_KEY = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f';
const BOND_LEAF_HEX = `022404b17520${STAKER_KEY}ac`;
const BOND_LEAF_HASH = '802879c5f158d239036d4c422995f2c6063f85e8b4f2bd08b9d3225a6fa89cfb';
const BOND_OUTPUT_KEY = '4fe4fca393537226aabf51567393637a1b060f91c3d3e7c65b71ee89c7668ba5';
const BOND_CONTROL_BLOCK = `c0${NUMS_KEY}`;

test('the bond leaf hash, output key and 33-byte control block are pinned', () => {
  const leafHash = tapLeafHash(hexToBytes(BOND_LEAF_HEX));
  assert.equal(BOND_LEAF_HEX.length / 2, 39);
  assert.equal(bytesToHex(leafHash), BOND_LEAF_HASH);
  // Single leaf: the merkle root IS the leaf hash, and the control block has no
  // sibling — 33 bytes, output-key parity even (0xc0) for these inputs.
  assert.equal(bytesToHex(tapRootFromLeaves([leafHash])), BOND_LEAF_HASH);
  assert.equal(tapOutputKey(NUMS_KEY, leafHash).xHex, BOND_OUTPUT_KEY);
  assert.equal(
    controlBlockHex({ internalKeyHex: NUMS_KEY, leafHashes: [leafHash], leafIndex: 0 }),
    BOND_CONTROL_BLOCK,
  );
  assert.equal(BOND_CONTROL_BLOCK.length / 2, 33);
});
