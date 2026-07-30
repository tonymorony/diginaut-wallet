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
import { buildDDVersion, parseDDVersion } from './envelope.js';
import { buildMintMetadata, buildTransferMetadata, buildRedeemMetadata, parseMintMetadata, parseTransferMetadata, parseRedeemMetadata } from './envelope.js';
import { collateralOutputKey, ddTokenOutputKey, normalRedemptionLeafHex, normalRedemptionLeafHash, collateralControlBlockHex } from './taproot.js';

const { taggedHash } = schnorr.utils;
const Point = secp256k1.Point;
const CURVE_N = Point.CURVE().n;

export const MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100;
export const MIN_DD_TX_FEE_SATS = 10_000_000n; // 0.1 DGB (Core txbuilder.cpp)
// $1.00. Same value on every network (DD_TX_LIMITS.*.minOutputCents), from
// consensus/digidollar.h:73 `minOutputAmount = 100`.
export const MIN_DD_OUTPUT_CENTS = 100n;
// $100,000.00. The upper bound on a single DigiDollar output: consensus rejects
// a transfer carrying more with "transfer-dd-amount-exceeds-maximum"
// (digidollar/validation.cpp:1761). Same value on every network.
export const MAX_DD_OUTPUT_CENTS = 10_000_000n;
// Change below this goes to the fee instead of becoming an output. 0.001 DGB is
// the relay-fee unit — negligible value, and guaranteed dust under any DGB dust
// policy, so an output that size gets the whole transaction rejected. Every
// builder in this file applies it: the DD ones were emitting the dust output
// that plain spends have folded since #6, which is a DigiDollar that cannot
// move rather than a spend that merely costs a little more.
export const CHANGE_FOLD_SATS = 100_000n;

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

/**
 * Tweaked private key for spending a key-path-only P2TR of this key
 * (BIP-341/386). Package-internal, like `taprootSighash` and `signSighash`:
 * bond.js signs its key-path inputs with it, index.js does not re-export it.
 */
export function tapTweakPrivKey(privKeyHex) {
  const d0 = BigInt('0x' + privKeyHex);
  const P = Point.BASE.multiply(d0).toAffine();
  const d = (P.y & 1n) === 0n ? d0 : CURVE_N - d0; // even-Y normalization
  const px = P.x.toString(16).padStart(64, '0');
  const t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', hexToBytes(px))));
  const dt = (d + t) % CURVE_N;
  return dt.toString(16).padStart(64, '0');
}

// Hash types this library will sign. SIGHASH_NONE and SIGHASH_SINGLE (and their
// ANYONECANPAY forms) are refused, not unimplemented: NONE commits to no output
// at all, and SINGLE|ANYONECANPAY leaks change to whoever completes the
// transaction (docs/discovery/dd-defi-yield.md). A product that needs one gets
// its own design pass first. 0x01 is here because the upstream BIP-341 vectors
// exercise the explicit-byte path; the builders use only 0x00 and 0x81.
export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;
export const SIGHASH_ANYONECANPAY = 0x80;

function assertSupportedHashType(hashType) {
  if (hashType === SIGHASH_DEFAULT || hashType === SIGHASH_ALL || hashType === (SIGHASH_ALL | SIGHASH_ANYONECANPAY)) return;
  const base = hashType & 0x03;
  if (base === 0x03) throw new RangeError(`refusing SIGHASH_SINGLE (hash type 0x${hashType.toString(16)}): it leaves the other outputs unsigned`);
  if (base === 0x02) throw new RangeError(`refusing SIGHASH_NONE (hash type 0x${hashType.toString(16)}): it signs no outputs at all`);
  throw new RangeError(`unsupported sighash hash type 0x${hashType.toString(16)} — only 0x00, 0x01 and 0x81 are signed here`);
}

/**
 * BIP-341 sighash (no annex). Key path by default; pass `leafHash` (Uint8Array
 * tapleaf hash) for a script-path spend — spend_type gains ext_flag=1 and the
 * leaf-hash extension is appended.
 *
 * `hashType` follows BIP-341 exactly: with SIGHASH_ANYONECANPAY (the 0x80 bit)
 * the four whole-transaction input digests are omitted and THIS input's
 * outpoint, amount, scriptPubKey and nSequence are embedded after spend_type
 * instead — which is what lets a third party append their own fee input to an
 * already-signed transaction without invalidating the signature.
 *
 * Module-level export for the test suite (pinned digests + the upstream BIP-341
 * vectors); deliberately NOT re-exported from index.js. Producing a DigiDollar-
 * marked signature is meant to require going through one of the audited
 * builders and its post-build gate, not around them.
 */
