// Indexer façade (#4): the wallet's indexer seam. Answers address-level DGB
// queries (UTXOs, history) by translating addresses to Electrum scripthashes
// and asking a stock ElectrumX. The wallet never learns which backend is
// behind this API — the M3 DigiDollar-positions scanner lands here too.
//
// Privacy (AC): queries are per-address only; xpubs never reach this service.

import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decodeWitnessAddress, parseDDVersion, parseMintMetadata, parseTransferMetadata, parseRedeemMetadata, ddTokenOutputKey, LOCK_TIERS } from 'digidollar-js';

export function configFromEnv() {
  // Validated rather than `|| default` like the knobs below, because 0 is
  // meaningful here: it is the cache's kill switch (every get misses), which an
  // operator triaging a staleness report needs without a code change. PORT=0
  // and TTL=0 do not mean the same kind of thing.
  const ttl = Number(process.env.TX_CACHE_TTL_MS);
  return {
    port: Number(process.env.PORT) || 8789,
    // Loopback by default. This façade is an unthrottled proxy in front of
    // ElectrumX with no auth of its own, and `node server.js` on a box with an
    // open port used to publish it to the whole network. Containers that must
    // take cross-container traffic set BIND_HOST=0.0.0.0 (deploy/*.yml).
    bindHost: process.env.BIND_HOST || '127.0.0.1',
    hrp: process.env.DGB_HRP || 'dgbt', // dgb | dgbt | dgbrt
    electrum: {
      host: process.env.ELECTRUM_HOST || '127.0.0.1',
      port: Number(process.env.ELECTRUM_PORT) || 50001,
    },
    // How long the scan paths may reuse a verbose tx body (see createTxCache).
    // Well under DigiByte's 15s block time on purpose: at a block-length TTL
    // the wallet's 8s poll could show a pending tx as pending for a whole
    // extra block after it was mined.
    txCacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : 5_000,
  };
}

// ---- Minimal Electrum client: newline-delimited JSON-RPC over TCP ----
// (exported so apps/indexer/test can drive the frame assembler directly)
// Cap the unframed read buffer: a compromised/broken ElectrumX must not be able
// to exhaust indexer memory with an endless line that never sends a newline (#55).
// Counted in BYTES — the assembler holds raw chunks, not a decoded string.
const MAX_ELECTRUM_FRAME = 16 * 1024 * 1024;

// Every failure that came from the ElectrumX side is TAGGED at the point it
// arises, because the HTTP layer never sees its text: raw upstream strings name
// the backend, its host:port and its error grammar to unauthenticated callers,
// so they are logged and dropped. `upstream` = a backend problem either way;
// `electrumRpc` narrows it to "the backend answered, with an error" — the only
// signal that distinguishes a healthy link from a dead one once the text is
// gone; `electrumRpcCode` carries the JSON-RPC code the backend sent, because
// "no such transaction" is an ANSWER and every other RPC error is an outage.
function tagUpstream(err, { rpc = false, code } = {}) {
  err.upstream = true;
  if (rpc) {
    err.electrumRpc = true;
    if (code !== undefined) err.electrumRpcCode = code;
  }
  return err;
}

