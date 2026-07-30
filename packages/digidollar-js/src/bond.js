// Lock & Earn protocol templates — the DigiDollar bond, the pre-signed floor
// distribution, and the verifier a staker runs on someone else's bytes.
// Zero consensus changes: every shape here is an ordinary DigiDollar transfer
// (nVersion marker 0x0770 type 2) whose recipients happen to be tapscript
// outputs, so Core validates them with the rules it already has.
//
// The five constructions:
//   lock         plain transfer paying the bond output key (NUMS + one CLTV leaf)
//   unlock       script-path spend of that leaf at nLockTime = unlockHeight
//   escrow split one transfer paying ONE ephemeral-key output PER CHUNK — DD
//                conservation is per-transaction (validation.cpp:1874-1879) and
//                a UTXO spends once, so N chunks cannot share one escrow UTXO
//   distribution one escrow input, SIGHASH_ALL|ANYONECANPAY, payouts + envelope
//                only — no valued output, no change
//   fee attach   any staker appends their own fee input and signs it 0x00
//
// CHUNK RECORD — the versioned interchange format published by the operator and
// consumed by wallets, the registry and any third-party verifier:
//   { v: 1, txHex, escrow: { txidHex, vout, cents }, payouts: [{ outputKeyHex,
//     cents }], lockTimeHeight }
// `v` is checked before anything else is trusted; a future field set gets v: 2
// and its own verifier branch. The transport is the registry ticket's business,
// not this shape's.
//
// The signing keys differ per input on purpose: the bond leaf's CHECKSIG
// verifies the RAW staker key (a tapscript CHECKSIG never tweaks), while every
// key-path input signs the tweaked key. The redeem builder in txbuild.js is the
// same split and the same precedent.

import { schnorr } from '@noble/curves/secp256k1.js';
import { NUMS_KEY, pushScriptNum, pushData, tapLeafHash, tapRootFromLeaves, tapOutputKey, controlBlockHex } from './tapscript.js';
import { ddTokenOutputKey } from './taproot.js';
import { buildDDVersion, buildTransferMetadata } from './envelope.js';
import {
  serializeTx, parseTx, buildTransferOutputs, buildSignedTransferTx, xOnlyPubKey, p2wpkhProgramHex,
  taprootSighash, signSighash, tapTweakPrivKey, checkBuiltDDTx, assertBuiltDDTx,
  MIN_DD_TX_FEE_SATS, MIN_DD_OUTPUT_CENTS, MAX_DD_OUTPUT_CENTS, CHANGE_FOLD_SATS, OP_RETURN_RELAY_CAP_BYTES,
  SIGHASH_DEFAULT,
} from './txbuild.js';

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const p2trHex = (outputKeyHex) => `5120${outputKeyHex}`;
const sum = (values) => values.reduce((s, v) => s + v, 0n);

/** Product cap: 8 payouts per distribution, under the 83-byte envelope cap. */
export const MAX_PAYOUTS_PER_CHUNK = 8;
/**
 * Chunks an escrow split can fund: one DigiDollar output each, under the same
 * 8-output product cap (design §6.1). With MAX_PAYOUTS_PER_CHUNK this sets the
 * pilot's ceiling at 8 × 8 = 64 paid stakers per epoch. A separate constant
 * from the per-chunk cap because it bounds a different thing, and because a
 * split that also emits DD change has 9 DigiDollar outputs, not 8.
 */
export const MAX_CHUNKS_PER_SPLIT = 8;
// BIP-65: CHECKLOCKTIMEVERIFY compares its argument against the block HEIGHT
// below LOCKTIME_THRESHOLD and against the block TIME at or above it.
const LOCKTIME_THRESHOLD = 500_000_000;
// SIGHASH_ALL | SIGHASH_ANYONECANPAY, written as a literal rather than composed
// from txbuild.js's exported constants: index.js and txbuild.js form an ESM
// cycle (txbuild.js imports the lock tiers from index.js), so depending on which
// file a process imports first this module can be evaluated while txbuild.js is
// still initializing — and a module-level read of its bindings then lands in the
// temporal dead zone. Nothing at this module's top level may read an import.
const DISTRIBUTION_HASH_TYPE = 0x81;
/** CLTV needs a non-final input; 0xffffffff would disable nLockTime entirely. */
const NON_FINAL_SEQUENCE = 0xfffffffe;

const OP = { CLTV: 0xb1, DROP: 0x75, CHECKSIG: 0xac };

