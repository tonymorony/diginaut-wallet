// DigiDollar mint transaction: full assembly + BIP-341 key-path signing.
// Output layout mirrors real Core mints (test/fixtures/mint-tx.json):
//   vout[0] collateral P2TR (NUMS + MAST)   — requiredCollateralSats
//   vout[1] DD token P2TR (owner, key-path) — 0 value
//   vout[2] OP_RETURN mint metadata          — 0 value
//   vout[3] change P2WPKH (owner) — omitted when the change is dust (folded
//           into the fee); consensus classifies mint outputs by shape, not index
// Unlock height rule observed on regtest and in consensus/digidollar.h:
//   unlockHeight = nextHeight + MINT_LOCK_CONFIRMATION_BUFFER(100) + tier.lockBlocks

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { LOCK_TIERS, requiredCollateralSats, tierById } from './index.js';
import { buildDDVersion } from './envelope.js';
import { buildMintMetadata, buildTransferMetadata, buildRedeemMetadata } from './envelope.js';
import { collateralOutputKey, ddTokenOutputKey, normalRedemptionLeafHex, normalRedemptionLeafHash, collateralControlBlockHex } from './taproot.js';

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;

export const MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100;
export const MIN_DD_TX_FEE_SATS = 10_000_000n; // 0.1 DGB (Core txbuilder.cpp)
// $1.00. Same value on every network (DD_TX_LIMITS.*.minOutputCents), from
// consensus/digidollar.h:73 `minOutputAmount = 100`.
export const MIN_DD_OUTPUT_CENTS = 100n;
// Change below this goes to the fee instead of becoming an output. 0.001 DGB is
// the relay-fee unit — negligible value, and guaranteed dust under any DGB dust
// policy, so an output that size gets the whole transaction rejected. Every
// builder in this file applies it: the DD ones were emitting the dust output
// that plain spends have folded since #6, which is a DigiDollar that cannot
// move rather than a spend that merely costs a little more.
const CHANGE_FOLD_SATS = 100_000n;

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

/** hash160(compressed pubkey) hex — this key's P2WPKH witness program. */
export function p2wpkhProgramHex(privKeyHex) {
  const compressed = secp256k1.getPublicKey(hexToBytes(privKeyHex), true);
  return bytesToHex(ripemd160(sha256(compressed)));
}

function p2wpkhScript(privKeyHex) {
  return concat(Uint8Array.from([0x00, 0x14]), hexToBytes(p2wpkhProgramHex(privKeyHex)));
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

/**
 * BIP-341 sighash, SIGHASH_DEFAULT, no annex. Key path by default; pass
 * `leafHash` (Uint8Array tapleaf hash) for a script-path (tapscript) spend —
 * spend_type gains ext_flag=1 and the leaf-hash extension is appended.
 */
function taprootSighash({ version, locktime, inputs, outputs, inputIndex, leafHash }) {
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
    Uint8Array.from([leafHash ? 0x02 : 0x00]), // spend_type: (ext_flag·2)+annex
    u32le(inputIndex),
    ...(leafHash
      ? [leafHash, Uint8Array.from([0x00]), u32le(0xffffffff)] // key_version, codesep pos
      : []),
  );
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg)); // epoch 0
}

/**
 * BIP-143 sighash (SIGHASH_ALL, no anyonecanpay) for a P2WPKH input. The
 * scriptCode is the implied P2PKH script of the hash160 embedded in the
 * input's witness program (scriptPubKey = 0014<hash160>).
 */
function bip143Sighash({ version, locktime, inputs, outputs, inputIndex }) {
  const hash256 = (b) => sha256(sha256(b));
  const hashPrevouts = hash256(concat(...inputs.map((i) => concat(hexToBytes(i.txidHex).reverse(), u32le(i.vout)))));
  const hashSequence = hash256(concat(...inputs.map((i) => u32le(i.sequence))));
  const hashOutputs = hash256(concat(...outputs.map((o) => concat(u64le(o.valueSats), varint(o.script.length), o.script))));
  const input = inputs[inputIndex];
  const hash160 = hexToBytes(input.scriptPubKeyHex).slice(2); // drop OP_0 <20>
  const scriptCode = concat(Uint8Array.from([0x19, 0x76, 0xa9, 0x14]), hash160, Uint8Array.from([0x88, 0xac]));
  const preimage = concat(
    u32le(version),
    hashPrevouts, hashSequence,
    hexToBytes(input.txidHex).reverse(), u32le(input.vout),
    scriptCode,
    u64le(input.valueSats),
    u32le(input.sequence),
    hashOutputs,
    u32le(locktime),
    u32le(0x01), // SIGHASH_ALL
  );
  return hash256(preimage);
}

