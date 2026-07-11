// digidollar-js — pure-protocol DigiDollar library (ADR-0004: deterministic, zero I/O).
// Arithmetic mirrors DigiByte Core v9.26.4 exactly:
//   src/consensus/digidollar.h   (lock tiers, cents, BLOCKS_PER_DAY)
//   src/consensus/dca.cpp        (DCA basis-points ceiling math)
//   src/digidollar/txbuilder.cpp (collateral formula, 1% safety margin)
// All money values are BigInt: DGB in satoshis, DigiDollar in cents,
// oracle price in micro-USD per DGB (1_000_000n = $1.00).

export const COIN = 100_000_000n; // satoshis per DGB
export const MAX_MONEY = 21_000_000_000n * COIN;

const BLOCKS_PER_DAY = 24 * 60 * 4; // 5760 — 15-second blocks
const DCA_BPS_SCALE = 10_000n; // 10000 bps = 1.0×

// Consensus lock tiers from DigiByte Core v9.26.4 (consensus/digidollar.h).
// Higher collateral for shorter locks — treasury model.
export const LOCK_TIERS = Object.freeze([
  { id: '1hour', lockBlocks: 240, ratioPercent: 1000, label: '1 hour' },
  { id: '30days', lockBlocks: 30 * BLOCKS_PER_DAY, ratioPercent: 500, label: '30 days' },
  { id: '3months', lockBlocks: 90 * BLOCKS_PER_DAY, ratioPercent: 400, label: '3 months' },
  { id: '6months', lockBlocks: 180 * BLOCKS_PER_DAY, ratioPercent: 350, label: '6 months' },
  { id: '1year', lockBlocks: 365 * BLOCKS_PER_DAY, ratioPercent: 300, label: '1 year' },
  { id: '2years', lockBlocks: 2 * 365 * BLOCKS_PER_DAY, ratioPercent: 275, label: '2 years' },
  { id: '3years', lockBlocks: 3 * 365 * BLOCKS_PER_DAY, ratioPercent: 250, label: '3 years' },
  { id: '5years', lockBlocks: 5 * 365 * BLOCKS_PER_DAY, ratioPercent: 225, label: '5 years' },
  { id: '7years', lockBlocks: 7 * 365 * BLOCKS_PER_DAY, ratioPercent: 212, label: '7 years' },
  { id: '10years', lockBlocks: 10 * 365 * BLOCKS_PER_DAY, ratioPercent: 200, label: '10 years' },
].map(Object.freeze));

export function tierById(tierId) {
  return LOCK_TIERS.find((t) => t.id === tierId);
}

const ceilDiv = (n, d) => (n + d - 1n) / d;

/**
 * Collateral ratio in percent after the DCA network-health multiplier —
 * Core dca.cpp ApplyDCA: ceil(baseRatio × multiplierBps / 10000).
 * Exported so UI quote surfaces display the same ratio the mint pays.
 */
export function effectiveRatioPercent(ratioPercent, dcaMultiplierBps = 10_000n) {
  return Number(ceilDiv(BigInt(ratioPercent) * dcaMultiplierBps, DCA_BPS_SCALE));
}

/**
 * DGB satoshis that must be locked to mint the given DigiDollar amount.
 * Exact Core arithmetic: ceiling division, MAX_MONEY caps, +1% safety margin (floored).
 *
 * @param {object} p
 * @param {bigint} p.ddCents               DigiDollar amount in cents (100n = $1.00)
 * @param {string} p.tierId                one of LOCK_TIERS ids, e.g. '6months'
 * @param {bigint} p.oraclePriceMicroUsd   DGB price in micro-USD (1_000_000n = $1.00)
 * @param {bigint} [p.dcaMultiplierBps]    DCA multiplier in basis points (default 10_000n = healthy)
 * @returns {bigint} required collateral in satoshis
 */
export function requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd, dcaMultiplierBps = 10_000n }) {
  const tier = tierById(tierId);
  if (!tier) throw new RangeError(`unknown lock tier: ${tierId}`);
  if (ddCents <= 0n) throw new RangeError(`DigiDollar amount must be positive, got ${ddCents}`);
  if (oraclePriceMicroUsd <= 0n) throw new RangeError(`oracle price must be positive, got ${oraclePriceMicroUsd}`);

  const effectiveRatio = BigInt(effectiveRatioPercent(tier.ratioPercent, dcaMultiplierBps));

  // Core txbuilder.cpp: base = ceil(ddCents * COIN * ratio * 100 / priceMicroUsd)
  const base = ceilDiv(ddCents * COIN * effectiveRatio * 100n, oraclePriceMicroUsd);
  if (base > MAX_MONEY) throw new RangeError('required collateral exceeds MAX_MONEY');

  // Core ApplyCollateralSafetyMargin: floor(base * 101 / 100), re-capped
  const withMargin = (base * 101n) / 100n;
  if (withMargin > MAX_MONEY) throw new RangeError('required collateral exceeds MAX_MONEY');
  return withMargin;
}

export { buildDDVersion, parseDDVersion, parseMintMetadata, buildMintMetadata, parseTransferMetadata, buildTransferMetadata, parseRedeemMetadata, buildRedeemMetadata } from './envelope.js';
export { ddTokenOutputKey, collateralOutputKey, normalRedemptionLeafHex, normalRedemptionLeafHash, collateralControlBlockHex, COLLATERAL_NUMS_KEY } from './taproot.js';
export { encodeWitnessAddress, decodeWitnessAddress, scriptPubKeyFromAddress, encodeDDAddress, decodeDDAddress, toDDAddress, decodeAddress, decodeLegacyAddress } from './address.js';
export { encodeBip21, parseBip21, satsToDgbString } from './bip21.js';
export { buildSignedMintTx, buildSignedTransferTx, buildTransferOutputs, buildSignedRedeemTx, buildRedeemOutputs, planSpend, planMaxSpend, buildSignedSpendTx, serializeTx, xOnlyPubKey, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS, MIN_DD_TX_FEE_SATS, STANDARD_FEE_RATE_SATS_PER_KVB } from './txbuild.js';
export { generateMnemonic, validateMnemonic, mnemonicToSeed, deriveTaprootAddress, p2wpkhAddress, HD_NETWORKS } from './hd.js';

// Consensus DigiDollar transaction limits (v9.26.4: consensus/digidollar.h
// defaults; kernel/chainparams.cpp regtest overrides). The node enforces these
// at mempool/consensus level (bad-dd-mint-amount) — the wallet checks them
// BEFORE signing so users get an actionable error, not a raw reject.
export const DD_TX_LIMITS = Object.freeze({
  mainnet: Object.freeze({ minMintCents: 10_000n, maxMintCents: 10_000_000n, minOutputCents: 100n }),
  testnet: Object.freeze({ minMintCents: 10_000n, maxMintCents: 10_000_000n, minOutputCents: 100n }),
  regtest: Object.freeze({ minMintCents: 1n, maxMintCents: 100_000n, minOutputCents: 100n }),
});
