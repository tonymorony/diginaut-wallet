// DigiScope FALLBACK backend — TEMPORARY STOPGAP, display data only.
//
// When DIGISCOPE_URL is set, the indexer façade answers its routes from
// DigiScope's HTTP API (https://api.digiscope.me/api — the DigiByte Android
// wallet's production backend, ElectrumX-backed) instead of our own ElectrumX.
// Purpose: let the mainnet wallet show balances/UTXOs/history while our own
// electrumx-main does its multi-day genesis sync.
//
// ⚠ TRUST: enabling this mode trusts a THIRD PARTY (DigiScope) for everything
// the wallet DISPLAYS — balances, history, confirmations. It is display data
// only: transaction BROADCASTS still go through our own DigiByte node (the
// wallet's /api/rpc path), so DigiScope can at worst mislead the UI, never
// spend or censor funds silently. Remove DIGISCOPE_URL once our ElectrumX has
// caught up.
//
// The upstream contract is reverse-engineered from the Android client
// (digibytewallet-android core/src/main/java/io/digibyte/core/):
//   - reconcile/DgbNodeClient.kt   POST {base}/wallet/reconcile
//       request : {"addresses": ["dgb1…", …]}          (≤500 per request)
//       response: { utxos:  [{txid, vout, amountSatoshi, address, height,
//                             scriptPubKey?}, …],
//                   rawTxs: { txid: {hex, height, time}, … },  // parent tx of
//                   height: <chain tip> }                      // every utxo
//   - network/ChainTipFetcher.kt   GET {base}/chain/tip → {"height": n}
// Built entirely from that code — NO live probe was made. Anything the Android
// source leaves ambiguous is marked UNVERIFIED below and parsed tolerantly.
//
// Known honesty limits of this mode (documented, not faked around):
//   - history: derived from the reconcile response, which only covers txs that
//     FUND currently-unspent outputs. Spent/outgoing history is invisible —
//     the activity list shows deposits that are still part of the balance,
//     not the full ledger. Every entry shown is real; the list is incomplete.
//   - /api/tx: enrichment is parsed from the raw tx hex DigiScope returned for
//     a previous address query (per-process cache). Inputs' prevouts are
//     usually NOT in that cache, so vin addresses resolve to null and feeSats
//     to null — the same degraded-but-honest shape the wallet already renders
//     for capped/coinbase inputs. A txid never seen via reconcile is an error.
//   - mempool: reconcile is UTXO-set-shaped; whether unconfirmed outputs
//     appear (and with what height) is UNVERIFIED. Pending balance may be 0
//     until a deposit confirms.

import { createHash } from 'node:crypto';
import {
  encodeWitnessAddress,
  parseDDVersion,
  parseMintMetadata,
  ddTokenOutputKey,
  LOCK_TIERS,
} from 'digidollar-js';

const sha256 = (b) => createHash('sha256').update(b).digest();

// ---- Raw transaction parsing (Bitcoin/DigiByte wire format) ----
// DigiScope's rawTxs carry hex only; we re-derive everything the façade's
// enrichment needs (values, scripts, prevout references) locally so the only
// thing taken on trust is the hex itself — the txid is recomputed from it,
// so an entry whose hex does not hash to its claimed txid simply won't match.