export class ElectrumClient {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    // Frame assembly keeps the RAW chunks and resumes the '\n' search at the
    // first chunk the last pass had not reached (see #onData) — chunk
    // granularity, but no chunk is ever scanned twice.
    this.chunks = [];
    this.chunksLength = 0;
    this.scanChunk = 0; // first chunk not yet scanned for '\n'
  }

  connect() {
    if (this.sock) return this.ready;
    // The server.version handshake is part of CONNECTING, not of the process
    // lifetime: ElectrumX ≥1.4 kills any connection whose first message is
    // something else, so every reconnect must re-handshake (#32).
    this.ready = new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host);
      sock.setNoDelay(true);
      sock.on('connect', () => resolve());
      // Guard every socket event by IDENTITY: a socket we tear down (frame
      // overflow) fires 'close' asynchronously, and by then the next request
      // may already have opened a fresh session. The dead socket must not null
      // its successor, reject the requests the successor carries, or feed its
      // late bytes into the successor's frame assembler.
      sock.on('data', (d) => { if (this.sock === sock) this.#onData(d); });
      const fail = (err) => {
        if (this.sock !== sock) return; // a newer session owns this client now
        this.sock = null;
        this.#resetFrames(); // a half-assembled frame belongs to the dead socket
        const e = tagUpstream(err ?? new Error('electrum connection closed'));
        reject(e);
        for (const { reject: rj } of this.pending.values()) rj(e);
        this.pending.clear();
      };
      sock.on('error', fail);
      sock.on('close', () => fail());
      this.sock = sock;
    }).then(() => this.#send('server.version', ['dd-indexer 0.1', '1.4']));
    return this.ready;
  }

  #send(method, params) {
    const id = this.nextId++;
    this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(tagUpstream(new Error(`electrum timeout: ${method}`)));
      }, 15_000).unref();
    });
  }

  #resetFrames() {
    this.chunks = [];
    this.chunksLength = 0;
    this.scanChunk = 0;
  }

  #onData(d) {
    // Electrum frames are single-line JSON, and a verbose-tx body is megabytes
    // arriving in ~64KB chunks with no newline until the very end. `buf += d`
    // plus `buf.indexOf('\n')` re-flattened and re-scanned the WHOLE buffer on
    // every chunk — quadratic, and the shared session means that CPU is stolen
    // from every other request. Buffering raw chunks and scanning only the NEW
    // bytes pays one concat per COMPLETED frame instead.
    //
    // Scanning for the byte 0x0a is also what makes this UTF-8-safe: `string +=
    // Buffer` decodes each chunk on its own, so a multi-byte character split
    // across a chunk boundary silently became replacement characters. A UTF-8
    // continuation byte is >= 0x80 and can never be mistaken for a newline.
    this.chunks.push(d);
    this.chunksLength += d.length;
    if (this.chunksLength > MAX_ELECTRUM_FRAME) {
      // Drop the session too: we just failed every request in flight on it, and
      // the only way to resync a stream mid-frame is to skip to the next
      // newline. A fresh connection is cheaper and unambiguous.
      this.#resetFrames();
      const err = tagUpstream(new Error('electrum response exceeded frame limit'));
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      const dead = this.sock;
      // Forget the socket BEFORE destroying it. 'close' is async, and until it
      // fires `connect()` would hand the next caller `this.ready` — already
      // resolved, for a corpse — and #send would write to it (ERR_STREAM_
      // DESTROYED, a confusing transport error and one more failed money read).
      // Nulling here also makes fail()'s identity guard no-op the late 'close'.
      this.sock = null;
      dead?.destroy();
      return;
    }
    for (;;) {
      // Find the next '\n', resuming at the first chunk the previous pass had
      // not reached. A chunk with no newline is frame-interior, so advancing
      // past it is exactly-once: nothing before scanChunk can hold a newline.
      let nlChunk = -1;
      let nlPos = -1;
      for (let i = this.scanChunk; i < this.chunks.length; i++) {
        const p = this.chunks[i].indexOf(0x0a);
        if (p >= 0) { nlChunk = i; nlPos = p; break; }
        this.scanChunk = i + 1;
      }
      if (nlChunk < 0) return;
      // Assemble the completed frame ONCE and drop the bytes it consumed. What
      // follows the newline has never been scanned, so the next pass restarts
      // at 0 without re-reading anything.
      const frame = Buffer.concat([...this.chunks.slice(0, nlChunk), this.chunks[nlChunk].subarray(0, nlPos)]);
      const rest = this.chunks[nlChunk].subarray(nlPos + 1);
      this.chunks = rest.length ? [rest, ...this.chunks.slice(nlChunk + 1)] : this.chunks.slice(nlChunk + 1);
      this.chunksLength -= frame.length + 1; // the frame plus its newline
      this.scanChunk = 0;
      const line = frame.toString('utf8');
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A malformed line from a malicious/broken backend must not crash the
        // indexer process (#55) — skip it; the pending request will time out.
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) continue; // subscription notification — not used yet
      this.pending.delete(msg.id);
      msg.error
        ? entry.reject(tagUpstream(new Error(msg.error.message || JSON.stringify(msg.error)), { rpc: true, code: msg.error.code }))
        : entry.resolve(msg.result);
    }
  }

  async request(method, params = []) {
    await this.connect();
    return this.#send(method, params);
  }
}

