// Bech32 / Bech32m segwit addresses (BIP-173 / BIP-350).
// DigiByte uses hrp "dgb" (mainnet), "dgbt" (testnet), "dgbrt" (regtest);
// witness v0 → bech32, witness v1+ → bech32m.
//
// This module also encodes/decodes the DigiDollar base58check address form
// ("DD…"/"TD…"/"RD…"), Core's CDigiDollarAddress (src/base58.cpp). A DD address
// and a witness-v1 dgb1p… address are two encodings of the SAME 32-byte taproot
// output key → the SAME scriptPubKey. Core/Android senddigidollar accept ONLY
// the base58check form (ValidateDigiDollarAddressForCurrentNetwork checks the
// 2-char prefix), so Diginaut must display it and accept both on send.

import { sha256 } from '@noble/hashes/sha2.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const b of data) {
    acc = (acc << from) | b;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new RangeError('invalid padding in bech32 data');
  }
  return out;
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Encode a segwit address: witness v0 → bech32, v1+ → bech32m. */
export function encodeWitnessAddress(hrp, version, programHex) {
  if (version < 0 || version > 16) throw new RangeError('witness version out of range');
  const program = hexToBytes(programHex);
  if (program.length < 2 || program.length > 40) throw new RangeError('program length out of range');
  const data = [version, ...convertBits(program, 8, 5, true)];
  const spec = version === 0 ? BECH32_CONST : BECH32M_CONST;
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ spec;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}

/** scriptPubKey (hex) for a segwit output: OP_n <program>. */
function witnessScriptHex(version, programHex) {
  const opN = version === 0 ? 0x00 : 0x50 + version;
  const program = hexToBytes(programHex);
  return bytesToHex(Uint8Array.from([opN, program.length, ...program]));
}

/**
 * scriptPubKey (hex) paying to ANY DigiByte address — segwit (bech32/bech32m)
 * or legacy base58check P2PKH/P2SH. Throws on a malformed address.
 */
export function scriptPubKeyFromAddress(addr) {
  return decodeAddress(addr).scriptPubKeyHex;
}

/** Decode a segwit address → { hrp, version, programHex }. Throws on bad checksum. */
export function decodeWitnessAddress(addr) {
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) throw new RangeError('mixed-case address');
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) throw new RangeError('malformed bech32 string');
  const hrp = lower.slice(0, sep);
  const data = [...lower.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new RangeError('invalid bech32 character');
  const version = data[0];
  const spec = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (polymod([...hrpExpand(hrp), ...data]) !== spec) throw new RangeError('bad bech32 checksum');
  const program = Uint8Array.from(convertBits(data.slice(1, -6), 5, 8, false));
  if (program.length < 2 || program.length > 40) throw new RangeError('program length out of range');
  return { hrp, version, programHex: bytesToHex(program) };
}

// ── DigiDollar base58check address ("DD…"/"TD…"/"RD…") ──────────────────────
// Core CDigiDollarAddress (src/base58.cpp): base58check of
//   [2-byte version][32-byte x-only taproot output key]
// with a 4-byte double-SHA256 checksum. The 2-byte version is chosen so the
// base58 string always begins with the network's two-letter prefix.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// version bytes → { network, bech32 hrp }. Same networks as HD_NETWORKS.
const DD_NETWORKS = Object.freeze({
  mainnet: Object.freeze({ version: [0x52, 0x85], hrp: 'dgb' }), // "DD"
  testnet: Object.freeze({ version: [0xb1, 0x29], hrp: 'dgbt' }), // "TD"
  regtest: Object.freeze({ version: [0xa3, 0xa4], hrp: 'dgbrt' }), // "RD"
});

const sha256d = (bytes) => sha256(sha256(bytes));

function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = B58_ALPHABET[0].repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

function base58Decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const val = B58_ALPHABET.indexOf(ch);
    if (val === -1) throw new RangeError('invalid base58 character');
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  let zeros = 0;
  for (const ch of str) { if (ch === B58_ALPHABET[0]) zeros++; else break; }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