function assertKey(hex, what) {
  if (!/^[0-9a-f]{64}$/.test(hex ?? '')) throw new RangeError(`${what} must be 32-byte hex`);
  return hex;
}

/**
 * A block height CLTV and nLockTime will agree on. Both failure modes above the
 * bound are silent and unrecoverable, so they are refused at construction:
 *   - [500,000,000, 2^32): BIP-65 LOCKTIME_THRESHOLD — CLTV switches to
 *     comparing a UNIX TIMESTAMP, so a "height" up here is a 1985 date and the
 *     lock is a no-op that anyone can spend immediately.
 *   - >= 2^32: pushScriptNum writes a 5-byte CScriptNum the leaf keeps, while
 *     nLockTime is a uint32 that truncates mod 2^32 — the comparison can then
 *     never succeed. A bond is a single leaf under NUMS with no key path, so
 *     that coin is permanently unspendable.
 */
function assertBlockHeight(value, what) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${what} must be a positive block height, got ${value}`);
  }
  if (value >= LOCKTIME_THRESHOLD) {
    throw new RangeError(`${what} ${value} is at or above BIP-65's 500,000,000 threshold, where CHECKLOCKTIMEVERIFY compares a timestamp instead of a block height`);
  }
}

// ---- the bond ----

/**
 * The bond's single tapscript leaf:
 *   <unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <staker x-only key> OP_CHECKSIG
 * Only the staker's key can ever spend it, and only at or after unlockHeight.
 * 39 bytes for a 2-byte height; the CScriptNum grows with the height, so a
 * mainnet-scale height makes a 41-byte leaf. Byte-identical to the leaf
 * prototypes/lock-earn/logic.js builds for the same inputs.
 */
export function bondLeafHex({ stakerKeyHex, unlockHeight }) {
  assertKey(stakerKeyHex, 'staker key');
  assertBlockHeight(unlockHeight, 'unlock height');
  return bytesToHex(Uint8Array.from([
    ...pushScriptNum(unlockHeight), OP.CLTV, OP.DROP,
    ...pushData(hexToBytes(stakerKeyHex)), OP.CHECKSIG,
  ]));
}

const bondLeafHash = (bond) => tapLeafHash(hexToBytes(bondLeafHex(bond)));

/**
 * The bond's P2TR output key: a single-leaf tree over the BIP-341 NUMS internal
 * key, so the merkle root IS the leaf hash and no key path exists — the only
 * way to move the coin is the leaf, i.e. the staker's key after unlockHeight.
 */
export function bondOutputKey({ stakerKeyHex, unlockHeight }) {
  return tapOutputKey(NUMS_KEY, tapRootFromLeaves([bondLeafHash({ stakerKeyHex, unlockHeight })])).xHex;
}

/** 33-byte control block for the bond leaf: (0xc0 | parity) ++ NUMS, no sibling. */
export function bondControlBlockHex({ stakerKeyHex, unlockHeight }) {
  return controlBlockHex({
    internalKeyHex: NUMS_KEY,
    leafHashes: [bondLeafHash({ stakerKeyHex, unlockHeight })],
    leafIndex: 0,
  });
}

// ---- operator arithmetic ----

/**
 * Split an escrowed pool across stakes, carrying what cannot become an output.
 *
 *   share_i = floor(poolCents · stake_i / totalStake) + carryIn_i
 *
 * A share below the $1.00 minimum DD output (consensus validation.cpp:1756-1758)
 * pays nothing on-chain and rolls to `carryOutCents` in full — the prototype's
 * validated model. Payouts come back SORTED ASCENDING by `outputKeyHex` so two
 * independent verifiers partition the same payouts into the same chunks.
 * `carryOutCents` holds only non-zero entries, and carry belonging to someone
 * who did not stake this epoch is passed through untouched rather than dropped.
 * `remainderCents` is the flooring dust (< one cent per staker) that pro-rata
 * cannot allocate; it is neither paid nor promised, and is returned so the
 * operator's ledger balances exactly:
 *   Σ payouts + Σ carryOut + remainder == poolCents + Σ carryIn.
 *
 * PROVISIONAL (#146 grilling): the per-staker carry identity and the sorted
 * ordering are recommendations from the design, not settled product rules — a
 * change is one line here plus its fixtures. The pool↔rate causality (does the
 * escrowed pool set the advertised rate or follow it?) is also open, and this
 * function is deliberately indifferent: it takes `poolCents` as given.
 */
