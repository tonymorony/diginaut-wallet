// Broadcast log — the durable trace between "signed" and "the node answered" (#C1).
//
// Before this module there was no state at all between signing and broadcast:
// the signed hex lived only as a local `const` inside a click handler, and every
// failure mode — consensus reject, proxy timeout, dropped socket, 5xx, non-JSON
// body — collapsed into one thrown Error. A broadcast that timed out AFTER the
// node accepted the transaction was presented as a plain failure, and the only
// thing a user can do with a plain failure is rebuild and send again — which
// double-spends the same coins into a conflicting transaction.
//
// Two rules follow, and both are load-bearing:
//   1. FAIL-AMBIGUOUS. Only a positively recognised node answer is a verdict.
//      Anything else — unknown text, a transport flag from apiFetch (#H1), an
//      empty message — is "we do not know", and the record is KEPT.
//   2. The record is chain-scoped, not wallet-scoped. It holds public data only
//      (the signed hex and the txid derived from it — useless for spending), so
//      it deliberately survives lock, auto-lock and wallet switch: the coins are
//      at risk regardless of which wallet is on screen.
import { sha256 } from '@noble/hashes/sha2.js';
import { friendlyRejectError, isAlreadyBroadcast, isNodeRejectString } from './dderrors.js';

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Bitcoin-style varint at `pos` → [value, nextPos]. */
function readVarint(bytes, pos) {
  const first = bytes[pos];
  if (first === undefined) throw new Error('truncated transaction');
  if (first < 0xfd) return [first, pos + 1];
  if (first === 0xfd) return [bytes[pos + 1] | (bytes[pos + 2] << 8), pos + 3];
  if (first === 0xfe) {
    return [(bytes[pos + 1] | (bytes[pos + 2] << 8) | (bytes[pos + 3] << 16) | (bytes[pos + 4] << 24)) >>> 0, pos + 5];
  }
  let v = 0n;
  for (let i = 0; i < 8; i += 1) v |= BigInt(bytes[pos + 1 + i] ?? 0) << BigInt(8 * i);
  if (v > 0xffffffffn) throw new Error('varint out of range');
  return [Number(v), pos + 9];
}

/** The txid of a SIGNED transaction: double-SHA256 of the non-witness
 *  serialization, byte-reversed. digidollar-js has no txid helper and its
 *  serializeTx always emits the segwit form, so the stripping happens here.
 *  Verified against all four Core-captured fixtures in
 *  packages/digidollar-js/test/fixtures (mint/spend/transfer/redeem). */
export function txidFromSignedHex(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error('not a hex transaction');
  const b = hexToBytes(hex.toLowerCase());
  let p = 4; // version
  const segwit = b[4] === 0x00 && b[5] === 0x01;
  if (segwit) p += 2; // marker + flag are witness data, not part of the txid
  const inStart = p;
  let nIn; [nIn, p] = readVarint(b, p);
  if (nIn === 0) throw new Error('transaction has no inputs');
  for (let i = 0; i < nIn; i += 1) {
    p += 36; // prevout: 32-byte txid + 4-byte index
    let scriptLen; [scriptLen, p] = readVarint(b, p);
    p += scriptLen + 4; // scriptSig + sequence
  }
  let nOut; [nOut, p] = readVarint(b, p);
  for (let i = 0; i < nOut; i += 1) {
    p += 8; // value
    let scriptLen; [scriptLen, p] = readVarint(b, p);
    p += scriptLen;
  }
  const bodyEnd = p;
  if (segwit) {
    for (let i = 0; i < nIn; i += 1) {
      let items; [items, p] = readVarint(b, p);
      for (let k = 0; k < items; k += 1) { let len; [len, p] = readVarint(b, p); p += len; }
    }
  }
  // Integrity check, not a nicety: without it a hex we mis-parsed still yields a
  // plausible-looking 64-hex string, and a WRONG txid is worse than none — every
  // Check-status/Rebroadcast decision downstream would be about another tx.
  if (p + 4 !== b.length) throw new Error(`trailing bytes: parsed ${p + 4} of ${b.length}`);
  const stripped = new Uint8Array(4 + (bodyEnd - inStart) + 4);
  stripped.set(b.subarray(0, 4), 0);
  stripped.set(b.subarray(inStart, bodyEnd), 4);
  stripped.set(b.subarray(b.length - 4), 4 + (bodyEnd - inStart));
  // one expression on purpose: noble returns a fresh array, and .reverse() is
  // in-place — hoisting the digest into a reused variable would corrupt it
  return bytesToHex(sha256(sha256(stripped)).reverse());
}