// ---- Shared verbose-tx cache ----
// scanPositions, scanDDUtxos and enrichTx all resolve the same verbose
// blockchain.transaction.get bodies, and the wallet re-polls every 8s — three
// overlapping paths that memoized nothing, or memoized only within one call.
// A tx body is immutable, so the only field that can go stale inside the TTL
// is `confirmations`.
//
// Money safety: nothing that decides spendability is cached. The
// collateral-unspent check in scanPositions and every UTXO set the wallet
// spends from come from blockchain.scripthash.listunspent, which is never
// memoized — same for get_history and headers.subscribe.
const TX_CACHE_MAX = 500;

/**
 * Build a verbose-tx memo. Scoped to ONE server instance, never module-global:
 * the test suite boots many servers in a single process, and shared state
 * there makes tests order-dependent.
 */
export function createTxCache(withElectrum, ttlMs) {
  const entries = new Map(); // txid → { at, promise }; iterates in insertion order
  const get = (txid) => {
    const hit = entries.get(txid);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    // Memoize the PROMISE, not the result: callers that overlap on the same
    // txid then share one upstream call instead of racing to make their own.
    const promise = withElectrum('blockchain.transaction.get', [txid, true]);
    entries.delete(txid); // re-insert at the tail so eviction stays insertion-ordered
    entries.set(txid, { at: Date.now(), promise });
    if (entries.size > TX_CACHE_MAX) entries.delete(entries.keys().next().value);
    // A failed call must not be cached for the whole TTL — one ElectrumX blip
    // would otherwise be replayed to every caller until it expired.
    promise.catch(() => { if (entries.get(txid)?.promise === promise) entries.delete(txid); });
    return promise;
  };
  return { get, entries };
}

/** Electrum scripthash: reversed sha256 of the scriptPubKey (segwit v0/v1). */
export function addressToScripthash(address, expectedHrp) {
  const { hrp, version, programHex } = decodeWitnessAddress(address);
  if (hrp !== expectedHrp) throw new RangeError(`address is not for this network (want ${expectedHrp})`);
  const program = Buffer.from(programHex, 'hex');
  const opN = version === 0 ? 0x00 : 0x50 + version;
  const spk = Buffer.concat([Buffer.from([opN, program.length]), program]);
  return createHash('sha256').update(spk).digest().reverse().toString('hex');
}

// ---- DigiDollar positions (#13) ----
// A position = a mint owned by this address whose collateral (vout[0]) is still
// unspent. The address IS the mint's DD-token P2TR (vout[1]), so every mint by
// this owner appears in the address's Electrum history; the OP_RETURN metadata
// (vout[2]) carries amount/tier/unlock, and the collateral scripthash tells us
// whether the position was since redeemed.
async function scanPositions(withElectrum, getTx, programHex, history) {
  const positions = [];
  for (const h of history) {
    const tx = await getTx(h.tx_hash);
    if (parseDDVersion(tx.version).type !== 'mint') continue;
    const opReturn = tx.vout.find((o) => o.scriptPubKey.hex.startsWith('6a'));
    if (!opReturn) continue;
    let meta;
    try {
      meta = parseMintMetadata(opReturn.scriptPubKey.hex);
    } catch {
      continue; // DD-marked but not a well-formed mint — not a position
    }
    if (ddTokenOutputKey(meta.ownerKeyHex) !== programHex) continue; // someone else's mint
    const collateral = tx.vout[0];
    const collateralUnspent = (await withElectrum('blockchain.scripthash.listunspent', [
      scriptPubKeyToScripthash(collateral.scriptPubKey.hex),
    ])).some((u) => u.tx_hash === tx.txid && u.tx_pos === 0);
    if (!collateralUnspent) continue; // redeemed (or otherwise closed)
    const tier = LOCK_TIERS[meta.lockTier];
    positions.push({
      txid: tx.txid,
      height: h.height,
      ddCents: String(meta.ddCents),
      tierId: tier?.id ?? null,
      tierLabel: tier?.label ?? `tier ${meta.lockTier}`,
      unlockHeight: meta.unlockHeight,
      collateralSats: String(BigInt(Math.round(collateral.value * 1e8))),
    });
  }
  return positions;
}