export function taprootSighash({ version, locktime, inputs, outputs, inputIndex, leafHash, hashType = SIGHASH_DEFAULT }) {
  assertSupportedHashType(hashType);
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const input = inputs[inputIndex];
  const scriptPubKeyField = (i) => {
    const spk = hexToBytes(i.scriptPubKeyHex);
    return concat(varint(spk.length), spk);
  };
  const outpoint = (i) => concat(hexToBytes(i.txidHex).reverse(), u32le(i.vout));
  const shaOutputs = sha256(concat(...outputs.map((o) => concat(u64le(o.valueSats), varint(o.script.length), o.script))));
  const msg = concat(
    Uint8Array.from([hashType]),
    u32le(version), u32le(locktime),
    ...(anyoneCanPay ? [] : [
      sha256(concat(...inputs.map(outpoint))),                        // sha_prevouts
      sha256(concat(...inputs.map((i) => u64le(i.valueSats)))),       // sha_amounts
      sha256(concat(...inputs.map(scriptPubKeyField))),               // sha_scriptpubkeys
      sha256(concat(...inputs.map((i) => u32le(i.sequence)))),        // sha_sequences
    ]),
    shaOutputs, // always: only ALL/DEFAULT reach here
    Uint8Array.from([leafHash ? 0x02 : 0x00]), // spend_type: (ext_flag·2)+annex
    ...(anyoneCanPay
      ? [outpoint(input), u64le(input.valueSats), scriptPubKeyField(input), u32le(input.sequence)]
      : [u32le(inputIndex)]),
    ...(leafHash
      ? [leafHash, Uint8Array.from([0x00]), u32le(0xffffffff)] // key_version, codesep pos
      : []),
  );
  return taggedHash('TapSighash', concat(Uint8Array.from([0x00]), msg)); // epoch 0
}

/**
 * Schnorr signature for a taproot input: 64 bytes for SIGHASH_DEFAULT, and
 * 65 (sig ‖ hash type) for every explicit hash type — BIP-341's rule, and the
 * reason a distribution witness is 65 bytes with 0x81 as its last byte.
 *
 * Package-internal, like `taprootSighash`: bond.js signs the Lock & Earn shapes
 * with it, and index.js does not re-export it.
 */