function base58CheckEncode(payload) {
  const checksum = sha256d(payload).slice(0, 4);
  return base58Encode(Uint8Array.from([...payload, ...checksum]));
}

function base58CheckDecode(str) {
  const full = base58Decode(str);
  if (full.length < 4) throw new RangeError('base58check string too short');
  const payload = full.slice(0, -4);
  const checksum = full.slice(-4);
  const expected = sha256d(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) throw new RangeError('bad base58check checksum');
  return payload;
}

/**
 * Encode a 32-byte taproot output key as a DigiDollar base58check address.
 * @param {string} outputKeyHex 32-byte x-only key (same bytes as the dgb1p… program)
 * @param {'mainnet'|'testnet'|'regtest'} network
 * @returns {string} "DD…"/"TD…"/"RD…"
 */
export function encodeDDAddress(outputKeyHex, network) {
  const net = DD_NETWORKS[network];
  if (!net) throw new RangeError(`unknown network: ${network}`);
  if (!/^[0-9a-fA-F]{64}$/.test(outputKeyHex)) throw new RangeError('output key must be 32-byte hex');
  const payload = Uint8Array.from([...net.version, ...hexToBytes(outputKeyHex.toLowerCase())]);
  return base58CheckEncode(payload);
}

/**
 * Decode a DigiDollar destination in EITHER encoding — the base58check
 * "DD…"/"TD…"/"RD…" form or the witness-v1 bech32m dgb1p…/dgbt1p…/dgbrt1p… form —
 * to a common { outputKeyHex, network }. Both encode the identical scriptPubKey,
 * so callers can build the transfer output from outputKeyHex regardless of form.
 * Rejects any whitespace (Core DD-FA-FUNC-019: DecodeBase58 silently strips it).
 * @returns {{ outputKeyHex: string, network: 'mainnet'|'testnet'|'regtest' }}
 */
export function decodeDDAddress(addr) {
  if (typeof addr !== 'string') throw new RangeError('address must be a string');
  if (/\s/.test(addr)) throw new RangeError('DigiDollar address must not contain whitespace');

  // bech32m witness-v1 form (dgb1p… / dgbt1p… / dgbrt1p…)
  const lower = addr.toLowerCase();
  const bech = Object.entries(DD_NETWORKS).find(([, n]) => lower.startsWith(n.hrp + '1'));
  if (bech) {
    const [network, net] = bech;
    const { hrp, version, programHex } = decodeWitnessAddress(addr);
    if (hrp !== net.hrp) throw new RangeError('address network prefix mismatch');
    if (version !== 1) throw new RangeError('DigiDollar address must be a taproot (witness v1) output');
    if (programHex.length !== 64) throw new RangeError('DigiDollar taproot program must be 32 bytes');
    return { outputKeyHex: programHex, network };
  }

  // base58check DD form
  const payload = base58CheckDecode(addr);
  if (payload.length !== 34) throw new RangeError('DigiDollar address payload must be 34 bytes');
  const entry = Object.entries(DD_NETWORKS).find(
    ([, n]) => n.version[0] === payload[0] && n.version[1] === payload[1],
  );
  if (!entry) throw new RangeError('unrecognized DigiDollar version bytes');
  return { outputKeyHex: bytesToHex(payload.slice(2)), network: entry[0] };
}

/** Re-encode any DigiDollar destination to its base58check DD form (for display/interop). */
export function toDDAddress(addr) {
  const { outputKeyHex, network } = decodeDDAddress(addr);
  return encodeDDAddress(outputKeyHex, network);
}