// ---- DigiDollar spendable balance (#15) ----
// DD amounts are not on the UTXO itself (zero value): the creating tx's
// OP_RETURN lists cents which consensus pairs POSITIONALLY with the tx's
// zero-value canonical P2TR outputs, in output order (mint: [ddCents],
// transfer: amountsCents, redeem: [ddChangeCents]).
function ddAmountsByVout(tx) {
  const type = parseDDVersion(tx.version).type;
  if (!type) return null;
  const opReturn = tx.vout.find((o) => o.scriptPubKey.hex.startsWith('6a'));
  let amounts;
  try {
    if (type === 'mint') amounts = [parseMintMetadata(opReturn.scriptPubKey.hex).ddCents];
    else if (type === 'transfer') amounts = parseTransferMetadata(opReturn.scriptPubKey.hex).amountsCents;
    else if (type === 'redeem') amounts = opReturn ? [parseRedeemMetadata(opReturn.scriptPubKey.hex).ddChangeCents] : [];
    else return null;
  } catch {
    return null; // DD-marked but malformed — carries no DD value
  }
  const ddVouts = tx.vout.filter((o) => o.value === 0 && o.scriptPubKey.hex.startsWith('5120'));
  return new Map(ddVouts.map((o, i) => [o.n, amounts[i]]).filter(([, cents]) => cents !== undefined));
}

/** Resolve the address's zero-value UTXOs to DD cents via their creating txs. */
async function scanDDUtxos(getTx, unspent) {
  const out = [];
  const ddMaps = new Map(); // per-call memo of the PARSED amounts; getTx dedupes the fetch
  for (const u of unspent.filter((x) => x.value === 0)) {
    if (!ddMaps.has(u.tx_hash)) ddMaps.set(u.tx_hash, ddAmountsByVout(await getTx(u.tx_hash)));
    const cents = ddMaps.get(u.tx_hash)?.get(u.tx_pos);
    if (cents === undefined) continue; // zero-value but not a DD token output
    out.push({ txid: u.tx_hash, vout: u.tx_pos, cents: String(cents), height: u.height });
  }
  return out;
}

function scriptPubKeyToScripthash(spkHex) {
  return createHash('sha256').update(Buffer.from(spkHex, 'hex')).digest().reverse().toString('hex');
}

// ---- Per-tx enrichment (#69) ----
// The wallet's history was thin because the façade returned {txid, height}
// only. This resolves ONE tx into the facts a real history view needs — signed
// direction, fee, timestamp, confirmations, DD classification — while staying
// address-agnostic: the caller already knows the txid (a public fact), and
// which of the resolved in/out addresses are "theirs" is decided wallet-side,
// where the full watched-address set lives. So no xpub or address set leaks here.
function spkAddress(spk) {
  return spk?.address ?? (Array.isArray(spk?.addresses) ? spk.addresses[0] : null) ?? null;
}
// Core reports values as float DGB; sats is the integer we settle in.
const valueToSats = (v) => BigInt(Math.round(v * 1e8));