export function computeFloorShares({ stakes, poolCents, carryInCents = {} }) {
  if (!stakes?.length) throw new RangeError('at least one stake is required');
  if (poolCents < 0n) throw new RangeError('pool must not be negative');
  const seen = new Set();
  for (const s of stakes) {
    assertKey(s.outputKeyHex, 'stake output key');
    if (seen.has(s.outputKeyHex)) {
      throw new RangeError(`stake output keys must be unique — ${s.outputKeyHex.slice(0, 12)}… appears twice; merge a staker's stakes before splitting`);
    }
    seen.add(s.outputKeyHex);
    if (s.cents <= 0n) throw new RangeError('stakes must be positive');
  }
  for (const [k, v] of Object.entries(carryInCents)) {
    assertKey(k, 'carry-in output key');
    if (typeof v !== 'bigint' || v < 0n) {
      throw new RangeError(`carry-in for ${k.slice(0, 12)}… must be a non-negative BigInt of cents, got ${typeof v} ${v}`);
    }
  }
  const totalStake = sum(stakes.map((s) => s.cents));

  const payouts = [];
  const carryOutCents = {};
  let allocated = 0n;
  for (const s of stakes) {
    const floorShare = (poolCents * s.cents) / totalStake; // BigInt division floors
    allocated += floorShare;
    const share = floorShare + (carryInCents[s.outputKeyHex] ?? 0n);
    if (share < MIN_DD_OUTPUT_CENTS) {
      if (share > 0n) carryOutCents[s.outputKeyHex] = share;
      continue;
    }
    payouts.push({ outputKeyHex: s.outputKeyHex, cents: share });
  }
  for (const [k, v] of Object.entries(carryInCents)) {
    if (!seen.has(k) && v > 0n) carryOutCents[k] = v;
  }
  payouts.sort((a, b) => (a.outputKeyHex < b.outputKeyHex ? -1 : 1));
  return { payouts, carryOutCents, remainderCents: poolCents - allocated };
}

/**
 * Partition payouts into distribution chunks, greedily, under BOTH bounds:
 * the 8-payout product cap and the real 83-byte OP_RETURN relay cap the
 * rebuilt envelope must fit (Core policy.h:74 — DigiDollar has no exemption).
 * Returns `[{ payouts, sumCents, envelopeHex }]`, order preserved.
 */
export function planDistributionChunks({ payouts }) {
  if (!payouts?.length) throw new RangeError('at least one payout is required');
  for (const [i, p] of payouts.entries()) {
    assertKey(p.outputKeyHex, 'payout output key');
    if (p.cents < MIN_DD_OUTPUT_CENTS) {
      throw new RangeError(`consensus forbids DigiDollar outputs below $1.00 — this payout is $${(Number(p.cents) / 100).toFixed(2)}`);
    }
    if (p.cents > MAX_DD_OUTPUT_CENTS) {
      throw new RangeError(`consensus forbids DigiDollar outputs above $100,000.00 — this payout is $${(Number(p.cents) / 100).toFixed(2)}`);
    }
    // Chunk boundaries fall wherever the ordering puts them, so two verifiers
    // only agree on the same partition if they start from the same order. This
    // function CONSUMES the canonical ordering rather than imposing it, so a
    // caller who sorted differently is told rather than silently re-chunked.
    if (i > 0 && payouts[i - 1].outputKeyHex >= p.outputKeyHex) {
      throw new RangeError(`payouts must be in strictly ascending outputKeyHex order (the canonical ordering computeFloorShares emits); ${p.outputKeyHex.slice(0, 12)}… is out of place`);
    }
  }
  const envelopeFor = (group) => buildTransferMetadata({ amountsCents: group.map((p) => p.cents) });
  const chunks = [];
  let current = [];
  for (const p of payouts) {
    const next = [...current, p];
    if (next.length <= MAX_PAYOUTS_PER_CHUNK && envelopeFor(next).length / 2 <= OP_RETURN_RELAY_CAP_BYTES) {
      current = next;
      continue;
    }
    if (!current.length) {
      throw new RangeError(`a single payout of ${p.cents}c does not fit the ${OP_RETURN_RELAY_CAP_BYTES}B envelope`);
    }
    chunks.push(current);
    current = [p];
  }
  if (current.length) chunks.push(current);
  return chunks.map((group) => ({
    payouts: group,
    sumCents: sum(group.map((p) => p.cents)),
    envelopeHex: envelopeFor(group),
  }));
}

// ---- the five transaction shapes ----