/** Parse raw tx hex → { txid, version, locktime, vin, vout }. Throws on junk. */
export function parseRawTx(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('raw tx is not a hex string');
  }
  const buf = Buffer.from(hex, 'hex');
  let o = 0;
  const need = (n, what) => {
    if (o + n > buf.length) throw new Error(`raw tx truncated reading ${what}`);
  };
  const u32 = (what) => { need(4, what); const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = (what) => { need(8, what); const v = buf.readBigUInt64LE(o); o += 8; return v; };
  const varint = (what) => {
    need(1, what);
    const first = buf[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) { need(2, what); const v = buf.readUInt16LE(o); o += 2; return v; }
    if (first === 0xfe) return u32(what);
    const v = u64(what);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`raw tx ${what} varint out of range`);
    return Number(v);
  };
  const bytes = (n, what) => { need(n, what); const b = buf.subarray(o, o + n); o += n; return b; };

  const version = u32('version'); // uint32: DD marker lives in the high bits
  need(1, 'input count');
  const segwit = buf[o] === 0x00 && buf[o + 1] === 0x01;
  if (segwit) o += 2;
  const vinStart = o;
  const nIn = varint('input count');
  if (nIn === 0 || nIn > 1_000_000) throw new Error('raw tx has an implausible input count');
  const vin = [];
  for (let i = 0; i < nIn; i++) {
    const prevTxid = Buffer.from(bytes(32, `vin[${i}] prevout`)).reverse().toString('hex');
    const prevVout = u32(`vin[${i}] prevout index`);
    bytes(varint(`vin[${i}] scriptSig length`), `vin[${i}] scriptSig`);
    u32(`vin[${i}] sequence`);
    vin.push(prevTxid === '00'.repeat(32) && prevVout === 0xffffffff
      ? { coinbase: '' }
      : { txid: prevTxid, vout: prevVout });
  }
  const nOut = varint('output count');
  if (nOut > 1_000_000) throw new Error('raw tx has an implausible output count');
  const vout = [];
  for (let n = 0; n < nOut; n++) {
    const sats = u64(`vout[${n}] value`);
    const spkHex = bytes(varint(`vout[${n}] script length`), `vout[${n}] script`).toString('hex');
    vout.push({ n, sats, spkHex });
  }
  const voutEnd = o;
  if (segwit) {
    for (let i = 0; i < nIn; i++) {
      const items = varint(`vin[${i}] witness count`);
      for (let j = 0; j < items; j++) bytes(varint(`witness item length`), 'witness item');
    }
  }
  const locktime = u32('locktime');
  if (o !== buf.length) throw new Error('raw tx has trailing bytes');
  // txid = double-sha256 of the witness-STRIPPED serialization, byte-reversed.
  const stripped = segwit
    ? Buffer.concat([buf.subarray(0, 4), buf.subarray(vinStart, voutEnd), buf.subarray(buf.length - 4)])
    : buf;
  const txid = sha256(sha256(stripped)).reverse().toString('hex');
  return { txid, version, locktime, vin, vout };
}

/** scriptPubKey hex → bech32/bech32m address, or null for non-witness scripts
 *  (legacy P2PKH/P2SH, OP_RETURN, …) — same null the Electrum path yields when
 *  Core reports no address, and the wallet already renders that. */
export function spkToAddress(spkHex, hrp) {
  if (spkHex.startsWith('0014') && spkHex.length === 44) return encodeWitnessAddress(hrp, 0, spkHex.slice(4)); // P2WPKH
  if (spkHex.startsWith('0020') && spkHex.length === 68) return encodeWitnessAddress(hrp, 0, spkHex.slice(4)); // P2WSH
  if (spkHex.startsWith('5120') && spkHex.length === 68) return encodeWitnessAddress(hrp, 1, spkHex.slice(4)); // P2TR
  return null;
}

/**
 * Rebuild a Core-verbose-shaped tx from a cached rawTxs entry so the façade's
 * existing enrichment (enrichTx / ddAmountsByVout in server.js) runs on
 * DigiScope data unchanged. Value is float DGB to match Core's verbose JSON —
 * the same representation the Electrum path already consumes.
 */
export function verboseFromRaw(entry, tip, hrp) {
  const parsed = parseRawTx(entry.hex);
  return {
    txid: parsed.txid,
    version: parsed.version,
    confirmations: entry.height > 0 && tip >= entry.height ? tip - entry.height + 1 : 0,
    blocktime: entry.time ?? null,
    vin: parsed.vin,
    vout: parsed.vout.map((v) => ({
      n: v.n,
      value: Number(v.sats) / 1e8,
      scriptPubKey: { hex: v.spkHex, address: spkToAddress(v.spkHex, hrp) },
    })),
  };
}