// `tx` is the ALREADY-FETCHED verbose tx: the route does that first lookup
// itself, because it is the only one whose failure can mean "no such
// transaction" — the prevout lookups below are about other transactions.
async function enrichTx(getTx, tx) {
  const type = parseDDVersion(tx.version).type || 'dgb';
  const ddMap = ddAmountsByVout(tx); // vout.n → DD cents (null for a plain DGB tx)
  const vout = tx.vout.map((o) => ({
    n: o.n,
    address: spkAddress(o.scriptPubKey),
    valueSats: String(valueToSats(o.value)),
    ddCents: ddMap?.has(o.n) ? String(ddMap.get(o.n)) : null,
  }));
  // Resolve each input to its funding address + value by fetching the prevout
  // tx. Needed for the fee (Σin − Σout) and the received-from counterpart.
  // Coinbase inputs have no prevout, so the fee is not computable there. Cap the
  // per-tx prevout fan-out (a consolidation can have thousands of inputs, and
  // one history row must not trigger thousands of Electrum calls, #55): resolve
  // the first MAX (enough to name a counterpart), leave the fee null past that.
  const MAX_VIN_RESOLVE = 40;
  const prevCache = new Map();
  let inputsResolved = true;
  const vin = [];
  for (let idx = 0; idx < tx.vin.length; idx++) {
    const i = tx.vin[idx];
    if (i.coinbase !== undefined || idx >= MAX_VIN_RESOLVE) { vin.push({ address: null, valueSats: null }); inputsResolved = false; continue; }
    if (!prevCache.has(i.txid)) prevCache.set(i.txid, await getTx(i.txid));
    const po = prevCache.get(i.txid)?.vout?.[i.vout];
    if (!po) { vin.push({ address: null, valueSats: null }); inputsResolved = false; continue; }
    vin.push({ address: spkAddress(po.scriptPubKey), valueSats: String(valueToSats(po.value)) });
  }
  let feeSats = null;
  if (inputsResolved) {
    const fee = vin.reduce((s, v) => s + BigInt(v.valueSats), 0n) - vout.reduce((s, v) => s + BigInt(v.valueSats), 0n);
    if (fee >= 0n) feeSats = String(fee);
  }
  return {
    txid: tx.txid,
    confirmations: Number.isFinite(tx.confirmations) ? tx.confirmations : 0,
    time: tx.blocktime ?? tx.time ?? null,
    type,
    feeSats,
    vin,
    vout,
  };
}