const DEFAULT_FEE_SATS = 12_000_000n; // 0.12 DGB ≥ Core's DD fee floor

/** The bond record, recomputed from its parameters and cross-checked if given. */
function bondFacts({ stakerKeyHex, unlockHeight, cents, leafHex, outputKeyHex }) {
  const facts = {
    stakerKeyHex,
    unlockHeight,
    cents,
    leafHex: bondLeafHex({ stakerKeyHex, unlockHeight }),
    outputKeyHex: bondOutputKey({ stakerKeyHex, unlockHeight }),
  };
  if (leafHex && leafHex !== facts.leafHex) throw new RangeError('bond record leaf does not match its staker key and unlock height');
  if (outputKeyHex && outputKeyHex !== facts.outputKeyHex) throw new RangeError('bond record output key does not match its staker key and unlock height');
  return facts;
}

/**
 * Lock: an ordinary DigiDollar transfer whose recipient is the bond output key.
 * Returns the transfer's hex plus the `bond` RECORD — persist it. `unlockHeight`
 * exists only inside the unrevealed leaf and the lock envelope cannot carry a
 * breadcrumb (Core rejects any extra envelope push, validation.cpp:1744/1769;
 * a second OP_RETURN breaks relay policy), so a seed alone cannot rediscover
 * this output. Without the record the coin needs the registry or a backup.
 */
export function buildSignedBondLockTx({ ddUtxo, feeUtxo, privKeyHex, cents, unlockHeight, stakerKeyHex, feeSats = DEFAULT_FEE_SATS, dgbChangeScriptHex }) {
  const bond = bondFacts({ stakerKeyHex, unlockHeight, cents });
  if (cents < MIN_DD_OUTPUT_CENTS) throw new RangeError(`a bond below $1.00 cannot be an output at all — got $${(Number(cents) / 100).toFixed(2)}`);
  const { hex, ddChangeCents, dgbChangeSats } = buildSignedTransferTx({
    ddUtxo,
    feeUtxo,
    privKeyHex,
    recipients: [{ outputKeyHex: bond.outputKeyHex, cents }],
    feeSats,
    dgbChangeScriptHex,
  });
  return { hex, bond, ddChangeCents, dgbChangeSats };
}

/**
 * Unlock: the codebase's first script-path spend of a novel leaf. nLockTime is
 * the bond's unlockHeight and the bond input is non-final (0xfffffffe) because
 * CLTV refuses to evaluate against a final input. The bond input signs the RAW
 * staker key — a tapscript CHECKSIG verifies the key as written in the leaf,
 * untweaked — while the fee input is an ordinary key-path spend of the tweaked
 * key. Same split as the redeem builder in txbuild.js.
 * Default recipients: the whole bond back to the staker's own DD output.
 */
export function buildSignedBondUnlockTx({ bondUtxo, feeUtxo, stakerPrivKeyHex, feePrivKeyHex, recipients, feeSats = DEFAULT_FEE_SATS, dgbChangeScriptHex }) {
  const bond = bondFacts(bondUtxo.bond);
  if (xOnlyPubKey(stakerPrivKeyHex) !== bond.stakerKeyHex) {
    throw new RangeError('the staker key in the bond leaf is not this private key — nothing else can spend the bond');
  }
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');
  const outs = recipients ?? [{ outputKeyHex: ddTokenOutputKey(bond.stakerKeyHex), cents: bond.cents }];
  const ddChangeCents = bond.cents - sum(outs.map((r) => r.cents));
  if (ddChangeCents < 0n) throw new RangeError('the bond is smaller than the amount being sent');
  let dgbChangeSats = feeUtxo.valueSats - feeSats;
  if (dgbChangeSats < 0n) throw new RangeError('fee UTXO too small for the fee');
  if (dgbChangeSats < CHANGE_FOLD_SATS) dgbChangeSats = 0n; // dust change → fee

  const inputs = [
    { txidHex: bondUtxo.txidHex, vout: bondUtxo.vout, valueSats: 0n, scriptPubKeyHex: p2trHex(bond.outputKeyHex), sequence: NON_FINAL_SEQUENCE },
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: p2trHex(ddTokenOutputKey(xOnlyPubKey(feePrivKeyHex))), sequence: 0xffffffff },
  ];
  const changeScriptHex = dgbChangeScriptHex ?? `0014${p2wpkhProgramHex(feePrivKeyHex)}`;
  const outputs = buildTransferOutputs({
    recipients: outs,
    ddChangeCents,
    changeOwnerKeyHex: bond.stakerKeyHex,
    dgbChangeSats,
    dgbChangeScriptHex: changeScriptHex,
  });

  const version = buildDDVersion('transfer');
  const locktime = bond.unlockHeight;
  const leafHash = tapLeafHash(hexToBytes(bond.leafHex));
  const witnesses = [
    [
      signSighash(taprootSighash({ version, locktime, inputs, outputs, inputIndex: 0, leafHash }), hexToBytes(stakerPrivKeyHex)),
      hexToBytes(bond.leafHex),
      hexToBytes(bondControlBlockHex(bond)),
    ],
    [signSighash(taprootSighash({ version, locktime, inputs, outputs, inputIndex: 1 }), hexToBytes(tapTweakPrivKey(feePrivKeyHex)))],
  ];
  const hex = serializeTx({ version, locktime, inputs, outputs, witnesses });
  assertBuiltDDTx({
    txHex: hex,
    what: 'bond unlock',
    expect: {
      type: 'transfer',
      ddInCents: bond.cents,
      ddOutputs: [
        ...outs.map((r) => ({ outputKeyHex: r.outputKeyHex, cents: r.cents })),
        ...(ddChangeCents > 0n ? [{ outputKeyHex: ddTokenOutputKey(bond.stakerKeyHex), cents: ddChangeCents }] : []),
      ],
      valuedOutputs: dgbChangeSats > 0n ? [{ scriptHex: changeScriptHex, valueSats: dgbChangeSats }] : [],
      locktime,
      sequences: inputs.map((i) => i.sequence),
    },
  });
  return { hex, ddChangeCents, dgbChangeSats };
}