export function signSighash(sighash, keyBytes, hashType = SIGHASH_DEFAULT) {
  assertSupportedHashType(hashType);
  const sig = schnorr.sign(sighash, keyBytes);
  return hashType === SIGHASH_DEFAULT ? sig : concat(sig, Uint8Array.from([hashType]));
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

/**
 * Inverse of `serializeTx`: bytes → `{ version, locktime, inputs, outputs,
 * witnesses }` with `inputs: [{ txidHex, vout, scriptSigHex, sequence }]`,
 * `outputs: [{ valueSats: bigint, scriptHex }]` and `witnesses: string[][]`
 * (hex, one array per input, empty for a legacy/unsigned transaction).
 *
 * Both layouts are accepted: BIP-144 segwit (00 01 marker+flag) and legacy.
 * Per BIP-144 a 0x00 where the input count belongs IS the marker — a legacy
 * transaction with zero inputs is unrepresentable, which is what makes the
 * layouts distinguishable. Truncation, trailing bytes and any flag byte other
 * than 0x01 are refused: this parses transactions received from strangers
 * (verifyDistributionChunk) as well as our own, so "mostly parsed" is not a
 * safe outcome. A non-empty scriptSig is exposed rather than rejected.
 */
export function parseTx(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/i.test(hex) || hex.length === 0) {
    throw new RangeError('transaction must be a non-empty even-length hex string');
  }
  const buf = hexToBytes(hex.toLowerCase());
  let o = 0;
  const take = (n) => {
    if (o + n > buf.length) throw new RangeError(`transaction truncated: ran out of bytes at offset ${o}`);
    const v = buf.subarray(o, o + n);
    o += n;
    return v;
  };
  const u32 = () => { const b = take(4); return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0); };
  const u64 = () => take(8).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
  // CompactSize, with Core's canonicality rule (ReadCompactSize: "non-canonical
  // ReadCompactSize()"). A value encoded in more bytes than it needs is refused,
  // because otherwise two different byte strings — with two different txids —
  // both claim to be the same transaction.
  const varint = () => {
    const first = take(1)[0];
    if (first < 0xfd) return first;
    const nonCanonical = (value, floor) => {
      if (value < floor) throw new RangeError(`non-canonical CompactSize: ${value} encoded in the 0x${first.toString(16)} form`);
      return value;
    };
    if (first === 0xfd) { const b = take(2); return nonCanonical(b[0] | (b[1] << 8), 0xfd); }
    if (first === 0xfe) return nonCanonical(u32(), 0x10000);
    const v = u64();
    if (v < 0x100000000n) throw new RangeError(`non-canonical CompactSize: ${v} encoded in the 0xff form`);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('varint beyond the safe integer range');
    return Number(v);
  };
  const takeHex = (n) => bytesToHex(take(n));

  const version = u32();
  let segwit = false;
  if (buf[o] === 0x00) {
    segwit = true;
    o += 1;
    const flag = take(1)[0];
    if (flag !== 0x01) throw new RangeError(`unknown segwit flag byte 0x${flag.toString(16).padStart(2, '0')}`);
  }
  const inputs = Array.from({ length: varint() }, () => ({
    // subarray is a view into buf — copy before reversing, or the parse eats itself.
    txidHex: bytesToHex(Uint8Array.from(take(32)).reverse()),
    vout: u32(),
    scriptSigHex: takeHex(varint()),
    sequence: u32(),
  }));
  const outputs = Array.from({ length: varint() }, () => ({
    valueSats: u64(),
    scriptHex: takeHex(varint()),
  }));
  const witnesses = inputs.map(() => (segwit
    ? Array.from({ length: varint() }, () => takeHex(varint()))
    : []));
  const locktime = u32();
  if (o !== buf.length) throw new RangeError(`trailing bytes after the transaction (${buf.length - o})`);
  return { version, locktime, inputs, outputs, witnesses };
}

// ---- The verify-before-sign gate ----
// One core, two users. Every buildSigned* in the DigiDollar family ends by
// running its OWN serialized bytes back through this and throwing if any check
// fails, so a serialization or envelope bug cannot ship a signature; and
// bond.js's verifyDistributionChunk runs the same core over bytes it RECEIVED
// from someone else, returning the check list instead of throwing.
// Because the gate reads the final bytes, it sees what the network will see.
// Check names are stable: the wallet renders them and the suite asserts on them.

// OP_RETURN relay cap (Core policy.h:74) — no DigiDollar exemption.
export const OP_RETURN_RELAY_CAP_BYTES = 83;

const isCanonicalP2TR = (scriptHex) => /^5120[0-9a-f]{64}$/.test(scriptHex);
const isOpReturn = (scriptHex) => scriptHex.startsWith('6a');
const centsList = (outs) => outs.map((o) => o.cents);

/**
 * Re-derive a DigiDollar transaction's meaning from its serialized bytes and
 * compare it to the intent it was built from. Never throws on content — broken
 * hex yields `{ ok: false }` with a failed `parse` check.
 *
 * `expect` carries the INTENT, not the bytes: `{ type, ddOutputs:
 * [{outputKeyHex, cents}], ddInCents, ddBurnedCents?, mint?, valuedOutputs? }`.
 * The envelope is rebuilt from the amounts parsed out of the transaction and
 * byte-compared to the OP_RETURN that is actually there, so a reordered,
 * duplicated or non-minimally-encoded amount fails even though the builder's
 * own inputs were fine.
 */
export function checkBuiltDDTx({ txHex, expect }) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
  const done = () => ({ ok: checks.length > 0 && checks.every((c) => c.ok), checks });
  try {
    return runDDChecks({ txHex, expect, add, done });
  } catch (e) {
    // The never-throws contract holds even for input nothing here anticipated
    // (a transaction with no outputs at all, a JSON-decoded record whose cents
    // came back as Numbers). Failing by name beats failing by exception in a
    // caller that is rendering a checklist.
    add('verifier-error', false, `unexpected error while checking: ${e.message}`);
    return done();
  }
}