export const BROADCAST_LOG_KEY = 'diginaut.broadcasts';
const MAX_RECORDS = 20;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const KINDS = new Set(['send', 'transfer', 'mint', 'redeem', 'consolidate']);
const CHAINS = new Set(['mainnet', 'testnet', 'regtest']);
const STATES = new Set(['pending', 'ambiguous']);

/** Resolved lazily, inside the factory — `globalThis.localStorage` THROWS when
 *  site data is blocked, and reading it at module scope would break `import`
 *  itself (node --test has no webstorage either). A wallet with storage denied
 *  still broadcasts; it just loses the durable trace. */
function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch { /* site data blocked — fall through to the in-memory shim */ }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}

/** Coerce an incoming record to JSON-safe primitives, or null if it is not
 *  usable. String() is the BigInt guard: an amount left as a BigInt would make
 *  JSON.stringify THROW, the write would be silently lost, and the whole
 *  protection would be dead while looking implemented. */
function normalize(rec) {
  const txid = String(rec?.txid ?? '').toLowerCase();
  const hex = String(rec?.hex ?? '');
  if (!/^[0-9a-f]{64}$/.test(txid) || !/^([0-9a-f]{2})+$/.test(hex)) return null;
  const at = Number(rec?.at);
  const attempts = Number(rec?.attempts);
  return {
    txid,
    hex,
    kind: KINDS.has(rec?.kind) ? rec.kind : 'send',
    chain: CHAINS.has(rec?.chain) ? rec.chain : 'testnet',
    walletId: rec?.walletId == null ? null : String(rec.walletId),
    summary: String(rec?.summary ?? ''),
    at: Number.isFinite(at) ? at : Date.now(),
    state: STATES.has(rec?.state) ? rec.state : 'pending',
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1,
    lastError: rec?.lastError == null ? null : String(rec.lastError),
  };
}

/** Storage is injected (same convention as createVaultManager) so node --test
 *  can drive a Map-backed fake. Every method is best-effort and NEVER throws:
 *  a full quota or a denied storage must not abort a broadcast. */
export function createBroadcastLog(storage = defaultStorage()) {
  function read() {
    let parsed;
    try {
      parsed = JSON.parse(storage.getItem(BROADCAST_LOG_KEY) ?? '[]');
    } catch { return []; } // corrupt JSON, or a storage that throws on read
    if (!Array.isArray(parsed)) return [];
    // The prune lives HERE, not only on write: a record written once and never
    // revisited would otherwise outlive its usefulness forever.
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed
      .map(normalize)
      .filter((r) => r !== null && r.at >= cutoff)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RECORDS);
  }

  function write(recs) {
    try { storage.setItem(BROADCAST_LOG_KEY, JSON.stringify(recs.slice(0, MAX_RECORDS))); } catch { /* advisory */ }
  }

  // Read-modify-write stays synchronous throughout: two tabs can still race
  // (last writer wins, acceptable for advisory records), but no await may split
  // a read from its write or a record vanishes for the tab that did nothing.
  function mutate(txid, fn) {
    const key = String(txid ?? '').toLowerCase();
    const recs = read();
    const hit = recs.find((r) => r.txid === key);
    if (!hit) return null;
    fn(hit);
    write(recs);
    return hit;
  }

  return {
    /** Newest-first, pruned by age and count. */
    list: read,
    get: (txid) => read().find((r) => r.txid === String(txid ?? '').toLowerCase()) ?? null,
    record(rec) {
      const clean = normalize(rec);
      if (!clean) return null;
      const recs = read().filter((r) => r.txid !== clean.txid); // upsert by txid
      recs.unshift(clean);
      write(recs);
      return clean;
    },
    drop(txid) {
      const key = String(txid ?? '').toLowerCase();
      write(read().filter((r) => r.txid !== key));
    },
    markAmbiguous: (txid, message) => mutate(txid, (r) => {
      r.state = 'ambiguous';
      r.lastError = message == null ? null : String(message);
      r.attempts += 1;
    }),
    bumpAttempt: (txid) => mutate(txid, (r) => { r.attempts += 1; }),
  };
}

