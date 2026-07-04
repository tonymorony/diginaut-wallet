// BIP-341 Taproot construction for DigiDollar outputs.
// Mirrors DigiByte Core v9.26.4 src/digidollar/scripts.cpp:
//   - DD token output  = owner x-only key, key-path-only tap tweak (no merkle root)
//   - collateral output = NUMS internal key + 2-leaf MAST (Normal + ERR paths)

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;

// BIP-341 NUMS point — Core's COLLATERAL_NUMS_POINT_BYTES (scripts.h).
// Key-path spending of collateral is provably impossible.
export const COLLATERAL_NUMS_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** BIP-341 output key: lift_x(internal) + H_TapTweak(internal || root?) · G. Returns x + y-parity. */
function tapTweakOutputKeyWithParity(internalKeyHex, merkleRoot /* Uint8Array | undefined */) {
  const internal = hexToBytes(internalKeyHex);
  const data = merkleRoot ? new Uint8Array([...internal, ...merkleRoot]) : internal;
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', data)));
  if (t >= CURVE_N) throw new RangeError('tap tweak overflow');
  const P = schnorr.utils.lift_x(BigInt('0x' + internalKeyHex));
  const Q = P.add(Point.BASE.multiply(t)).toAffine();
  return { xHex: Q.x.toString(16).padStart(64, '0'), parity: Number(Q.y & 1n) };
}

const tapTweakOutputKey = (internalKeyHex, merkleRoot) =>
  tapTweakOutputKeyWithParity(internalKeyHex, merkleRoot).xHex;

/**
 * DD token P2TR output key (vout[1] of a mint): the owner's x-only key,
 * key-path-only tweaked — Core's CreateDigiDollarP2TR.
 */
export function ddTokenOutputKey(ownerKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  return tapTweakOutputKey(ownerKeyHex);
}

// ---- Collateral MAST (Core scripts.cpp CreateCollateralP2TR) ----

// Opcodes (DigiByte script.h; 0xbb/0xbc/0xbe are DigiDollar additions)
const OP = {
  CLTV: 0xb1, DROP: 0x75, NOT: 0x91, VERIFY: 0x69, CHECKSIG: 0xac,
  DIGIDOLLAR: 0xbb, DDVERIFY: 0xbc, CHECKCOLLATERAL: 0xbe,
};

/** CScriptNum: minimal signed little-endian, pushed with a direct length byte. */
function pushScriptNum(value) {
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

const pushData = (bytes) => [bytes.length, ...bytes];

/** Normal redemption leaf: <lockHeight> CLTV DROP OP_DIGIDOLLAR <ddCents> OP_DDVERIFY <owner> CHECKSIG */
function normalRedemptionScript({ ownerKey, lockHeight, ddCents }) {
  return Uint8Array.from([
    ...pushScriptNum(lockHeight), OP.CLTV, OP.DROP,
    OP.DIGIDOLLAR, ...pushScriptNum(ddCents), OP.DDVERIFY,
    ...pushData(ownerKey), OP.CHECKSIG,
  ]);
}

/** ERR leaf: <lockHeight> CLTV DROP <100> CHECKCOLLATERAL NOT VERIFY OP_DIGIDOLLAR <ddCents> OP_DDVERIFY <owner> CHECKSIG */
function errRedemptionScript({ ownerKey, lockHeight, ddCents }) {
  return Uint8Array.from([
    ...pushScriptNum(lockHeight), OP.CLTV, OP.DROP,
    ...pushScriptNum(100), OP.CHECKCOLLATERAL, OP.NOT, OP.VERIFY,
    OP.DIGIDOLLAR, ...pushScriptNum(ddCents), OP.DDVERIFY,
    ...pushData(ownerKey), OP.CHECKSIG,
  ]);
}

const LEAF_VERSION = 0xc0;

function tapLeafHash(script) {
  // BIP-341: taggedHash("TapLeaf", leafVersion || compactSize(len) || script)
  if (script.length > 0xfc) throw new RangeError('leaf script too long for 1-byte compact size');
  return taggedHash('TapLeaf', Uint8Array.from([LEAF_VERSION, script.length, ...script]));
}

function tapBranchHash(a, b) {
  const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
  return taggedHash('TapBranch', new Uint8Array([...lo, ...hi]));
}

/**
 * Collateral P2TR output key (vout[0] of a mint): NUMS internal key tweaked
 * with the 2-leaf MAST root (Normal + ERR redemption paths, both at depth 1).
 */
export function collateralOutputKey({ ownerKeyHex, lockHeight, ddCents }) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  const params = { ownerKey: hexToBytes(ownerKeyHex), lockHeight, ddCents };
  const root = tapBranchHash(
    tapLeafHash(normalRedemptionScript(params)),
    tapLeafHash(errRedemptionScript(params)),
  );
  return tapTweakOutputKey(COLLATERAL_NUMS_KEY, root);
}

/** The Normal redemption leaf script (hex) — the script revealed when redeeming. */
export function normalRedemptionLeafHex({ ownerKeyHex, lockHeight, ddCents }) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  return bytesToHex(normalRedemptionScript({ ownerKey: hexToBytes(ownerKeyHex), lockHeight, ddCents }));
}

/** BIP-341 tapleaf hash of the Normal redemption leaf (Uint8Array) — for script-path sighash. */
export function normalRedemptionLeafHash(params) {
  return tapLeafHash(hexToBytes(normalRedemptionLeafHex(params)));
}

/**
 * Control block (hex) for spending the collateral via the Normal leaf:
 * (0xc0 | output-key parity) ++ NUMS internal key ++ ERR-leaf sibling hash.
 */
export function collateralControlBlockHex({ ownerKeyHex, lockHeight, ddCents }) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  const params = { ownerKey: hexToBytes(ownerKeyHex), lockHeight, ddCents };
  const errLeafHash = tapLeafHash(errRedemptionScript(params));
  const root = tapBranchHash(tapLeafHash(normalRedemptionScript(params)), errLeafHash);
  const { parity } = tapTweakOutputKeyWithParity(COLLATERAL_NUMS_KEY, root);
  return bytesToHex(Uint8Array.from([LEAF_VERSION | parity])) + COLLATERAL_NUMS_KEY + bytesToHex(errLeafHash);
}