/** Witness stack for a P2WPKH input: [lowS DER sig + 0x01, compressed pubkey]. */
function p2wpkhWitness(sighash, privKeyHex) {
  const der = secp256k1.sign(sighash, hexToBytes(privKeyHex), { prehash: false, format: 'der', lowS: true });
  return [concat(der, Uint8Array.from([0x01])), secp256k1.getPublicKey(hexToBytes(privKeyHex), true)];
}

// ---- The flexible leg (fee on transfer/redeem, funding on mint) ----
// Every DigiDollar transaction needs one plain DGB input, and that input is the
// only one consensus leaves free: the DD token legs and the collateral are
// bound to the owner key, but the DGB leg can be any coin the wallet can sign.
// Core proves both shapes in this repo's own captures — redeem-tx.json vin[3]
// and mint-tx.json vin[0] are [DER sig, compressed pubkey] P2WPKH stacks. That
// matters because mint change is P2WPKH by construction (see the header), so a
// builder that took only key-path P2TR here could not spend what it had just
// created.

/** scriptPubKey (hex) of the DGB leg: witness-v0 when tagged, else key-path P2TR. */
function dgbLegScriptHex(utxo, privKeyHex) {
  return utxo.type === 'p2wpkh'
    ? bytesToHex(p2wpkhScript(privKeyHex))
    : bytesToHex(p2trScript(ddTokenOutputKey(xOnlyPubKey(privKeyHex))));
}

/** Witness stack for the DGB leg: BIP-143 ECDSA for v0, BIP-341 schnorr for P2TR. */
function signDgbLeg({ utxo, privKeyHex, version, locktime, inputs, outputs, inputIndex }) {
  if (utxo.type === 'p2wpkh') {
    return p2wpkhWitness(bip143Sighash({ version, locktime, inputs, outputs, inputIndex }), privKeyHex);
  }
  return [schnorr.sign(
    taprootSighash({ version, locktime, inputs, outputs, inputIndex }),
    hexToBytes(tapTweakPrivKey(privKeyHex)),
  )];
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
  // Consensus checks EVERY canonical-P2TR output of a transfer against the $1
  // minimum, not just the ones the sender thinks of as payments — the loop at
  // digidollar/validation.cpp:1743 rejects with "transfer-dd-amount-below-minimum".
  // The DD CHANGE output is one of those, and it was the one nobody validated:
  // spend $10.00 from a $10.50 coin and the 50c change makes the whole transfer
  // unbroadcastable. Checked here, where the outputs and the OP_RETURN amounts
  // are built together, so no DD output can reach the signer unvalidated.
  for (const c of amountsCents) {
    if (c < MIN_DD_OUTPUT_CENTS) {
      throw new RangeError(`consensus forbids DigiDollar outputs below $1.00 — this transfer would create one of $${(Number(c) / 100).toFixed(2)}`);
    }
  }
  if (dgbChangeSats > 0n) {
    outputs.push({ valueSats: dgbChangeSats, script: hexToBytes(dgbChangeScriptHex) });
  }
  outputs.push({ valueSats: 0n, script: hexToBytes(buildTransferMetadata({ amountsCents })) });
  return outputs;
}

/**
 * Build and sign a complete DigiDollar transfer transaction, client-side.
 * The DD token UTXO (on-chain value 0) must be a key-path-only P2TR of
 * `privKeyHex` (the sender owner key) — consensus binds the DD leg to it. The
 * DGB UTXO that pays the fee only has to belong to the same wallet: pass
 * `feePrivKeyHex` when it sits on another of the wallet's keys, and
 * `feeUtxo.type: 'p2wpkh'` when it is a witness-v0 coin (the shape mint change
 * lands in), which is then signed per BIP-143. Core itself pays DigiDollar fees
 * from v0 coins — test/fixtures/redeem-tx.json vin[3] is a [DER, pubkey] stack.
 * DGB change below CHANGE_FOLD_SATS is folded into the fee rather than emitted
 * as a dust output that would get the whole transfer rejected.
 * Returns { hex, ddChangeCents, dgbChangeSats } — dgbChangeSats is 0n when folded.
 */
