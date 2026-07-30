// BIP-341 Taproot construction for DigiDollar outputs.
// Mirrors DigiByte Core v9.26.4 src/digidollar/scripts.cpp:
//   - DD token output  = owner x-only key, key-path-only tap tweak (no merkle root)
//   - collateral output = NUMS internal key + 2-leaf MAST (Normal + ERR paths)
// The tagged-hash/tweak/control-block math lives in tapscript.js; this module is
// only the DigiDollar leaf layouts. Exports are byte-identical to the hand-rolled
// version they replaced — the Core-mined mint/redeem fixtures are the pin.

import { NUMS_KEY, pushScriptNum, pushData, tapLeafHash, tapRootFromLeaves, tapOutputKey, controlBlockHex } from './tapscript.js';

// BIP-341 NUMS point — Core's COLLATERAL_NUMS_POINT_BYTES (scripts.h).
// Key-path spending of collateral is provably impossible.
export const COLLATERAL_NUMS_KEY = NUMS_KEY;

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * DD token P2TR output key (vout[1] of a mint): the owner's x-only key,
 * key-path-only tweaked — Core's CreateDigiDollarP2TR.
 */
export function ddTokenOutputKey(ownerKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  return tapOutputKey(ownerKeyHex).xHex;
}

// ---- Collateral MAST (Core scripts.cpp CreateCollateralP2TR) ----

// Opcodes (DigiByte script.h; 0xbb/0xbc/0xbe are DigiDollar additions)
const OP = {
  CLTV: 0xb1, DROP: 0x75, NOT: 0x91, VERIFY: 0x69, CHECKSIG: 0xac,
  DIGIDOLLAR: 0xbb, DDVERIFY: 0xbc, CHECKCOLLATERAL: 0xbe,
};

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

/** The MAST's two leaf hashes, Normal first (leafIndex 0 is the redeem path). */
function collateralLeafHashes({ ownerKeyHex, lockHeight, ddCents }) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  const params = { ownerKey: hexToBytes(ownerKeyHex), lockHeight, ddCents };
  return [tapLeafHash(normalRedemptionScript(params)), tapLeafHash(errRedemptionScript(params))];
}

/**
 * Collateral P2TR output key (vout[0] of a mint): NUMS internal key tweaked
 * with the 2-leaf MAST root (Normal + ERR redemption paths, both at depth 1).
 */
export function collateralOutputKey(params) {
  return tapOutputKey(COLLATERAL_NUMS_KEY, tapRootFromLeaves(collateralLeafHashes(params))).xHex;
}

/** The Normal redemption leaf script (hex) — the script revealed when redeeming. */
export function normalRedemptionLeafHex({ ownerKeyHex, lockHeight, ddCents }) {
  if (!/^[0-9a-f]{64}$/.test(ownerKeyHex)) throw new RangeError('owner key must be 32-byte hex');
  return bytesToHex(normalRedemptionScript({ ownerKey: hexToBytes(ownerKeyHex), lockHeight, ddCents }));
}

/** BIP-341 tapleaf hash of the Normal redemption leaf (Uint8Array) — for script-path sighash. */
export function normalRedemptionLeafHash(params) {
  return collateralLeafHashes(params)[0];
}

/**
 * Control block (hex) for spending the collateral via the Normal leaf:
 * (0xc0 | output-key parity) ++ NUMS internal key ++ ERR-leaf sibling hash.
 */
export function collateralControlBlockHex(params) {
  return controlBlockHex({
    internalKeyHex: COLLATERAL_NUMS_KEY,
    leafHashes: collateralLeafHashes(params),
    leafIndex: 0,
  });
}