function runDDChecks({ txHex, expect, add, done }) {
  let tx;
  try {
    tx = parseTx(txHex);
  } catch (e) {
    add('parse', false, e.message);
    return done();
  }
  add('parse', true, `${tx.inputs.length} in, ${tx.outputs.length} out`);

  // Every DigiDollar shape is pure-witness, and a native witness program
  // REQUIRES an empty scriptSig (BIP-141) — but no signature commits to
  // scriptSig, so bytes with one injected still carry valid signatures while
  // having a different txid from the ones that were verified.
  const withScriptSig = tx.inputs.filter((i) => i.scriptSigHex !== '');
  add('scriptsig-empty', withScriptSig.length === 0,
    `${withScriptSig.length} input(s) carry a scriptSig; no signature commits to it, so the txid is not what was verified`);

  const { isDigiDollar, type } = parseDDVersion(tx.version);
  add('dd-marker', isDigiDollar && type === expect.type,
    isDigiDollar ? `nVersion type ${type}, expected ${expect.type}` : `nVersion ${tx.version} carries no DigiDollar marker`);

  const envelopeOutputs = tx.outputs.filter((o) => isOpReturn(o.scriptHex));
  const ddOutputs = tx.outputs.filter((o) => o.valueSats === 0n && isCanonicalP2TR(o.scriptHex));
  const valuedOutputs = tx.outputs.filter((o) => o.valueSats > 0n);
  const unclassified = tx.outputs.length - envelopeOutputs.length - ddOutputs.length - valuedOutputs.length;
  add('output-shapes', unclassified === 0, `${unclassified} output(s) are neither DD, envelope nor valued`);

  // Core pairs the envelope with the zero-value canonical-P2TR outputs and
  // wants exactly one OP_RETURN (validation.cpp:1744/1769; one-OP_RETURN is
  // also relay policy). A redeem carries one only when it has DD change.
  // Position: LAST on a transfer (Core's TransferTxBuilder, and every Lock &
  // Earn shape) — but a mint puts its P2WPKH change after the OP_RETURN and a
  // redeem puts its DGB change there, so the rule is transfer-only.
  const wantsEnvelope = expect.type !== 'redeem' || ddOutputs.length > 0;
  const envelopeLast = expect.type !== 'transfer' || isOpReturn(tx.outputs[tx.outputs.length - 1]?.scriptHex ?? '');
  const envelopeOk = envelopeOutputs.length === (wantsEnvelope ? 1 : 0) && (!wantsEnvelope || envelopeLast);
  add('envelope-present', envelopeOk,
    `${envelopeOutputs.length} OP_RETURN output(s), expected ${wantsEnvelope ? 1 : 0}${expect.type === 'transfer' ? ' (last)' : ''}${envelopeLast ? '' : ' — not the last output'}`);
  if (!envelopeOk) return done();

  const envelopeHex = wantsEnvelope ? envelopeOutputs[0].scriptHex : null;
  let amountsCents = [];
  let rebuiltHex = null;
  try {
    if (expect.type === 'transfer') {
      amountsCents = parseTransferMetadata(envelopeHex).amountsCents;
      rebuiltHex = buildTransferMetadata({ amountsCents });
      add('envelope-pairing', amountsCents.length === ddOutputs.length,
        `${amountsCents.length} amount(s) for ${ddOutputs.length} DD output(s)`);
    } else if (expect.type === 'redeem') {
      if (wantsEnvelope) {
        const { ddChangeCents } = parseRedeemMetadata(envelopeHex);
        amountsCents = [ddChangeCents];
        rebuiltHex = buildRedeemMetadata({ ddChangeCents });
      }
      add('envelope-pairing', ddOutputs.length === amountsCents.length,
        `${amountsCents.length} change amount(s) for ${ddOutputs.length} DD output(s)`);
    } else {
      const mint = parseMintMetadata(envelopeHex);
      amountsCents = [mint.ddCents];
      rebuiltHex = buildMintMetadata(mint);
      // The mint's own outputs must agree with its envelope: the collateral
      // P2TR is derivable from (ownerKey, unlockHeight, ddCents) and the DD
      // token output from the owner key alone (Core scripts.cpp).
      const collateralHex = `5120${collateralOutputKey({ ownerKeyHex: mint.ownerKeyHex, lockHeight: mint.unlockHeight, ddCents: mint.ddCents })}`;
      const tokenHex = `5120${ddTokenOutputKey(mint.ownerKeyHex)}`;
      add('envelope-pairing',
        tx.outputs[0]?.scriptHex === collateralHex && tx.outputs[1]?.scriptHex === tokenHex && ddOutputs.length === 1,
        'collateral and DD token outputs must match the envelope owner key');
    }
  } catch (e) {
    add('envelope-pairing', false, e.message);
    return done();
  }

  add('envelope-exact', rebuiltHex === envelopeHex,
    rebuiltHex === envelopeHex ? '' : `envelope ${envelopeHex} is not the canonical encoding ${rebuiltHex}`);
  const envelopeBytes = wantsEnvelope ? envelopeHex.length / 2 : 0;
  add('envelope-size', envelopeBytes <= OP_RETURN_RELAY_CAP_BYTES,
    `${envelopeBytes}B of the ${OP_RETURN_RELAY_CAP_BYTES}B OP_RETURN relay cap`);

  // Consensus rejects any DD output below $1.00 (validation.cpp:1756-1758) or
  // above $100,000.00 (1761). The one documented exception is redeem change,
  // which Core's redemption scan (2107-2149) amount-checks against NEITHER
  // bound — refusing it here would strand a position (see buildRedeemOutputs).
  const below = amountsCents.filter((c) => c < MIN_DD_OUTPUT_CENTS);
  add('dd-minimum', below.length === 0 || expect.type === 'redeem',
    below.length === 0 ? '' : `${below.length} DD amount(s) below $1.00${expect.type === 'redeem' ? ' — allowed on the redeem path' : ''}`);
  const above = amountsCents.filter((c) => c > MAX_DD_OUTPUT_CENTS);
  add('dd-maximum', above.length === 0 || expect.type === 'redeem',
    above.length === 0 ? '' : `${above.length} DD amount(s) above $100,000.00${expect.type === 'redeem' ? ' — allowed on the redeem path' : ''}`);

  const ddOutCents = amountsCents.reduce((s, c) => s + c, 0n);
  if (expect.type === 'mint') {
    add('dd-conservation', ddOutCents === expect.ddOutCents, `minting ${ddOutCents}c, expected ${expect.ddOutCents}c`);
  } else if (expect.type === 'redeem') {
    const burned = expect.ddInCents - ddOutCents;
    add('dd-conservation', burned === expect.ddBurnedCents, `burning ${burned}c, expected ${expect.ddBurnedCents}c`);
  } else {
    add('dd-conservation', ddOutCents === expect.ddInCents, `${ddOutCents}c out of ${expect.ddInCents}c in`);
  }

  const seen = ddOutputs.map((o, i) => ({ outputKeyHex: o.scriptHex.slice(4), cents: amountsCents[i] }));
  const wanted = expect.ddOutputs ?? [];
  add('dd-outputs-match',
    seen.length === wanted.length && seen.every((o, i) => o.outputKeyHex === wanted[i].outputKeyHex && o.cents === wanted[i].cents),
    `DD outputs ${JSON.stringify(centsList(seen).map(String))} vs requested ${JSON.stringify(centsList(wanted).map(String))}`);

  if (expect.valuedOutputs) {
    add('valued-outputs-match',
      valuedOutputs.length === expect.valuedOutputs.length
        && valuedOutputs.every((o, i) => o.scriptHex === expect.valuedOutputs[i].scriptHex && o.valueSats === expect.valuedOutputs[i].valueSats),
      `${valuedOutputs.length} valued output(s), expected ${expect.valuedOutputs.length}`);
  }

  // nLockTime and the sequences are the timing half of a template, and nothing
  // else in this list would notice them being edited: a CLTV bond whose
  // nLockTime is zeroed, or a distribution whose input is finalized, still has
  // the right outputs and the right envelope.
  if (expect.locktime !== undefined) {
    add('locktime', tx.locktime === expect.locktime, `nLockTime ${tx.locktime}, expected ${expect.locktime}`);
  }
  if (expect.sequences) {
    const seen = tx.inputs.map((i) => i.sequence);
    add('input-sequences',
      seen.length === expect.sequences.length && seen.every((s, i) => s === expect.sequences[i]),
      `sequences [${seen.map((s) => s.toString(16)).join(', ')}], expected [${expect.sequences.map((s) => s.toString(16)).join(', ')}]`);
  }
  return done();
}