/**
 * Escrow split: one transfer paying ONE ephemeral-key output PER CHUNK, because
 * a UTXO spends once and DD conservation is per-transaction — N chunks cannot
 * share one escrow UTXO, and chaining chunk-change would hit the
 * no-unconfirmed-DD-input rule (validation.cpp:1810-1813). Consequence: this
 * transfer carries the 8-output product cap, so the pilot's ceiling is
 * 8 chunks × 8 payouts = 64 paid stakers per epoch.
 */
export function buildSignedEscrowSplitTx({ ddUtxos, feeUtxo, operatorPrivKeyHex, ephemeralKeyHex, chunks, feeSats = DEFAULT_FEE_SATS, dgbChangeScriptHex }) {
  if (!chunks?.length) throw new RangeError('at least one chunk is required');
  if (chunks.length > MAX_CHUNKS_PER_SPLIT) {
    throw new RangeError(`an escrow split funds at most ${MAX_CHUNKS_PER_SPLIT} chunks, one escrow output each — got ${chunks.length}; the pilot ceiling is ${MAX_CHUNKS_PER_SPLIT} chunks × ${MAX_PAYOUTS_PER_CHUNK} payouts = 64 paid stakers per epoch`);
  }
  if (!ddUtxos?.length) throw new RangeError('at least one DigiDollar input is required');
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');
  assertKey(ephemeralKeyHex, 'ephemeral key');

  const escrowKeyHex = ddTokenOutputKey(ephemeralKeyHex);
  const recipients = chunks.map((c) => ({ outputKeyHex: escrowKeyHex, cents: c.sumCents }));
  const totalDDIn = sum(ddUtxos.map((u) => u.ddCents));
  const ddChangeCents = totalDDIn - sum(recipients.map((r) => r.cents));
  if (ddChangeCents < 0n) throw new RangeError('the DigiDollar inputs do not cover the chunk sums');
  let dgbChangeSats = feeUtxo.valueSats - feeSats;
  if (dgbChangeSats < 0n) throw new RangeError('fee UTXO too small for the fee');
  if (dgbChangeSats < CHANGE_FOLD_SATS) dgbChangeSats = 0n;

  const operatorKey = xOnlyPubKey(operatorPrivKeyHex);
  const operatorScriptHex = p2trHex(ddTokenOutputKey(operatorKey));
  const inputs = [
    ...ddUtxos.map((u) => ({ txidHex: u.txidHex, vout: u.vout, valueSats: 0n, scriptPubKeyHex: operatorScriptHex, sequence: 0xffffffff })),
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: operatorScriptHex, sequence: 0xffffffff },
  ];
  const changeScriptHex = dgbChangeScriptHex ?? `0014${p2wpkhProgramHex(operatorPrivKeyHex)}`;
  const outputs = buildTransferOutputs({
    recipients,
    ddChangeCents,
    changeOwnerKeyHex: operatorKey,
    dgbChangeSats,
    dgbChangeScriptHex: changeScriptHex,
  });

  const version = buildDDVersion('transfer');
  const tweakedKey = hexToBytes(tapTweakPrivKey(operatorPrivKeyHex));
  const witnesses = inputs.map((_, inputIndex) => [
    signSighash(taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex }), tweakedKey),
  ]);
  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses });
  assertBuiltDDTx({
    txHex: hex,
    what: 'escrow split',
    expect: {
      type: 'transfer',
      ddInCents: totalDDIn,
      ddOutputs: [
        ...recipients,
        ...(ddChangeCents > 0n ? [{ outputKeyHex: ddTokenOutputKey(operatorKey), cents: ddChangeCents }] : []),
      ],
      valuedOutputs: dgbChangeSats > 0n ? [{ scriptHex: changeScriptHex, valueSats: dgbChangeSats }] : [],
      locktime: 0,
      sequences: inputs.map((i) => i.sequence),
    },
  });
  return { hex, escrows: chunks.map((c, vout) => ({ vout, cents: c.sumCents })), ddChangeCents, dgbChangeSats };
}