// ---- Reconcile response mapping ----
// Field names/types mirror DgbNodeClient.parseReconcileResponse exactly:
// utxos[].{txid, vout, amountSatoshi, address, height}; rawTxs.{txid}.{hex,
// height, time}; top-level height. Tolerant where safe (numeric strings are
// accepted — JSON longs sometimes travel as strings); an entry missing a
// REQUIRED field is an error, never a silent skip: dropping a utxo would
// display a lower balance, i.e. fake data.

function toSafeInt(v, what) {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new Error(`digiscope reconcile: ${what} is not an integer`);
  return n;
}
function toSats(v, what) {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`digiscope reconcile: ${what} is not a satoshi amount`);
}

/** Validate + normalize a reconcile response → { utxos, rawTxs, height }. */
export function mapReconcile(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('digiscope reconcile: response is not a JSON object');
  }
  if (!Array.isArray(body.utxos)) throw new Error('digiscope reconcile: missing utxos array');
  const utxos = body.utxos.map((u, i) => {
    if (u === null || typeof u !== 'object') throw new Error(`digiscope reconcile: utxos[${i}] is not an object`);
    const txid = String(u.txid ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`digiscope reconcile: utxos[${i}] has a malformed txid`);
    if (typeof u.address !== 'string' || u.address === '') throw new Error(`digiscope reconcile: utxos[${i}] is missing its address`);
    return {
      txid,
      vout: toSafeInt(u.vout, `utxos[${i}].vout`),
      sats: toSats(u.amountSatoshi, `utxos[${i}].amountSatoshi`),
      address: u.address,
      height: toSafeInt(u.height, `utxos[${i}].height`),
    };
  });
  const rawTxs = {};
  if (body.rawTxs !== undefined && (body.rawTxs === null || typeof body.rawTxs !== 'object' || Array.isArray(body.rawTxs))) {
    throw new Error('digiscope reconcile: rawTxs is not an object');
  }
  for (const [txid, e] of Object.entries(body.rawTxs ?? {})) {
    if (e === null || typeof e !== 'object' || typeof e.hex !== 'string') {
      throw new Error(`digiscope reconcile: rawTxs[${txid}] has no hex`);
    }
    rawTxs[txid.toLowerCase()] = {
      hex: e.hex,
      // Android requires height/time (getLong); tolerate absence anyway and
      // degrade to unconfirmed/undated — UNVERIFIED whether they can be absent.
      height: e.height === undefined ? 0 : toSafeInt(e.height, `rawTxs[${txid}].height`),
      time: e.time === undefined ? null : toSafeInt(e.time, `rawTxs[${txid}].time`),
    };
  }
  // Android: root.optLong("height", 0) — chain tip, absent tolerated.
  const height = body.height === undefined ? 0 : toSafeInt(body.height, 'height');
  return { utxos, rawTxs, height };
}

// ---- The backend ----

const MAX_CACHED_RAWTX = 10_000; // bound the per-process raw-tx cache
const MAX_ADDR_CACHE = 512; // bound the per-address reconcile micro-cache

/**
 * Build the DigiScope-backed route implementations. `enrich` / `scanDDUtxos`
 * are server.js's existing Electrum-verbose enrichment functions, injected so
 * both backends share ONE interpretation of tx data (and no import cycle).
 */