// Refusals the WALLET SERVER makes before the request ever reaches the node.
// They are definite in exactly the sense that matters here: nothing was
// broadcast, so there is no ambiguity to record.
const SERVER_REFUSALS = [
  /^method not allowed:/,
  /^invalid JSON body$/,
  /^refusing to serve: this deployment expects chain/,
  /^no indexer configured$/,
  // #H4's own refusals — the limiter answers BEFORE touching the node, so a
  // rate-limited or oversized broadcast definitely never left this server.
  /^request body too large/,
  /^too many requests — /,
];

/** Was this a node VERDICT, or did we simply never hear back?
 *  `{ kind: 'reject' | 'already' | 'ambiguous', message }`.
 *
 *  Getting the default backwards is the whole finding: an unrecognised string
 *  classified as a definite failure drops the recovery record and hands the user
 *  back the "just send it again" path that spends the same coins twice. Anything
 *  not positively recognised is ambiguous. */
export function classifyBroadcastError(err) {
  const raw = String(err?.message ?? err ?? '');
  // The FLAG, not the copy, is the contract with apiFetch (#H1): its wording is
  // free to change and is engine-specific ('Load failed' on Safari), so a
  // string match here would silently mis-handle a timed-out broadcast.
  // An indexer-shape refusal (#H2) is likewise not a node verdict.
  if (err?.transport === 'timeout' || err?.transport === 'network' || err?.indexerData === true) {
    return { kind: 'ambiguous', message: raw };
  }
  if (isAlreadyBroadcast(raw)) return { kind: 'already', message: friendlyRejectError(raw) ?? raw };
  if (isNodeRejectString(raw) || SERVER_REFUSALS.some((re) => re.test(raw))) {
    return { kind: 'reject', message: friendlyRejectError(raw) ?? raw };
  }
  // Covers timeouts that arrived without the flag, 'Failed to fetch',
  // 'HTTP 502', a non-JSON body, a JSON SyntaxError, and '' — every one of
  // which can follow a node that ACCEPTED the transaction.
  return { kind: 'ambiguous', message: raw };
}

/** Did the indexer answer "the chain has never seen this transaction"?
 *
 *  This is the verdict "Check status" turns into *Rebroadcast is safe*, so it
 *  must be true of nothing else: an outage, a warming backend or a failed
 *  prevout lookup answers `upstream-error`, and treating those as "never
 *  broadcast" would invite a second spend of coins already committed.
 *  The FLAG is the contract (`cause: 'tx-not-found'`, apps/indexer/server.js);
 *  the legacy text match stays for a deployment that has not taken that build —
 *  before it, an unknown txid arrived as ElectrumX's relayed DaemonError repr. */
export function isTxUnknownToIndexer(err) {
  if (err?.indexerCause) return err.indexerCause === 'tx-not-found';
  return /No such mempool or blockchain transaction|unknown path|HTTP 404/i.test(String(err?.message ?? ''));
}