// The one upstream error that is an ANSWER rather than an outage: the chain has
// never seen this txid. Core's getrawtransaction answers RPC code -5
// (RPC_INVALID_ADDRESS_OR_KEY) in four shapes (src/rpc/rawtransaction.cpp:373-381),
// and only two of them are that answer — the other two say the node cannot see
// CONFIRMED transactions at all (txindex off, or still building), so the
// transaction asked about may well be on chain. Those are a warming backend and
// take the `upstream-error` path with everything else; the wallet turns this
// 404 into "Rebroadcast is safe", so it must never cover them.
// ElectrumX normally relays the daemon's error inside its OWN error (code 1)
// whose message is a Python DaemonError repr, hence matching the text as well
// as the code. Classifying HERE is fine — it is RELAYING upstream text that
// leaks the backend to unauthenticated callers (#55).
const NO_SUCH_TX = /no such (mempool or blockchain transaction|transaction found in the provided block)/i;
const INDEX_NOT_READY = /use -txindex|still in the process of being indexed/i;
const isTxUnknown = (err) => {
  const message = String(err?.message ?? '');
  return Boolean(err?.electrumRpc)
    && (err.electrumRpcCode === -5 || NO_SUCH_TX.test(message))
    && !INDEX_NOT_READY.test(message);
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function startServer(overrides = {}) {
  const env = configFromEnv();
  const config = { ...env, ...overrides, electrum: { ...env.electrum, ...(overrides.electrum || {}) } };
  const electrum = new ElectrumClient(config.electrum);
  // server.version happens inside connect() — once per CONNECTION, so a
  // dropped TCP session re-handshakes transparently on the next request (#32)
  const withElectrum = (method, params) => electrum.request(method, params);
  // One verbose-tx memo per server instance, shared by every scan path below.
  const txCache = createTxCache(withElectrum, config.txCacheTtlMs);

  const server = createServer(async (req, res) => {
    try {
      const match = req.url.match(/^\/api\/address\/([a-z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
      if (req.method === 'GET' && match) {
        const [, address, what] = match;
        let scripthash, programHex;
        try {
          ({ programHex } = decodeWitnessAddress(address));
          scripthash = addressToScripthash(address, config.hrp);
        } catch (e) {
          return sendJson(res, 400, { error: `invalid address: ${e.message}` });
        }
        if (what === 'dd-utxos') {
          const unspent = await withElectrum('blockchain.scripthash.listunspent', [scripthash]);
          const utxos = await scanDDUtxos(txCache.get, unspent);
          const totalCents = utxos.reduce((s, u) => s + BigInt(u.cents), 0n);
          return sendJson(res, 200, { address, totalCents: String(totalCents), utxos });
        }
        if (what === 'positions') {
          const history = await withElectrum('blockchain.scripthash.get_history', [scripthash]);
          const [positions, tip] = await Promise.all([
            scanPositions(withElectrum, txCache.get, programHex, history),
            withElectrum('blockchain.headers.subscribe', []),
          ]);
          return sendJson(res, 200, { address, tipHeight: tip.height, positions });
        }
        if (what === 'utxos') {
          const unspent = await withElectrum('blockchain.scripthash.listunspent', [scripthash]);
          return sendJson(res, 200, {
            address,
            utxos: unspent.map((u) => ({ txid: u.tx_hash, vout: u.tx_pos, valueSats: String(u.value), height: u.height })),
          });
        }
        const history = await withElectrum('blockchain.scripthash.get_history', [scripthash]);
        return sendJson(res, 200, {
          address,
          history: history.map((h) => ({ txid: h.tx_hash, height: h.height })),
        });
      }
      const txMatch = req.url.match(/^\/api\/tx\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && txMatch) {
        let tx;
        try {
          // Through the cache on purpose: it memoizes the PROMISE, so a tagged
          // rejection reaches every caller and the failure self-evicts —
          // nothing caches the 404 — while a hot txid still costs one upstream
          // read across positions/dd-utxos/tx.
          tx = await txCache.get(txMatch[1]);
        } catch (err) {
          // 404 is scoped to the REQUESTED txid, and to the errors that actually
          // say "no such transaction", so the copy is true by construction. The
          // wallet's recovery card reads this answer as "it never reached the
          // network — rebroadcasting is safe" (app.js), so a warming daemon, a
          // txindex problem or a failed PREVOUT lookup inside enrichTx must
          // never land here: they fall through to `upstream-error`, which
          // claims nothing about the transaction. That also keeps the ops
          // triage probe honest (ops-and-server.md).
          if (isTxUnknown(err)) {
            console.error('indexer: tx lookup:', err.message);
            return sendJson(res, 404, { error: 'not found', cause: 'tx-not-found' });
          }
          throw err;
        }
        return sendJson(res, 200, await enrichTx(txCache.get, tx));
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        const tip = await withElectrum('blockchain.headers.subscribe', []);
        return sendJson(res, 200, { height: tip.height });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      // This service is reachable unauthenticated through the wallet's proxy, so
      // the error TEXT stays here: it carries ElectrumX's Python DaemonError
      // reprs, `electrum timeout: <method>` (naming the backend's RPC grammar)
      // and socket errors naming ELECTRUM_HOST:PORT. Log the real thing — the
      // most useful line we have — and answer a fixed, machine-readable verdict.
      console.error('indexer:', err);
      // `error` is copy a user may end up reading through the wallet; `cause` is
      // the machine token, and it keeps TWO upstream verdicts because an
      // operator curling this service must tell "the backend answered, so the
      // trio is healthy" from "the link is actually down" with no fingerprint
      // left to read (ops-and-server.md). Same copy for both: to a user holding
      // a wallet there is no difference — no balances either way.
      const unavailable = 'the balance index is unavailable';
      if (err?.electrumRpc) return sendJson(res, 502, { error: unavailable, cause: 'upstream-error' });
      if (err?.upstream) return sendJson(res, 502, { error: unavailable, cause: 'upstream-unreachable' });
      // Untagged = our own defect. The copy names the actor because it reaches
      // the user verbatim through the wallet's fetchIndexer; `internal error`
      // was status-speak that named neither an actor nor a next step.
      sendJson(res, 500, { error: 'the balance index hit an unexpected error', cause: 'internal' });
    }
  });

  server.on('close', () => electrum.sock?.destroy()); // don't hold the event loop after close
  server.listen(config.port, config.bindHost, () => {
    console.log(`  DigiDollar indexer façade → http://localhost:${server.address().port} (bind ${config.bindHost}, electrum ${config.electrum.host}:${config.electrum.port}, hrp ${config.hrp})`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