export function createDigiScopeBackend({
  url,
  hrp,
  enrich,
  scanDDUtxos,
  fetchImpl = fetch,
  // The wallet polls every 8s and asks utxos/history/positions/dd-utxos per
  // address; this TTL collapses those into ONE upstream reconcile per address
  // per poll — basic courtesy toward a third-party production API.
  ttlMs = 5_000,
  // Android sets a 90s read timeout ("scantxoutset takes 20–60s server-side");
  // our ElectrumX-backed reads should be fast, but leave headroom.
  timeoutMs = 60_000,
  now = Date.now,
} = {}) {
  const base = String(url).replace(/\/+$/, '');
  const rawTxCache = new Map(); // txid → {hex, height, time}, insertion-ordered
  const perAddr = new Map(); // address → { at, promise } reconcile micro-cache
  let tip = 0; // best chain height seen from any DigiScope response

  async function reconcile(addresses) {
    const res = await fetchImpl(`${base}/wallet/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ addresses }), // exact field name from DgbNodeClient.requestBatch
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`digiscope reconcile: HTTP ${res.status}`);
    const mapped = mapReconcile(await res.json());
    if (mapped.height > tip) tip = mapped.height;
    for (const [txid, e] of Object.entries(mapped.rawTxs)) {
      rawTxCache.delete(txid); // re-insert → newest position (LRU-ish)
      rawTxCache.set(txid, e);
    }
    while (rawTxCache.size > MAX_CACHED_RAWTX) rawTxCache.delete(rawTxCache.keys().next().value);
    return mapped;
  }

  function reconcileForAddress(address) {
    const hit = perAddr.get(address);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    if (perAddr.size >= MAX_ADDR_CACHE) {
      for (const [a, e] of perAddr) if (now() - e.at >= ttlMs) perAddr.delete(a);
      if (perAddr.size >= MAX_ADDR_CACHE) perAddr.delete(perAddr.keys().next().value);
    }
    const promise = reconcile([address]);
    perAddr.set(address, { at: now(), promise });
    promise.catch(() => perAddr.delete(address)); // never cache a failure
    return promise;
  }

  /** Electrum-shaped shim over the raw-tx cache: transaction.get only. A miss
   *  returns null, which enrichTx treats as "prevout unresolved" (vin address
   *  null, fee null) — degraded-but-honest, exactly like its coinbase path. */
  async function withCachedTx(method, params) {
    if (method !== 'blockchain.transaction.get') {
      throw new Error(`digiscope fallback cannot serve electrum method ${method}`);
    }
    const entry = rawTxCache.get(params[0]);
    return entry ? verboseFromRaw(entry, tip, hrp) : null;
  }

  const mine = (r, address) => r.utxos.filter((u) => u.address.toLowerCase() === address.toLowerCase());

  /** Every zero-value UTXO's parent must be in rawTxs (DgbNodeClient doc:
   *  "raw parent-tx hex for each UTXO") — without it DD cents are unknowable,
   *  and guessing 0 would be faking a balance. UNVERIFIED against a live
   *  response, hence the honest error rather than a silent skip. */
  function requireParents(unspent) {
    for (const u of unspent) {
      if (u.value === 0 && !rawTxCache.has(u.tx_hash)) {
        throw new Error(`digiscope reconcile omitted the parent tx of ${u.tx_hash}:${u.tx_pos} — cannot resolve DigiDollar value`);
      }
    }
  }

  return {
    describe: `DIGISCOPE FALLBACK ${base} — third-party display data, hrp ${hrp}`,
    close: () => {},

    async utxos(address) {
      const r = await reconcileForAddress(address);
      return {
        address,
        utxos: mine(r, address).map((u) => ({ txid: u.txid, vout: u.vout, valueSats: String(u.sats), height: u.height })),
      };
    },

    // History DERIVED from reconcile: the funding tx of each live UTXO.
    // Incomplete by construction (spends invisible — see header comment), but
    // every row is a real tx. Electrum ordering: confirmed ascending by
    // height, unconfirmed (height ≤ 0 → 0) last.
    async history(address) {
      const r = await reconcileForAddress(address);
      const byTxid = new Map();
      for (const u of mine(r, address)) if (!byTxid.has(u.txid)) byTxid.set(u.txid, Math.max(0, u.height));
      const history = [...byTxid].map(([txid, height]) => ({ txid, height }))
        .sort((a, b) => (a.height === 0 ? Infinity : a.height) - (b.height === 0 ? Infinity : b.height));
      return { address, history };
    },

    async ddUtxos(address) {
      const r = await reconcileForAddress(address);
      const unspent = mine(r, address)
        .map((u) => ({ tx_hash: u.txid, tx_pos: u.vout, value: Number(u.sats), height: u.height }));
      requireParents(unspent);
      const utxos = await scanDDUtxos(withCachedTx, unspent);
      const totalCents = utxos.reduce((s, u) => s + BigInt(u.cents), 0n);
      return { address, totalCents: String(totalCents), utxos };
    },

    // Positions from reconcile: a mint whose DD-token output (the address's
    // own zero-value P2TR) is still unspent, and whose collateral (vout 0) is
    // still unspent — the latter checked with a second reconcile on the
    // collateral's NUMS P2TR address. Narrower than the Electrum scan: a mint
    // whose DD token was transferred away no longer surfaces here (its token
    // UTXO left this address). Display-only limitation of the stopgap.
    async positions(address, programHex) {
      const r = await reconcileForAddress(address);
      const candidates = [];
      for (const u of mine(r, address)) {
        if (u.sats !== 0n) continue;
        const entry = rawTxCache.get(u.txid);
        if (!entry) throw new Error(`digiscope reconcile omitted the parent tx of ${u.txid}:${u.vout} — cannot classify it`);
        const parsed = parseRawTx(entry.hex);
        if (parseDDVersion(parsed.version).type !== 'mint') continue;
        const opReturn = parsed.vout.find((v) => v.spkHex.startsWith('6a'));
        if (!opReturn) continue;
        let meta;
        try {
          meta = parseMintMetadata(opReturn.spkHex);
        } catch {
          continue; // DD-marked but not a well-formed mint — not a position
        }
        if (ddTokenOutputKey(meta.ownerKeyHex) !== programHex) continue; // someone else's mint
        const collateral = parsed.vout[0];
        const collateralAddr = spkToAddress(collateral.spkHex, hrp);
        if (!collateralAddr) throw new Error(`cannot derive the collateral address of mint ${u.txid} — cannot verify the position is open`);
        candidates.push({ txid: u.txid, height: entry.height, meta, collateral, collateralAddr });
      }
      let openTxids = new Set();
      if (candidates.length > 0) {
        const rc = await reconcile([...new Set(candidates.map((c) => c.collateralAddr))]);
        openTxids = new Set(rc.utxos.filter((x) => x.vout === 0).map((x) => x.txid));
      }
      const positions = candidates.filter((c) => openTxids.has(c.txid)).map((c) => {
        const tier = LOCK_TIERS[c.meta.lockTier];
        return {
          txid: c.txid,
          height: c.height,
          ddCents: String(c.meta.ddCents),
          tierId: tier?.id ?? null,
          tierLabel: tier?.label ?? `tier ${c.meta.lockTier}`,
          unlockHeight: c.meta.unlockHeight,
          collateralSats: String(c.collateral.sats),
        };
      });
      return { address, tipHeight: tip, positions };
    },

    // /api/tx from the raw hex DigiScope handed us for a previous address
    // query. Reconcile is address-keyed — there is no lookup-by-txid — so a
    // txid we have never seen is an honest error (the wallet shows the row
    // unenriched), never fabricated data.
    async tx(txid) {
      if (!rawTxCache.has(txid)) {
        throw new Error('digiscope fallback: tx not seen via a reconcile yet — it cannot be resolved by txid alone');
      }
      return enrich(withCachedTx, txid);
    },

    async health() {
      // ChainTipFetcher.kt: GET {base}/chain/tip → {"height": n}, longs only.
      const res = await fetchImpl(`${base}/chain/tip`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`digiscope /chain/tip: HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      const height = Number(body?.height);
      if (!Number.isSafeInteger(height) || height <= 0) throw new Error('digiscope /chain/tip: no usable height in response');
      if (height > tip) tip = height;
      return { height };
    },
  };
}