/** The gate itself: run the core over the built bytes, throw if anything failed. */
export function assertBuiltDDTx({ txHex, expect, what }) {
  const { ok, checks } = checkBuiltDDTx({ txHex, expect });
  if (ok) return checks;
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  throw new Error(`${what} failed its post-build check: ${failed.join('; ')}`);
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
  // Consensus checks EVERY canonical-P2TR output of a transfer against both
  // amount bounds, not just the ones the sender thinks of as payments — the loop
  // at digidollar/validation.cpp:1756-1758 rejects with
  // "transfer-dd-amount-below-minimum" and 1761 with
  // "transfer-dd-amount-exceeds-maximum". (1743 is the IsCanonicalP2TROutput
  // branch that selects which outputs get checked, not the rejection itself.)
  // The DD CHANGE output is one of those, and it was the one nobody validated:
  // spend $10.00 from a $10.50 coin and the 50c change makes the whole transfer
  // unbroadcastable. Checked here, where the outputs and the OP_RETURN amounts
  // are built together, so no DD output can reach the signer unvalidated.
  for (const c of amountsCents) {
    if (c < MIN_DD_OUTPUT_CENTS) {
      throw new RangeError(`consensus forbids DigiDollar outputs below $1.00 — this transfer would create one of $${(Number(c) / 100).toFixed(2)}`);
    }
    if (c > MAX_DD_OUTPUT_CENTS) {
      throw new RangeError(`consensus forbids DigiDollar outputs above $100,000.00 — this transfer would create one of $${(Number(c) / 100).toFixed(2)}`);
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
 * Both UTXOs must be key-path-only P2TR of `privKeyHex` (the sender owner key):
 * the DD token UTXO (on-chain value 0) and a DGB UTXO that pays the fee.
 * DGB change below CHANGE_FOLD_SATS is folded into the fee rather than emitted
 * as a dust output that would get the whole transfer rejected.
 * Returns { hex, ddChangeCents, dgbChangeSats } — dgbChangeSats is 0n when folded.
 */
export function buildSignedTransferTx({
  ddUtxo, // { txidHex, vout, ddCents: bigint } — the DD token output being spent (value 0)
  feeUtxo, // { txidHex, vout, valueSats: bigint }
  privKeyHex,
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
  const changeScriptHex = dgbChangeScriptHex ?? bytesToHex(p2wpkhScript(privKeyHex));
  const inputs = [
    { txidHex: ddUtxo.txidHex, vout: ddUtxo.vout, valueSats: 0n, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
  ];
  const outputs = buildTransferOutputs({
    recipients,
    ddChangeCents,
    changeOwnerKeyHex: ownerKey,
    dgbChangeSats,
    dgbChangeScriptHex: changeScriptHex,
  });

  const version = buildDDVersion('transfer');
  const tweakedKey = hexToBytes(tapTweakPrivKey(privKeyHex));
  const witnesses = inputs.map((_, inputIndex) => [
    schnorr.sign(taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex }), tweakedKey),
  ]);

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses });
  assertBuiltDDTx({
    txHex: hex,
    what: 'transfer',
    expect: {
      type: 'transfer',
      ddInCents: ddUtxo.ddCents,
      ddOutputs: [
        ...recipients.map((r) => ({ outputKeyHex: r.outputKeyHex, cents: r.cents })),
        ...(ddChangeCents > 0n ? [{ outputKeyHex: ddTokenOutputKey(ownerKey), cents: ddChangeCents }] : []),
      ],
      valuedOutputs: dgbChangeSats > 0n ? [{ scriptHex: changeScriptHex, valueSats: dgbChangeSats }] : [],
      locktime: 0,
      sequences: inputs.map((i) => i.sequence),
    },
  });
  return { hex, ddChangeCents, dgbChangeSats };
}

// ---- Redeem ----
// Anatomy mirrors real Core redemptions (test/fixtures/redeem-tx.json,
// RedeemTxBuilder::BuildRedemptionTransaction):
//   vin[0]  collateral P2TR — SCRIPT-PATH spend of the Normal leaf,
//           witness [sig64, leafScript, controlBlock], sequence 0xfffffffe (CLTV)
//   vin[1+] DD token UTXOs to burn — key-path, sequence 0xfffffffe
//   vin[N]  DGB fee UTXO — key-path, sequence 0xffffffff
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
 * signature — no oracle signatures involved); DD UTXOs and the fee UTXO must
 * be key-path-only P2TR of `privKeyHex`. The full collateral value returns to
 * the owner's key-path P2TR. DGB change below CHANGE_FOLD_SATS is folded into
 * the fee. Returns { hex, ddChangeCents, dgbChangeSats } — 0n when folded.
 */