export function buildSignedTransferTx({
  ddUtxo, // { txidHex, vout, ddCents: bigint } — the DD token output being spent (value 0)
  feeUtxo, // { txidHex, vout, valueSats: bigint, type?: 'p2tr'|'p2wpkh' }
  privKeyHex,
  feePrivKeyHex = privKeyHex, // fee coin's own key; defaults to the single-key anatomy
  recipients, // [{ outputKeyHex, cents: bigint }]
  feeSats = 12_000_000n, // 0.12 DGB ≥ Core's DD fee floor
  dgbChangeScriptHex, // optional: route DGB change here (default: Core's P2WPKH convention)
}) {
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');
  const sentCents = recipients.reduce((s, r) => s + r.cents, 0n);
  const ddChangeCents = ddUtxo.ddCents - sentCents;
  if (ddChangeCents < 0n) throw new RangeError('DD input smaller than the amount being sent');
  let dgbChangeSats = feeUtxo.valueSats - feeSats;
  if (dgbChangeSats < 0n) throw new RangeError('fee UTXO too small for the fee');
  if (dgbChangeSats < CHANGE_FOLD_SATS) dgbChangeSats = 0n; // dust change → fee

  const ownerKey = xOnlyPubKey(privKeyHex);
  const ownerScriptHex = bytesToHex(p2trScript(ddTokenOutputKey(ownerKey)));
  const feeScriptHex = dgbLegScriptHex(feeUtxo, feePrivKeyHex);
  const inputs = [
    { txidHex: ddUtxo.txidHex, vout: ddUtxo.vout, valueSats: 0n, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: feeScriptHex, sequence: 0xffffffff },
  ];
  const FEE_INPUT_INDEX = 1; // transfer anatomy: DD token leg, then the fee leg
  const outputs = buildTransferOutputs({
    recipients,
    ddChangeCents,
    changeOwnerKeyHex: ownerKey,
    dgbChangeSats,
    // Default unchanged on purpose: the DGB change keeps going to the SENDER's
    // P2WPKH, not the fee key's. Both in-repo callers pass this explicitly, and
    // a fee coin borrowed from another key must not silently redirect change.
    dgbChangeScriptHex: dgbChangeScriptHex ?? bytesToHex(p2wpkhScript(privKeyHex)),
  });

  const version = buildDDVersion('transfer');
  const tweakedKey = hexToBytes(tapTweakPrivKey(privKeyHex));
  const witnesses = inputs.map((_, inputIndex) => {
    if (inputIndex === FEE_INPUT_INDEX) {
      return signDgbLeg({ utxo: feeUtxo, privKeyHex: feePrivKeyHex, version, locktime: 0, inputs, outputs, inputIndex });
    }
    return [schnorr.sign(taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex }), tweakedKey)];
  });

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses });
  return { hex, ddChangeCents, dgbChangeSats };
}

// ---- Redeem ----
// Anatomy mirrors real Core redemptions (test/fixtures/redeem-tx.json,
// RedeemTxBuilder::BuildRedemptionTransaction):
//   vin[0]  collateral P2TR — SCRIPT-PATH spend of the Normal leaf,
//           witness [sig64, leafScript, controlBlock], sequence 0xfffffffe (CLTV)
//   vin[1+] DD token UTXOs to burn — key-path, sequence 0xfffffffe
//   vin[N]  DGB fee UTXO — key-path P2TR or P2WPKH, any wallet key,
//           sequence 0xffffffff (the fixture's own vin[3] is P2WPKH)
//   vout[0] full collateral back to the owner
//   vout[…] DD change P2TR + OP_RETURN "DD" <3> <change> — only if change > 0
//   vout[…] DGB fee change — last
//   nLockTime = lockHeight (consensus: height >= nLockTime, strict DD burn)

