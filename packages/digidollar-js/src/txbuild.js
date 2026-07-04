// DigiDollar mint transaction: full assembly + BIP-341 key-path signing.
// Output layout mirrors real Core mints (test/fixtures/mint-tx.json):
//   vout[0] collateral P2TR (NUMS + MAST)   — requiredCollateralSats
//   vout[1] DD token P2TR (owner, key-path) — 0 value
//   vout[2] OP_RETURN mint metadata          — 0 value
//   vout[3] change P2TR (owner, key-path)
// Unlock height rule observed on regtest and in consensus/digidollar.h:
//   unlockHeight = nextHeight + MINT_LOCK_CONFIRMATION_BUFFER(100) + tier.lockBlocks

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { LOCK_TIERS, requiredCollateralSats, tierById } from './index.js';
import { buildDDVersion } from './envelope.js';
import { buildMintMetadata, buildTransferMetadata } from './envelope.js';
import { collateralOutputKey, ddTokenOutputKey } from './taproot.js';

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;

export const MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100;
export const MIN_DD_TX_FEE_SATS = 10_000_000n; // 0.1 DGB (Core txbuilder.cpp)

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

const u32le = (n) => Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const u64le = (v) => {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const varint = (n) => {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, n >>> 8]);
  throw new RangeError('varint > 0xffff not needed here');
};

const p2trScript = (xOnlyHex) => concat(Uint8Array.from([0x51, 0x20]), hexToBytes(xOnlyHex)); // OP_1 <32B>

// P2WPKH change (matches Core's mint anatomy). A P2TR change output would be
// rejected: consensus requires exactly one collateral-shaped output per mint
// ("bad-mint-multiple-collateral-outputs", NUMS-bypass protection).
function p2wpkhScript(privKeyHex) {
  const compressed = secp256k1.getPublicKey(hexToBytes(privKeyHex), true);
  return concat(Uint8Array.from([0x00, 0x14]), ripemd160(sha256(compressed)));
}

/** x-only pubkey (hex) for a private key. */
export function xOnlyPubKey(privKeyHex) {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privKeyHex)));
}

/** Tweaked private key for spending a key-path-only P2TR of this key (BIP-341/386). */
function tapTweakPrivKey(privKeyHex) {
  const d0 = BigInt('0x' + privKeyHex);
  const P = Point.BASE.multiply(d0).toAffine();
  const d = (P.y & 1n) === 0n ? d0 : CURVE_N - d0; // even-Y normalization
  const px = P.x.toString(16).padStart(64, '0');
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', hexToBytes(px))));
  const dt = (d + t) % CURVE_N;
  return dt.toString(16).padStart(64, '0');
}

/** BIP-341 key-path sighash, SIGHASH_DEFAULT, no annex. Single input index. */
function taprootSighash({ version, locktime, inputs, outputs, inputIndex }) {
  const shaPrevouts = sha256(concat(...inputs.map((i) => concat(hexToBytes(i.txidHex).reverse(), u32le(i.vout)))));
  const shaAmounts = sha256(concat(...inputs.map((i) => u64le(i.valueSats))));
  const shaScriptPubKeys = sha256(concat(...inputs.map((i) => {
    const spk = hexToBytes(i.scriptPubKeyHex);
    return concat(varint(spk.length), spk);
  })));
  const shaSequences = sha256(concat(...inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concat(...outputs.map((o) => {
    const spk = o.script;
    return concat(u64le(o.valueSats), varint(spk.length), spk);
  })));
  const msg = concat(
    Uint8Array.from([0x00]),          // hash_type: SIGHASH_DEFAULT
    u32le(version), u32le(locktime),
    shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences, shaOutputs,
    Uint8Array.from([0x00]),          // spend_type: key path, no annex
    u32le(inputIndex),
  );
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg)); // epoch 0
}

export function serializeTx({ version, locktime, inputs, outputs, witnesses }) {
  const parts = [u32le(version), Uint8Array.from([0x00, 0x01])]; // segwit marker+flag
  parts.push(varint(inputs.length));
  for (const i of inputs) parts.push(hexToBytes(i.txidHex).reverse(), u32le(i.vout), varint(0), u32le(i.sequence));
  parts.push(varint(outputs.length));
  for (const o of outputs) parts.push(u64le(o.valueSats), varint(o.script.length), o.script);
  for (const w of witnesses) {
    parts.push(varint(w.length));
    for (const item of w) parts.push(varint(item.length), item);
  }
  parts.push(u32le(locktime));
  return bytesToHex(concat(...parts));
}

// ---- Transfer ----
// Output layout mirrors real Core transfers (test/fixtures/transfer-tx.json,
// TransferTxBuilder::BuildTransferTransaction):
//   recipient DD P2TR (value 0) ×N
//   DD change P2TR (value 0, tweaked sender owner key)  — only if change > 0
//   DGB change P2WPKH                                   — only if change > 0
//   OP_RETURN "DD" <2> <cents per DD output, in order>  — always LAST
// Consensus (ValidateTransferTransaction) pairs OP_RETURN amounts positionally
// with the zero-value canonical-P2TR outputs and enforces strict DD conservation.

/**
 * Build the transfer output list in Core's exact order.
 * `recipients[].outputKeyHex` is the already-tweaked P2TR output key (what a
 * DigiDollar address decodes to) — it is used verbatim, not tweaked again.
 */
