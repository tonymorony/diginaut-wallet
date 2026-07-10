// BIP21 `digibyte:` payment URIs — encode on receive, parse on send.
//
// Wire-format parity target is the Android wallet's DigiByteUri (issue #71):
//   digibytewallet-android/core/.../model/DigiByteUri.kt
// so a QR produced here round-trips to/from the mobile app. That file's shape:
//   parse:  trim → reject `scheme://` URIs that aren't `digibyte:` (digiid://,
//           http://) → bare address passes through unchanged → else the part
//           before `?` is the address and `amount|label|message` come from the
//           query (url-decoded). `amount` is DGB (decimal) → satoshis.
//   encode: `digibyte:<addr>` + optional `?amount=<dgb>&label=<url-encoded>`.
//           Android emits `amount` and `label` only (never `message`).
//
// Deliberate divergence from Android on the amount SERIALIZATION: Kotlin builds
// it as `sats.toDouble() / 100_000_000` and stringifies the Double, which yields
// "10.0" for whole DGB and scientific notation ("1.0E-8") for a single satoshi.
// We emit a canonical trailing-zero-stripped decimal ("10", "0.00000001")
// instead — cleaner, lossless, and Android's `toDoubleOrNull()` parses it back
// identically, so QR interop holds (AC: "scans correctly in the Android app").
// Money is BigInt satoshis throughout, per the digidollar-js convention.

const SATS_PER_DGB = 100_000_000n;
const SCHEME = 'digibyte:';

/**
 * Canonical DGB decimal for a satoshi amount: "1.5", "10", "0.00000001", "0".
 * Exact (BigInt) and grouping-free — unlike a `toLocaleString` render, its output
 * round-trips back through a plain `^\d+(\.\d{1,8})?$` parser (no thousands commas).
 */
export function satsToDgbString(sats) {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / SATS_PER_DGB;
  const frac = abs % SATS_PER_DGB;
  let out = whole.toString();
  if (frac > 0n) out += '.' + frac.toString().padStart(8, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + out;
}

/**
 * Decimal DGB string → BigInt satoshis, or null when unparseable.
 * The strict path keeps 8-decimal amounts exact (no float); the fallback tolerates
 * whatever Kotlin's Double.toString produced on the other side ("10.0", "1.0E-8").
 */
function dgbStringToSats(text) {
  const s = String(text).trim();
  const m = s.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (m) return BigInt(m[1]) * SATS_PER_DGB + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n * 1e8));
}

/**
 * Build a `digibyte:` payment URI. `address` is emitted verbatim (callers own
 * network validation); amount/label/message are optional.
 * @param {object} p
 * @param {string} p.address
 * @param {bigint|null} [p.amountSats]
 * @param {string|null} [p.label]
 * @param {string|null} [p.message]
 */
export function encodeBip21({ address, amountSats = null, label = null, message = null }) {
  if (!address) throw new Error('encodeBip21: address is required');
  const params = [];
  if (amountSats != null) params.push('amount=' + satsToDgbString(BigInt(amountSats)));
  if (label) params.push('label=' + encodeURIComponent(label));
  if (message) params.push('message=' + encodeURIComponent(message));
  return SCHEME + address + (params.length ? '?' + params.join('&') : '');
}

/**
 * Parse a pasted/scanned string. Returns `{ address, amountSats, label, message }`
 * (amountSats is BigInt|null; label/message are string|null), or `null` for blank
 * input or a non-`digibyte:` URI scheme. A bare address passes straight through —
 * network validation is the caller's job, exactly as on the Android side.
 */
export function parseBip21(input) {
  const cleaned = String(input ?? '').trim();
  if (!cleaned) return null;

  // Reject other schemes (digiid://, http://) but let bare addresses through.
  if (cleaned.includes('://') && !cleaned.toLowerCase().startsWith(SCHEME)) return null;

  if (!cleaned.toLowerCase().startsWith(SCHEME)) {
    return { address: cleaned, amountSats: null, label: null, message: null };
  }

  const rest = cleaned.slice(SCHEME.length);
  const qIdx = rest.indexOf('?');
  const address = (qIdx === -1 ? rest : rest.slice(0, qIdx)).trim();
  if (!address) return null;

  const params = new URLSearchParams(qIdx === -1 ? '' : rest.slice(qIdx + 1));
  const amountRaw = params.get('amount');
  return {
    address,
    amountSats: amountRaw == null ? null : dgbStringToSats(amountRaw),
    label: params.get('label'),
    message: params.get('message'),
  };
}
