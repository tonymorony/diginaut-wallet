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
  return {
    port: Number(process.env.PORT) || 8789,
    hrp: process.env.DGB_HRP || 'dgbt', // dgb | dgbt | dgbrt
    electrum: {
      host: process.env.ELECTRUM_HOST || '127.0.0.1',
      port: Number(process.env.ELECTRUM_PORT) || 50001,
    },
  };
}

// ---- Minimal Electrum client: newline-delimited JSON-RPC over TCP ----
class ElectrumClient {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
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
      sock.on('data', (d) => this.#onData(d));
      const fail = (err) => {
        this.sock = null;
        reject(err ?? new Error('electrum connection closed'));
        for (const { reject: rj } of this.pending.values()) rj(err ?? new Error('electrum connection closed'));
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
        if (this.pending.delete(id)) reject(new Error(`electrum timeout: ${method}`));
      }, 15_000).unref();
    });
  }

  #onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const entry = this.pending.get(msg.id);
      if (!entry) continue; // subscription notification — not used yet
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : entry.resolve(msg.result);
    }
  }

  async request(method, params = []) {
    await this.connect();
    return this.#send(method, params);
  }
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
async function scanPositions(withElectrum, programHex, history) {
  const positions = [];
  for (const h of history) {
    const tx = await withElectrum('blockchain.transaction.get', [h.tx_hash, true]);
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
async function scanDDUtxos(withElectrum, unspent) {
  const out = [];
  const txCache = new Map();
  for (const u of unspent.filter((x) => x.value === 0)) {
    if (!txCache.has(u.tx_hash)) {
      txCache.set(u.tx_hash, ddAmountsByVout(await withElectrum('blockchain.transaction.get', [u.tx_hash, true])));
    }
    const cents = txCache.get(u.tx_hash)?.get(u.tx_pos);
    if (cents === undefined) continue; // zero-value but not a DD token output
    out.push({ txid: u.tx_hash, vout: u.tx_pos, cents: String(cents), height: u.height });
  }
  return out;
}

function scriptPubKeyToScripthash(spkHex) {
  return createHash('sha256').update(Buffer.from(spkHex, 'hex')).digest().reverse().toString('hex');
}

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
          const utxos = await scanDDUtxos(withElectrum, unspent);
          const totalCents = utxos.reduce((s, u) => s + BigInt(u.cents), 0n);
          return sendJson(res, 200, { address, totalCents: String(totalCents), utxos });
        }
        if (what === 'positions') {
          const history = await withElectrum('blockchain.scripthash.get_history', [scripthash]);
          const [positions, tip] = await Promise.all([
            scanPositions(withElectrum, programHex, history),
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
      if (req.method === 'GET' && req.url === '/api/health') {
        const tip = await withElectrum('blockchain.headers.subscribe', []);
        return sendJson(res, 200, { height: tip.height });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 502, { error: String(err.message || err) });
    }
  });

  server.on('close', () => electrum.sock?.destroy()); // don't hold the event loop after close
  server.listen(config.port, () => {
    console.log(`  DigiDollar indexer façade → http://localhost:${server.address().port} (electrum ${config.electrum.host}:${config.electrum.port}, hrp ${config.hrp})`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