/** Build the redeem output list in Core's exact order. */
export function buildRedeemOutputs({
  collateralReturnSats,
  collateralReturnScriptHex,
  ddChangeCents = 0n,
  changeOwnerKeyHex, // owner x-only key for DD change (tweaked like CreateDigiDollarP2TR)
  dgbChangeSats = 0n,
  dgbChangeScriptHex,
}) {
  const outputs = [{ valueSats: collateralReturnSats, script: hexToBytes(collateralReturnScriptHex) }];
  // No MIN_DD_OUTPUT_CENTS check here, deliberately, and it is not an oversight.
  // The redemption path does NOT call ValidateOutputAmount on its DD change: the
  // scan at digidollar/validation.cpp:2107-2149 only enforces "at most one DD
  // change output" and the per-output serialization bound. So Core ACCEPTS a
  // sub-$1 redeem change, and refusing to build one would strand the position —
  // a full redemption is all-or-nothing, so a user whose burn set cannot avoid
  // 50c of change would have no in-wallet operation left that frees the
  // collateral. The resulting token is awkward (a later TRANSFER of it would be
  // rejected, per buildTransferOutputs above) but it is spendable in a burn set.
  if (ddChangeCents > 0n) {
    outputs.push({ valueSats: 0n, script: p2trScript(ddTokenOutputKey(changeOwnerKeyHex)) });
    outputs.push({ valueSats: 0n, script: hexToBytes(buildRedeemMetadata({ ddChangeCents })) });
  }
  if (dgbChangeSats > 0n) {
    outputs.push({ valueSats: dgbChangeSats, script: hexToBytes(dgbChangeScriptHex) });
  }
  return outputs;
}

/**
 * Build and sign a complete DigiDollar redemption, client-side (Normal path).
 * The collateral is spent via the Normal tapscript leaf (expired CLTV + owner
 * signature — no oracle signatures involved); the DD UTXOs must be key-path-only
 * P2TR of `privKeyHex`. The fee UTXO is the flexible leg: `feePrivKeyHex` for a
 * coin on another wallet key, `feeUtxo.type: 'p2wpkh'` for a witness-v0 coin.
 * The full collateral value returns to the owner's key-path P2TR. DGB change
 * below CHANGE_FOLD_SATS is folded into the fee.
 * Returns { hex, ddChangeCents, dgbChangeSats } — 0n when folded.
 */
export function buildSignedRedeemTx({
  collateralUtxo, // { txidHex, vout, valueSats, lockHeight, ddCents } — the mint's vout[0]
  ddUtxos, // [{ txidHex, vout, ddCents }] — burned; must sum to ≥ collateralUtxo.ddCents
  feeUtxo, // { txidHex, vout, valueSats, type?: 'p2tr'|'p2wpkh' }
  privKeyHex,
  feePrivKeyHex = privKeyHex, // fee coin's own key; defaults to the single-key anatomy
  feeSats = 16_000_000n, // 0.16 DGB ≥ Core's DD fee floor
  dgbChangeScriptHex, // optional: route DGB change here (default: Core's P2WPKH convention)
}) {
  if (feeSats < MIN_DD_TX_FEE_SATS) throw new RangeError('fee below the DigiDollar fee floor (0.1 DGB)');
  const totalDDIn = ddUtxos.reduce((s, u) => s + u.ddCents, 0n);
  const ddChangeCents = totalDDIn - collateralUtxo.ddCents;
  if (ddChangeCents < 0n) throw new RangeError('DD inputs must cover the full minted amount (full redemption only)');
  let dgbChangeSats = feeUtxo.valueSats - feeSats;
  if (dgbChangeSats < 0n) throw new RangeError('fee UTXO too small for the fee');
  // Folding here can leave the redeem with no DGB change output at all. That is
  // safe: Core's redemption check wants *some* output with nValue > 0
  // ("bad-redeem-no-dgb-output", digidollar/validation.cpp:2154) and the
  // collateral return at vout[0] is one.
  if (dgbChangeSats < CHANGE_FOLD_SATS) dgbChangeSats = 0n;

  const ownerKey = xOnlyPubKey(privKeyHex);
  const leafParams ={ ownerKeyHex: ownerKey, lockHeight: collateralUtxo.lockHeight, ddCents: collateralUtxo.ddCents };
  const collateralScriptHex = bytesToHex(p2trScript(collateralOutputKey(leafParams)));
  const ownerScriptHex = bytesToHex(p2trScript(ddTokenOutputKey(ownerKey)));

  const inputs = [
    { txidHex: collateralUtxo.txidHex, vout: collateralUtxo.vout, valueSats: collateralUtxo.valueSats, scriptPubKeyHex: collateralScriptHex, sequence: 0xfffffffe },
    ...ddUtxos.map((u) => ({ txidHex: u.txidHex, vout: u.vout, valueSats: 0n, scriptPubKeyHex: ownerScriptHex, sequence: 0xfffffffe })),
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: dgbLegScriptHex(feeUtxo, feePrivKeyHex), sequence: 0xffffffff },
  ];
  // Bookkept, not inferred: the fee leg follows the collateral and every burn
  // leg. Signing it as "the last input" would silently mis-sign the day this
  // anatomy grows a trailing input, and a mis-signed leg is an unspendable
  // position. The check costs nothing and can only fire on a build-order bug.
  const feeInputIndex = 1 + ddUtxos.length;
  const feeInput = inputs[feeInputIndex];
  if (feeInput?.txidHex !== feeUtxo.txidHex || feeInput.vout !== feeUtxo.vout) {
    throw new RangeError('redeem input order does not put the fee coin where the signer expects it');
  }
  const outputs = buildRedeemOutputs({
    collateralReturnSats: collateralUtxo.valueSats,
    collateralReturnScriptHex: ownerScriptHex,
    ddChangeCents,
    changeOwnerKeyHex: ownerKey,
    dgbChangeSats,
    dgbChangeScriptHex: dgbChangeScriptHex ?? bytesToHex(p2wpkhScript(privKeyHex)),
  });

  const version = buildDDVersion('redeem');
  const locktime = collateralUtxo.lockHeight;
  const leafHash = normalRedemptionLeafHash(leafParams);
  const rawKey = hexToBytes(privKeyHex); // leaf CHECKSIG verifies the UNTWEAKED owner key
  const tweakedKey = hexToBytes(tapTweakPrivKey(privKeyHex));

  const witnesses = inputs.map((_, inputIndex) => {
    if (inputIndex === 0) {
      const sighash = taprootSighash({ version, locktime, inputs, outputs, inputIndex, leafHash });
      return [
        schnorr.sign(sighash, rawKey),
        hexToBytes(normalRedemptionLeafHex(leafParams)),
        hexToBytes(collateralControlBlockHex(leafParams)),
      ];
    }
    if (inputIndex === feeInputIndex) {
      return signDgbLeg({ utxo: feeUtxo, privKeyHex: feePrivKeyHex, version, locktime, inputs, outputs, inputIndex });
    }
    return [schnorr.sign(taprootSighash({ version, locktime, inputs, outputs, inputIndex }), tweakedKey)];
  });

  const hex = serializeTx({ version, locktime, inputs, outputs, witnesses });
  return { hex, ddChangeCents, dgbChangeSats };
}