/**
 * Distribution: ONE escrow input spent key-path with SIGHASH_ALL|ANYONECANPAY
 * (65-byte signature), sequence non-final, nLockTime = lockTimeHeight, and
 * outputs that are the chunk's payouts plus the envelope — no valued output and
 * no DD change, so the escrow's cents must equal the payout sum exactly.
 * ANYONECANPAY is what lets any staker attach a fee later; ALL is what stops
 * them touching the outputs.
 */
export function buildSignedDistributionTx({ escrowUtxo, ephemeralPrivKeyHex, chunk, lockTimeHeight }) {
  const payouts = chunk.payouts.map((p) => ({ outputKeyHex: assertKey(p.outputKeyHex, 'payout output key'), cents: p.cents }));
  if (!payouts.length) throw new RangeError('a distribution needs at least one payout');
  if (payouts.length > MAX_PAYOUTS_PER_CHUNK) throw new RangeError(`at most ${MAX_PAYOUTS_PER_CHUNK} payouts per distribution — got ${payouts.length}`);
  const payoutSum = sum(payouts.map((p) => p.cents));
  if (escrowUtxo.cents !== payoutSum) {
    throw new RangeError(`the escrow must fund the payouts exactly — ${escrowUtxo.cents}c escrowed for ${payoutSum}c of payouts (no change output can exist under ALL|ANYONECANPAY)`);
  }
  assertBlockHeight(lockTimeHeight, 'lockTimeHeight');

  const escrowKeyHex = ddTokenOutputKey(xOnlyPubKey(ephemeralPrivKeyHex));
  const inputs = [{
    txidHex: escrowUtxo.txidHex, vout: escrowUtxo.vout, valueSats: 0n,
    scriptPubKeyHex: p2trHex(escrowKeyHex), sequence: NON_FINAL_SEQUENCE,
  }];
  const outputs = buildTransferOutputs({ recipients: payouts });
  const version = buildDDVersion('transfer');
  const sighash = taprootSighash({
    version, locktime: lockTimeHeight, inputs, outputs, inputIndex: 0,
    hashType: DISTRIBUTION_HASH_TYPE,
  });
  const sig = signSighash(sighash, hexToBytes(tapTweakPrivKey(ephemeralPrivKeyHex)), DISTRIBUTION_HASH_TYPE);
  const hex = serializeTx({ version, locktime: lockTimeHeight, inputs, outputs, witnesses: [[sig]] });
  assertBuiltDDTx({
    txHex: hex,
    what: 'distribution',
    expect: {
      type: 'transfer', ddInCents: escrowUtxo.cents, ddOutputs: payouts, valuedOutputs: [],
      locktime: lockTimeHeight, sequences: [NON_FINAL_SEQUENCE],
    },
  });
  const chunkRecord = {
    v: 1,
    txHex: hex,
    escrow: { txidHex: escrowUtxo.txidHex, vout: escrowUtxo.vout, cents: escrowUtxo.cents },
    payouts,
    lockTimeHeight,
  };
  return { hex, chunkRecord };
}

/** Default ceiling on the coin a staker burns to broadcast (0.5 DGB). PROVISIONAL: #146. */
export const MAX_ATTACHED_FEE_SATS = 50_000_000n;