export function buildTransferOutputs({
  recipients, // [{ outputKeyHex, cents: bigint }]
  ddChangeCents = 0n,
  changeOwnerKeyHex, // sender's x-only owner key; tweaked here like CreateDigiDollarP2TR
  dgbChangeSats = 0n,
  dgbChangeScriptHex,
}) {
  if (!recipients?.length) throw new RangeError('at least one recipient required');
  const amountsCents = recipients.map((r) => r.cents);
  const outputs = recipients.map((r) => ({ valueSats: 0n, script: p2trScript(r.outputKeyHex) }));
  if (ddChangeCents > 0n) {
    outputs.push({ valueSats: 0n, script: p2trScript(ddTokenOutputKey(changeOwnerKeyHex)) });
    amountsCents.push(ddChangeCents);
  }
  if (dgbChangeSats > 0n) {
    outputs.push({ valueSats: dgbChangeSats, script: hexToBytes(dgbChangeScriptHex) });
  }
  outputs.push({ valueSats: 0n, script: hexToBytes(buildTransferMetadata({ amountsCents })) });
  return outputs;
}

/**
 * Build and sign a complete DigiDollar transfer transaction, client-side.
 * Both UTXOs must be key-path-only P2TR of `privKeyHex` (the sender owner key):
 * the DD token UTXO (on-chain value 0) and a DGB UTXO that pays the fee.
 * Returns { hex, ddChangeCents, dgbChangeSats }.
 */
export function buildSignedTransferTx({
  ddUtxo, // { txidHex, vout, ddCents: bigint } — the DD token output being spent (value 0)
  feeUtxo, // { txidHex, vout, valueSats: bigint }
  privKeyHex,
  recipients, // [{ outputKeyHex, cents: bigint }]
  feeSats = 12_000_000n, // 0.12 DGB ≥ Core's DD fee floor
}) {
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');
  const sentCents = recipients.reduce((s, r) => s + r.cents, 0n);
  const ddChangeCents = ddUtxo.ddCents - sentCents;
  if (ddChangeCents < 0n) throw new RangeError('DD input smaller than the amount being sent');
  const dgbChangeSats = feeUtxo.valueSats - feeSats;
  if (dgbChangeSats < 0n) throw new RangeError('fee UTXO too small for the fee');

  const ownerKey = xOnlyPubKey(privKeyHex);
  const ownerScriptHex = bytesToHex(p2trScript(ddTokenOutputKey(ownerKey)));
  const inputs = [
    { txidHex: ddUtxo.txidHex, vout: ddUtxo.vout, valueSats: 0n, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
  ];
  const outputs = buildTransferOutputs({
    recipients,
    ddChangeCents,
    changeOwnerKeyHex: ownerKey,
    dgbChangeSats,
    dgbChangeScriptHex: bytesToHex(p2wpkhScript(privKeyHex)),
  });

  const version = buildDDVersion('transfer');
  const tweakedKey = hexToBytes(tapTweakPrivKey(privKeyHex));
  const witnesses = inputs.map((_, inputIndex) => [
    schnorr.sign(taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex }), tweakedKey),
  ]);

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses });
  return { hex, ddChangeCents, dgbChangeSats };
}

/**
 * Build and sign a complete DigiDollar mint transaction, client-side.
 * The funding UTXO must be a key-path-only P2TR of `privKeyHex` (the owner key).
 * Returns { hex, unlockHeight, collateralSats, changeSats }.
 */
export function buildSignedMintTx({
  utxo, // { txidHex, vout, valueSats: bigint }
  privKeyHex,
  ddCents,
  tierId,
  oraclePriceMicroUsd,
  dcaMultiplierBps = 10_000n,
  tipHeight,
  feeSats = 12_000_000n, // 0.12 DGB ≥ Core's DD fee floor
}) {
  const tier = tierById(tierId);
  if (!tier) throw new RangeError(`unknown lock tier: ${tierId}`);
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');

  const ownerKey = xOnlyPubKey(privKeyHex);
  const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd, dcaMultiplierBps });
  const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;

  const changeSats = utxo.valueSats - collateralSats - feeSats;
  if (changeSats < 0n) throw new RangeError('funding UTXO too small for collateral + fee');

  const fundingScript = p2trScript(ddTokenOutputKey(ownerKey)); // key-path-only P2TR of owner
  const inputs = [{ ...utxo, scriptPubKeyHex: bytesToHex(fundingScript), sequence: 0xfffffffd }];
  const outputs = [
    { valueSats: collateralSats, script: p2trScript(collateralOutputKey({ ownerKeyHex: ownerKey, lockHeight: unlockHeight, ddCents })) },
    { valueSats: 0n, script: p2trScript(ddTokenOutputKey(ownerKey)) },
    { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: ownerKey })) },
    { valueSats: changeSats, script: p2wpkhScript(privKeyHex) },
  ];

  const version = buildDDVersion('mint');
  const sighash = taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex: 0 });
  const sig = schnorr.sign(sighash, hexToBytes(tapTweakPrivKey(privKeyHex))); // 64B, SIGHASH_DEFAULT

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [[sig]] });
  return { hex, unlockHeight, collateralSats, changeSats };
}