// ---- Standard DGB spend (issue #6) ----
// Not a DigiDollar transaction: plain version-2 segwit, key-path P2TR inputs,
// standard relay fee (no 0.1 DGB DD floor — that applies to DD txs only).

export const STANDARD_FEE_RATE_SATS_PER_KVB = 100_000n; // DGB default relay fee 0.001 DGB/kvB

// BIP-141 weights for a key-path P2TR spend, in weight units (see spend.test.js).
const TX_OVERHEAD_WU = 42n; // version+counts+locktime (10 vB ·4) + segwit marker/flag (2 wu),
                            // taking both count varints as one byte — see below
// The input-count varint is one byte only up to 252; at 253 serializeTx writes
// the 3-byte form (varint(), line 41). Those 2 bytes are non-witness, so they
// cost 8 wu = 2 vB = 200 sats at the default relay rate — enough to put a
// consolidation or a send-max under the min-relay fee and have it rejected.
// The OUTPUT count is not modelled: both planners emit at most two outputs, so
// its varint is provably one byte and a term for it could never be exercised.
const inputCountExtraWu = (nIn) => (nIn < 0xfd ? 0n : 8n);
const P2TR_INPUT_WU = 230n; // outpoint+len+sequence (41 vB ·4) + witness [64B sig] (66 wu)
// p2wpkh: 164 wu non-witness + witness ≤ 1 count + (1+72) sig (max lowS DER 71
// + hashtype) + (1+33) pubkey = 108 wu. Budget the maximum — a 71-byte sig is
// a coin flip, and an under-paid fee is rejected by the relay policy.
const P2WPKH_INPUT_WU = 272n;
const P2TR_OUTPUT_WU = 172n; // 8 value + 1 len + 34 script, ·4
const inputWeight = (u) => (u.type === 'p2wpkh' ? P2WPKH_INPUT_WU : P2TR_INPUT_WU);
// Weight of a tx output from its scriptPubKey: (8 value + 1 script-len + script)·4.
// Script-len fits one byte for every standard output (≤34 B). Legacy P2PKH (25 B)
// and P2SH (23 B) outputs are smaller than the 34-byte P2TR/P2WSH witness program.
const outputWeight = (scriptHex) => (9n + BigInt(scriptHex.length / 2)) * 4n;