// ── Legacy base58check payment addresses (P2PKH / P2SH) ─────────────────────
// Version bytes verified against Core kernel/chainparams.cpp base58Prefixes:
//   mainnet  PUBKEY_ADDRESS=30 (D…), SCRIPT_ADDRESS=63 (S…),
//            SCRIPT_ADDRESS_OLD=5 (legacy 3…, still valid)   [L230-232]
//   testnet  PUBKEY_ADDRESS=126, SCRIPT_ADDRESS=140          [L569-570]
//   regtest  PUBKEY_ADDRESS=126, SCRIPT_ADDRESS=140          [L1220-1221]
// Note: testnet and regtest share the SAME base58 version bytes — a legacy
// address cannot distinguish them (unlike bech32 dgbt/dgbrt or DD TD/RD).
const LEGACY_VERSIONS = Object.freeze({
  30: { type: 'p2pkh', networks: ['mainnet'] },
  63: { type: 'p2sh', networks: ['mainnet'] },
  5: { type: 'p2sh', networks: ['mainnet'] },
  126: { type: 'p2pkh', networks: ['testnet', 'regtest'] },
  140: { type: 'p2sh', networks: ['testnet', 'regtest'] },
});

const legacyScriptHex = (type, hash160Hex) => {
  const h = hexToBytes(hash160Hex);
  if (h.length !== 20) throw new RangeError('hash160 must be 20 bytes');
  return type === 'p2pkh'
    ? bytesToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac])) // OP_DUP OP_HASH160 <h> OP_EQUALVERIFY OP_CHECKSIG
    : bytesToHex(Uint8Array.from([0xa9, 0x14, ...h, 0x87])); // OP_HASH160 <h> OP_EQUAL
};

/**
 * Decode a legacy DigiByte base58check address → { type, networks, hash160Hex }.
 * `type` is 'p2pkh' | 'p2sh'; `networks` lists every network the version byte is
 * valid on. Rejects whitespace (base58 decode silently strips it) and bad checksums.
 */
export function decodeLegacyAddress(addr) {
  if (typeof addr !== 'string') throw new RangeError('address must be a string');
  if (/\s/.test(addr)) throw new RangeError('address must not contain whitespace');
  const payload = base58CheckDecode(addr);
  if (payload.length !== 21) throw new RangeError('legacy address payload must be 21 bytes (1 version + 20 hash)');
  const info = LEGACY_VERSIONS[payload[0]];
  if (!info) throw new RangeError('unrecognized address version byte');
  return { type: info.type, networks: info.networks, hash160Hex: bytesToHex(payload.slice(1)) };
}

// hrp → network for DigiByte witness addresses.
const WITNESS_HRP = Object.freeze({ dgb: 'mainnet', dgbt: 'testnet', dgbrt: 'regtest' });

const witnessType = (version, programHex) => {
  const bytes = programHex.length / 2;
  if (version === 0 && bytes === 20) return 'p2wpkh';
  if (version === 0 && bytes === 32) return 'p2wsh';
  if (version === 1 && bytes === 32) return 'p2tr';
  return `witness_v${version}`;
};

/**
 * Decode ANY DigiByte payment address — segwit bech32/bech32m OR legacy
 * base58check P2PKH/P2SH — to a normalized descriptor for validation + building:
 *   { kind:'witness'|'legacy', type, networks:string[], scriptPubKeyHex }
 * `networks` is the set of DigiByte networks the address is valid on (empty for a
 * well-formed segwit address under a non-DigiByte hrp, e.g. bc). Throws a single
 * friendly error when the string is neither a valid segwit nor base58 address.
 */
export function decodeAddress(addr) {
  if (typeof addr !== 'string') throw new RangeError('address must be a string');
  if (/\s/.test(addr)) throw new RangeError('address must not contain whitespace');
  // Segwit first (bech32 / bech32m).
  try {
    const { hrp, version, programHex } = decodeWitnessAddress(addr);
    return {
      kind: 'witness',
      type: witnessType(version, programHex),
      networks: WITNESS_HRP[hrp] ? [WITNESS_HRP[hrp]] : [],
      scriptPubKeyHex: witnessScriptHex(version, programHex),
    };
  } catch { /* not segwit — try legacy */ }
  // Legacy base58check P2PKH / P2SH.
  try {
    const { type, networks, hash160Hex } = decodeLegacyAddress(addr);
    return { kind: 'legacy', type, networks, scriptPubKeyHex: legacyScriptHex(type, hash160Hex) };
  } catch { /* neither */ }
  throw new RangeError('not a valid DigiByte address (bech32, bech32m, or base58)');
}
