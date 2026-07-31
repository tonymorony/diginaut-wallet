// Generic BIP-341 tapscript layer — product-agnostic, no DigiDollar semantics.
// The math taproot.js hand-rolled for the 2-leaf collateral MAST (Core v9.26.4
// src/digidollar/scripts.cpp), generalized so a second construction does not
// become a second copy: taproot.js builds the collateral MAST on top of these,
// bond.js builds the Lock & Earn bond leaf, and both stay byte-identical to the
// Core-mined fixtures that pin them.
//
// Tree shapes: `tapRootFromLeaves` is a FLAT lexicographic fold and
// `controlBlockHex` supports 1 leaf (33-byte block, no sibling) or 2 leaves
// (65-byte block, one sibling hash). Those are the only shapes any product uses
// — bond: a single CLTV+CHECKSIG leaf; collateral: Normal + ERR at depth 1.
// Deeper (nested) trees have a structure a flat fold cannot express, so they are
// refused rather than silently mis-derived.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;

/** BIP-341 NUMS point H — Core's COLLATERAL_NUMS_POINT_BYTES (scripts.h). */
export const NUMS_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

export const TAPLEAF_VERSION = 0xc0;

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** CScriptNum: minimal signed little-endian, pushed with a direct length byte. */
export function pushScriptNum(value) {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('negative script numbers not needed here');
  if (v === 0n) return [0x00]; // OP_0
  const bytes = [];
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00); // keep it positive
  return [bytes.length, ...bytes];
}

/**
 * Direct-length data push (opcodes 1–75). Every push in every DigiDollar and
 * Lock & Earn script is a 32-byte key or a short CScriptNum, so OP_PUSHDATA1+
 * is refused rather than guessed at.
 */
export function pushData(bytes) {
  if (bytes.length < 1 || bytes.length > 75) {
    throw new RangeError(`direct push must be 1–75 bytes, got ${bytes.length}`);
  }
  return [bytes.length, ...bytes];
}

/** BIP-341 TapLeaf hash: taggedHash("TapLeaf", version || compactSize(len) || script). */
export function tapLeafHash(scriptBytes, leafVersion = TAPLEAF_VERSION) {
  if (scriptBytes.length > 0xfc) throw new RangeError('leaf script too long for 1-byte compact size');
  return taggedHash('TapLeaf', Uint8Array.from([leafVersion, scriptBytes.length, ...scriptBytes]));
}

function lexicographicCompare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** BIP-341 TapBranch: the two children hashed in lexicographic order. */
export function tapBranchHash(a, b) {
  // No Buffer here — this module must also run in the browser.
  const [lo, hi] = lexicographicCompare(a, b) <= 0 ? [a, b] : [b, a];
  return taggedHash('TapBranch', new Uint8Array([...lo, ...hi]));
}

/**
 * Merkle root of a FLAT tree: one leaf → the leaf hash itself; otherwise a left
 * fold of TapBranch (each combine sorts its pair, so the order of a 2-leaf array
 * does not matter). Not a general BIP-341 tree builder — see the header.
 */
export function tapRootFromLeaves(leafHashes) {
  if (!leafHashes?.length) throw new RangeError('a taptree needs at least one leaf');
  return leafHashes.reduce((acc, h) => (acc ? tapBranchHash(acc, h) : h), null);
}

/**
 * BIP-341 output key: lift_x(internal) + H_TapTweak(internal || root?)·G.
 * Omit `merkleRoot` for a key-path-only output. Returns x-only hex + y-parity
 * (the parity rides in the control block's first byte).
 */
export function tapOutputKey(internalKeyHex, merkleRoot /* Uint8Array | undefined */) {
  if (!/^[0-9a-f]{64}$/.test(internalKeyHex)) throw new RangeError('internal key must be 32-byte hex');
  const internal = hexToBytes(internalKeyHex);
  const data = merkleRoot ? new Uint8Array([...internal, ...merkleRoot]) : internal;
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', data)));
  if (t >= CURVE_N) throw new RangeError('tap tweak overflow');
  const P = schnorr.utils.lift_x(BigInt('0x' + internalKeyHex));
  const Q = P.add(Point.BASE.multiply(t)).toAffine();
  return { xHex: Q.x.toString(16).padStart(64, '0'), parity: Number(Q.y & 1n) };
}

/**
 * Control block (hex) for a script-path spend of `leafIndex`:
 * (leafVersion | output-key parity) ++ internal key ++ sibling hashes.
 * 33 bytes for a single-leaf tree, 65 for a two-leaf tree.
 */
export function controlBlockHex({ internalKeyHex, leafHashes, leafIndex = 0, leafVersion = TAPLEAF_VERSION }) {
  if (!leafHashes?.length) throw new RangeError('a taptree needs at least one leaf');
  if (leafHashes.length > 2) {
    throw new RangeError(`control blocks are built for 1- or 2-leaf trees, got ${leafHashes.length} — no product needs deeper trees yet`);
  }
  if (!(leafIndex >= 0 && leafIndex < leafHashes.length)) {
    throw new RangeError(`leafIndex ${leafIndex} is outside the tree`);
  }
  const { parity } = tapOutputKey(internalKeyHex, tapRootFromLeaves(leafHashes));
  const sibling = leafHashes.length === 2 ? bytesToHex(leafHashes[1 - leafIndex]) : '';
  return bytesToHex(Uint8Array.from([leafVersion | parity])) + internalKeyHex + sibling;
}