/**
 * Coin selection + fee plan for a standard 2-output (recipient + change) spend.
 * Largest-first: fewest inputs, fewest signatures. UTXOs are key-path P2TR by
 * default; `type: 'p2wpkh'` marks a witness-v0 coin (mint change). Returns
 * { inputs, feeSats, changeSats } where `inputs` are the UTXO objects verbatim.
 */
export function planSpend({ utxos, amountSats, feeRateSatsPerKvB = STANDARD_FEE_RATE_SATS_PER_KVB, recipientScriptHex }) {
  const sorted = [...utxos].sort((a, b) => (a.valueSats < b.valueSats ? 1 : -1));
  const inputs = [];
  let total = 0n;
  let inputsWu = 0n;
  // Recipient output weight from its actual script (legacy P2PKH/P2SH is smaller
  // than P2TR); change is always the wallet's key-path P2TR receive address.
  const recipientOutputWu = recipientScriptHex ? outputWeight(recipientScriptHex) : P2TR_OUTPUT_WU;
  for (const u of sorted) {
    inputs.push(u);
    total += u.valueSats;
    inputsWu += inputWeight(u);
    // inputs.length is the count for the tx being priced: `u` was pushed above.
    const weight = TX_OVERHEAD_WU + inputCountExtraWu(inputs.length) + inputsWu + recipientOutputWu + P2TR_OUTPUT_WU;
    // Core rounds weight→vsize FIRST (GetVirtualTransactionSize = ceil(weight/4)),
    // then prices per vbyte — rounding at the end under-pays by up to 75 sats/kvB.
    const vsize = (weight + 3n) / 4n;
    const feeSats = (vsize * feeRateSatsPerKvB + 999n) / 1000n; // ceil
    const changeSats = total - amountSats - feeSats;
    if (changeSats >= 0n) return { inputs, feeSats, changeSats };
  }
  throw new RangeError('insufficient funds for amount + fee');
}

/**
 * Fee plan for a MAX ("send everything") spend: every provided UTXO becomes an
 * input and the whole balance minus the fee goes to a single recipient output —
 * no change. Callers MUST pre-filter to genuinely spendable coins (confirmed,
 * non-DD-token). Returns { inputs, feeSats, amountSats } with
 * amountSats = Σ(inputs) − feeSats, so buildSignedSpendTx produces zero change.
 *
 * The fee is priced for a one-output tx (no change output weight), which is why
 * this can't go through planSpend — that always budgets a change output and
 * would report "insufficient funds" for a wallet-draining amount.
 * Throws if the inputs can't even cover the fee.
 */
export function planMaxSpend({ utxos, feeRateSatsPerKvB = STANDARD_FEE_RATE_SATS_PER_KVB, recipientScriptHex }) {
  if (!utxos.length) throw new RangeError('no spendable coins');
  const inputs = [...utxos];
  const total = inputs.reduce((s, u) => s + u.valueSats, 0n);
  const inputsWu = inputs.reduce((s, u) => s + inputWeight(u), 0n);
  // Single recipient output, no change (see planSpend for the weight model).
  const recipientOutputWu = recipientScriptHex ? outputWeight(recipientScriptHex) : P2TR_OUTPUT_WU;
  const weight = TX_OVERHEAD_WU + inputCountExtraWu(inputs.length) + inputsWu + recipientOutputWu;
  const vsize = (weight + 3n) / 4n; // ceil(weight/4), Core's GetVirtualTransactionSize
  const feeSats = (vsize * feeRateSatsPerKvB + 999n) / 1000n; // ceil, per-vbyte
  const amountSats = total - feeSats;
  if (amountSats <= 0n) throw new RangeError('balance does not cover the network fee');
  return { inputs, feeSats, amountSats };
}

/**
 * Build and sign a standard (non-DD) DGB spend, client-side. Every UTXO carries
 * its own private key (wallet UTXOs span derivation indices) and is a key-path-
 * only P2TR unless marked `type: 'p2wpkh'` — the shape consensus forces on mint
 * change — which is signed per BIP-143 (ECDSA, SIGHASH_ALL). Change below
 * 0.001 DGB (the relay-fee unit — negligible value, guaranteed dust under any
 * DGB dust policy) is folded into the fee instead of creating an output.
 * Returns { hex, changeSats } — the change output's actual value, 0n when folded.
 */