export function buildSignedRedeemTx({
  collateralUtxo, // { txidHex, vout, valueSats, lockHeight, ddCents } — the mint's vout[0]
  ddUtxos, // [{ txidHex, vout, ddCents }] — burned; must sum to ≥ collateralUtxo.ddCents
  feeUtxo, // { txidHex, vout, valueSats }
  privKeyHex,
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
    { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats, scriptPubKeyHex: ownerScriptHex, sequence: 0xffffffff },
  ];
  const changeScriptHex = dgbChangeScriptHex ?? bytesToHex(p2wpkhScript(privKeyHex));
  const outputs = buildRedeemOutputs({
    collateralReturnSats: collateralUtxo.valueSats,
    collateralReturnScriptHex: ownerScriptHex,
    ddChangeCents,
    changeOwnerKeyHex: ownerKey,
    dgbChangeSats,
    dgbChangeScriptHex: changeScriptHex,
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
    return [schnorr.sign(taprootSighash({ version, locktime, inputs, outputs, inputIndex }), tweakedKey)];
  });

  const hex = serializeTx({ version, locktime, inputs, outputs, witnesses });
  assertBuiltDDTx({
    txHex: hex,
    what: 'redemption',
    expect: {
      type: 'redeem',
      ddInCents: totalDDIn,
      ddBurnedCents: collateralUtxo.ddCents,
      ddOutputs: ddChangeCents > 0n ? [{ outputKeyHex: ddTokenOutputKey(ownerKey), cents: ddChangeCents }] : [],
      valuedOutputs: [
        { scriptHex: ownerScriptHex, valueSats: collateralUtxo.valueSats },
        ...(dgbChangeSats > 0n ? [{ scriptHex: changeScriptHex, valueSats: dgbChangeSats }] : []),
      ],
      locktime,
      sequences: inputs.map((i) => i.sequence),
    },
  });
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

  let changeSats = utxo.valueSats - collateralSats - feeSats;
  if (changeSats < 0n) throw new RangeError('funding UTXO too small for collateral + fee');
  // Dust change → fee, and then no change output at all. Before this, exact
  // funding emitted a ZERO-value P2WPKH output, which is non-standard on its
  // own. Consensus classifies mint outputs by shape, not by index (the scan in
  // ValidateMintTransaction), so dropping vout[3] does not disturb the layout.
  if (changeSats < CHANGE_FOLD_SATS) changeSats = 0n;

  const fundingScript = p2trScript(ddTokenOutputKey(ownerKey)); // key-path-only P2TR of owner
  const inputs = [{ ...utxo, scriptPubKeyHex: bytesToHex(fundingScript), sequence: 0xfffffffd }];
  const collateralScriptHex = bytesToHex(p2trScript(collateralOutputKey({ ownerKeyHex: ownerKey, lockHeight: unlockHeight, ddCents })));
  const outputs = [
    { valueSats: collateralSats, script: hexToBytes(collateralScriptHex) },
    { valueSats: 0n, script: p2trScript(ddTokenOutputKey(ownerKey)) },
    { valueSats: 0n, script: hexToBytes(buildMintMetadata({ ddCents, unlockHeight, lockTier: LOCK_TIERS.indexOf(tier), ownerKeyHex: ownerKey })) },
  ];
  if (changeSats > 0n) outputs.push({ valueSats: changeSats, script: p2wpkhScript(privKeyHex) });

  const version = buildDDVersion('mint');
  const sighash = taprootSighash({ version, locktime: 0, inputs, outputs, inputIndex: 0 });
  const sig = schnorr.sign(sighash, hexToBytes(tapTweakPrivKey(privKeyHex))); // 64B, SIGHASH_DEFAULT

  const hex = serializeTx({ version, locktime: 0, inputs, outputs, witnesses: [[sig]] });
  assertBuiltDDTx({
    txHex: hex,
    what: 'mint',
    expect: {
      type: 'mint',
      ddOutCents: ddCents,
      ddOutputs: [{ outputKeyHex: ddTokenOutputKey(ownerKey), cents: ddCents }],
      valuedOutputs: [
        { scriptHex: collateralScriptHex, valueSats: collateralSats },
        ...(changeSats > 0n ? [{ scriptHex: bytesToHex(p2wpkhScript(privKeyHex)), valueSats: changeSats }] : []),
      ],
      locktime: 0,
      sequences: inputs.map((i) => i.sequence),
    },
  });
  return { hex, unlockHeight, collateralSats, changeSats };
}