/**
 * Attach a fee input to a pre-signed distribution and sign it SIGHASH_DEFAULT —
 * non-ACP, so it commits to every input, which pins the escrow input the staker
 * just verified. The escrow's ALL|ANYONECANPAY signature commits sha_outputs,
 * so NO output may be added: the attached coin is spent to fee IN FULL, and the
 * bounds below are the only thing between a fat-fingered coin and a burn.
 *
 * `escrowKeyHex` is required because a non-ACP signature commits to every
 * input's scriptPubKey, and a transaction does not carry the scriptPubKeys of
 * the coins it spends. It is the same key the caller verified the chunk with.
 * `lockTimeHeight` is required for the same reason and is NOT read off the
 * record: checking a record against its own field certifies nothing. The caller
 * knows the epoch's height independently — from the registry, or from the epoch
 * they locked into.
 * The chunk is re-verified against both here: a staker must never burn a fee on
 * a chunk that does not pass.
 */
export function attachDistributionFee({ chunkRecord, escrowKeyHex, lockTimeHeight, feeUtxo, feePrivKeyHex, maxBurnSats = MAX_ATTACHED_FEE_SATS }) {
  assertKey(escrowKeyHex, 'escrow key');
  assertBlockHeight(lockTimeHeight, 'lockTimeHeight');
  if (feeUtxo.valueSats < MIN_DD_TX_FEE_SATS || feeUtxo.valueSats > maxBurnSats) {
    throw new RangeError(`the attached coin is spent in full as fee — it must be between ${MIN_DD_TX_FEE_SATS} and ${maxBurnSats} sats, got ${feeUtxo.valueSats}`);
  }
  const verdict = verifyDistributionChunk({ chunkRecord, expect: { escrowKeyHex, lockTimeHeight } });
  if (!verdict.ok) {
    throw new Error(`refusing to pay a fee for a chunk that fails verification: ${verdict.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  }

  const tx = parseTx(chunkRecord.txHex);
  const inputs = [
    ...tx.inputs.map((i) => ({
      txidHex: i.txidHex, vout: i.vout, sequence: i.sequence,
      valueSats: 0n, // the escrow is a DigiDollar token output: zero on-chain value
      scriptPubKeyHex: p2trHex(ddTokenOutputKey(escrowKeyHex)),
    })),
    {
      txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats,
      scriptPubKeyHex: p2trHex(ddTokenOutputKey(xOnlyPubKey(feePrivKeyHex))),
      sequence: NON_FINAL_SEQUENCE,
    },
  ];
  const outputs = tx.outputs.map((o) => ({ valueSats: o.valueSats, script: hexToBytes(o.scriptHex) }));
  const feeIndex = inputs.length - 1;
  const sig = signSighash(
    taprootSighash({ version: tx.version, locktime: tx.locktime, inputs, outputs, inputIndex: feeIndex, hashType: SIGHASH_DEFAULT }),
    hexToBytes(tapTweakPrivKey(feePrivKeyHex)),
  );
  const witnesses = [...tx.witnesses.map((w) => w.map(hexToBytes)), [sig]];
  const hex = serializeTx({ version: tx.version, locktime: tx.locktime, inputs, outputs, witnesses });
  assertBuiltDDTx({
    txHex: hex,
    what: 'fee-attached distribution',
    expect: {
      type: 'transfer', ddInCents: chunkRecord.escrow.cents, ddOutputs: chunkRecord.payouts,
      valuedOutputs: [], locktime: lockTimeHeight, sequences: inputs.map((i) => i.sequence),
    },
  });
  return { hex, feeSats: feeUtxo.valueSats };
}

// ---- the received-bytes verifier ----

/**
 * Re-derive everything about a chunk from its BYTES and report a named check
 * per property. Never throws on content — malformed input still returns
 * `{ ok: false }` with a failed check, because the caller is a staker deciding
 * whether to lock, or a registry deciding whether to list, and both need a list
 * they can render rather than an exception.
 *
 * `expect`: `{ escrowKeyHex, lockTimeHeight, payoutsMustInclude? }`.
 * This is the spec's "verify the escrow UTXO and your payout BEFORE locking".
 */
export function verifyDistributionChunk({ chunkRecord, expect = {} }) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
  const done = () => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checks });
  try {
    return runChunkChecks({ chunkRecord, expect, checks, add, done });
  } catch (e) {
    // Hostile or merely foreign input must fail by name, never by exception:
    // a record that came back from JSON, for instance, cannot carry BigInt
    // cents at all, and mixing those with ours throws deep inside the maths.
    add('verifier-error', false, `unexpected error while verifying: ${e.message}`);
    return done();
  }
}

function runChunkChecks({ chunkRecord, expect, checks, add, done }) {
  if (!add('record-version', chunkRecord?.v === 1, `chunk record v${chunkRecord?.v} — this verifier reads v1`)) return done();
  const { txHex, escrow, payouts, lockTimeHeight } = chunkRecord;
  if (!add('record-shape',
    typeof txHex === 'string' && !!escrow && Array.isArray(payouts) && payouts.length > 0,
    'a v1 record needs txHex, escrow and payouts')) return done();

  const core = checkBuiltDDTx({
    txHex,
    expect: {
      type: 'transfer', ddInCents: escrow.cents, ddOutputs: payouts, valuedOutputs: [],
      locktime: expect.lockTimeHeight,
    },
  });
  checks.push(...core.checks);
  if (!core.checks[0].ok) return done(); // unparseable: nothing below can run

  const tx = parseTx(txHex);
  add('input-count', tx.inputs.length === 1, `${tx.inputs.length} input(s) — a chunk record holds the escrow spend alone`);
  add('escrow-prevout',
    tx.inputs[0]?.txidHex === escrow.txidHex && tx.inputs[0]?.vout === escrow.vout,
    `spends ${tx.inputs[0]?.txidHex?.slice(0, 12)}…:${tx.inputs[0]?.vout}, record names ${escrow.txidHex?.slice(0, 12)}…:${escrow.vout}`);
  add('sequence-non-final', tx.inputs.every((i) => i.sequence < 0xffffffff),
    'a final input disables nLockTime, so the payout could be broadcast early');
  // The bytes' nLockTime is the core's `locktime` check; this one is the
  // RECORD's own claim about the height, which a publisher could set to
  // anything.
  add('record-locktime', lockTimeHeight === expect.lockTimeHeight,
    `record says ${lockTimeHeight}, expected ${expect.lockTimeHeight}`);
  add('no-valued-output', tx.outputs.every((o) => o.valueSats === 0n), 'a distribution carries no valued output');
  add('payout-count', payouts.length <= MAX_PAYOUTS_PER_CHUNK, `${payouts.length} payouts, cap ${MAX_PAYOUTS_PER_CHUNK}`);
  add('payout-sum', sum(payouts.map((p) => p.cents)) === escrow.cents,
    `payouts total ${sum(payouts.map((p) => p.cents))}c against an escrow of ${escrow.cents}c`);
  if (expect.payoutsMustInclude) {
    add('payouts-include',
      expect.payoutsMustInclude.every((want) => payouts.some((p) => p.outputKeyHex === want.outputKeyHex && (want.cents === undefined || p.cents === want.cents))),
      'the caller is not paid by this chunk');
  }

  // The signature is the whole trust boundary: once the ephemeral key is gone,
  // this 65-byte ACP signature is the only thing that can ever spend the escrow.
  const witness = tx.witnesses[0] ?? [];
  const sigHex = witness[0] ?? '';
  const wellFormed = witness.length === 1 && sigHex.length / 2 === 65 && sigHex.slice(-2) === '81';
  let verified = false;
  let detail = wellFormed ? '' : `witness is ${witness.length} item(s), ${sigHex.length / 2} bytes, trailing 0x${sigHex.slice(-2) || '??'} — want one 65-byte signature ending 0x81`;
  if (wellFormed) {
    try {
      const digest = taprootSighash({
        version: tx.version,
        locktime: tx.locktime,
        inputs: [{
          txidHex: tx.inputs[0].txidHex, vout: tx.inputs[0].vout, valueSats: 0n,
          scriptPubKeyHex: p2trHex(ddTokenOutputKey(expect.escrowKeyHex)),
          sequence: tx.inputs[0].sequence,
        }],
        outputs: tx.outputs.map((o) => ({ valueSats: o.valueSats, script: hexToBytes(o.scriptHex) })),
        inputIndex: 0,
        hashType: DISTRIBUTION_HASH_TYPE,
      });
      verified = schnorr.verify(hexToBytes(sigHex.slice(0, -2)), digest, hexToBytes(ddTokenOutputKey(expect.escrowKeyHex)));
      if (!verified) detail = 'the signature does not verify against the escrow key over these bytes';
    } catch (e) {
      detail = e.message;
    }
  }
  add('acp-signature', wellFormed && verified, detail);
  return done();
}