export function buildSignedSpendTx({
  utxos, // [{ txidHex, vout, valueSats: bigint, privKeyHex, type?: 'p2tr'|'p2wpkh' }]
  recipientScriptHex,
  amountSats,
  changeScriptHex,
  feeSats,
}) {
  const total = utxos.reduce((s, u) => s + u.valueSats, 0n);
  let changeSats = total - amountSats - feeSats;
  if (changeSats < 0n) throw new RangeError('inputs do not cover amount + fee');
  if (changeSats < CHANGE_FOLD_SATS) changeSats = 0n; // fold near-dust change into the fee

  const inputs = utxos.map((u) => ({
    txidHex: u.txidHex,
    vout: u.vout,
    valueSats: u.valueSats,
    scriptPubKeyHex: bytesToHex(u.type === 'p2wpkh'
      ? p2wpkhScript(u.privKeyHex)
      : p2trScript(ddTokenOutputKey(xOnlyPubKey(u.privKeyHex)))),
    sequence: 0xfffffffd,
  }));
  const outputs = [{ valueSats: amountSats, script: hexToBytes(recipientScriptHex) }];
  if (changeSats > 0n) outputs.push({ valueSats: changeSats, script: hexToBytes(changeScriptHex) });

  const version = 2; // plain spend: no DD envelope in the version field
  const witnesses = utxos.map((u, inputIndex) => {
    if (u.type === 'p2wpkh') {
      return p2wpkhWitness(bip143Sighash({ version, locktime: 0, inputs, outputs, inputIndex }), u.privKeyHex);
    }
    return [
      schnorr.sign(
        taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex }),
        hexToBytes(tapTweakPrivKey(u.privKeyHex)),
      ),
    ];
  });
  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses });
  return { hex, changeSats };
}

/**
 * Build and sign a complete DigiDollar mint transaction, client-side.
 * The funding UTXO belongs to `privKeyHex` (which also owns the position): a
 * key-path-only P2TR by default, or the key's witness-v0 coin with
 * `utxo.type: 'p2wpkh'` — the shape this very builder emits as change, and the
 * shape Core funds its own mints from (test/fixtures/mint-tx.json vin[0]).
 * Returns { hex, unlockHeight, collateralSats, changeSats }.
 */
export function buildSignedMintTx({
  utxo, // { txidHex, vout, valueSats: bigint, type?: 'p2tr'|'p2wpkh' }
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

  let changeSats = utxo.valueSats - collateralSats - feeSats;
  if (changeSats < 0n) throw new RangeError('funding UTXO too small for collateral + fee');
  // Dust change → fee, and then no change output at all. Before this, exact
  // funding emitted a ZERO-value P2WPKH output, which is non-standard on its
  // own. Consensus classifies mint outputs by shape, not by index (the scan in
  // ValidateMintTransaction), so dropping vout[3] does not disturb the layout.
  if (changeSats < CHANGE_FOLD_SATS) changeSats = 0n;

  // Key-path-only P2TR of the owner, or the owner's P2WPKH when the coin is
  // tagged: the mint sighash commits to this script, so the funding shape and
  // the signing path have to be chosen together.
  const fundingScriptHex = dgbLegScriptHex(utxo, privKeyHex);
  const inputs = [{ ...utxo, scriptPubKeyHex: fundingScriptHex, sequence: 0xfffffffd }];
  const outputs = [
    { valueSats: collateralSats, script: p2trScript(collateralOutputKey({ ownerKeyHex: ownerKey, lockHeight: unlockHeight, ddCents })) },
    { valueSats: 0n, script: p2trScript(ddTokenOutputKey(ownerKey)) },
    { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: ownerKey })) },
  ];
  if (changeSats > 0n) outputs.push({ valueSats: changeSats, script: p2wpkhScript(privKeyHex) });

  const version = buildDDVersion('mint');
  // 64B schnorr, SIGHASH_DEFAULT — or [DER, pubkey] when the funding coin is v0
  const witness = signDgbLeg({ utxo, privKeyHex, version, locktime: 0, inputs, outputs, inputIndex: 0 });

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [witness] });
  return { hex, unlockHeight, collateralSats, changeSats };
}
