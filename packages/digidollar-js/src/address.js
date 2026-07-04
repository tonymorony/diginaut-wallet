// Bech32 / Bech32m segwit addresses (BIP-173 / BIP-350).
// DigiByte uses hrp "dgb" (mainnet), "dgbt" (testnet), "dgbrt" (regtest);
// witness v0 → bech32, witness v1+ → bech32m.

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
