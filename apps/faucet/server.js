// DigiDollar testnet Faucet (CONTEXT.md: hands out free testnet DGB so a user
// has collateral to experiment with). Backed by a project-operated hot wallet
// on the shared node — explicitly NOT a user Wallet; the node holds this key.
//
// No mock mode: a faucet that cannot reach its node is down, and says so.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requiredCollateralSats, decodeWitnessAddress } from 'digidollar-js';

const COIN = 100_000_000n;

export function configFromEnv() {
  return {
    port: Number(process.env.PORT) || 8788,
    // Loopback by default — this is the one service with spending power (the
    // hot wallet), so `node server.js` must not publish it to the network by
    // accident. Containers opt back in with BIND_HOST=0.0.0.0 (deploy/*.yml).
    bindHost: process.env.BIND_HOST || '127.0.0.1',
    rpc: {
      url: process.env.DGB_RPC_URL || 'http://127.0.0.1:14022',
      user: process.env.DGB_RPC_USER || '',
      pass: process.env.DGB_RPC_PASS || '',
      wallet: process.env.DGB_RPC_WALLET || '', // hot-wallet name, appended as /wallet/<name>
    },
    dataFile: process.env.FAUCET_DATA_FILE || './faucet-claims.json',
    targetDdCents: BigInt(process.env.FAUCET_TARGET_DD_CENTS || 5000), // "$50 mint" sizing target
    cooldownHours: Number(process.env.FAUCET_COOLDOWN_HOURS) || 24,
  };
}

async function callNode(rpc, method, params) {
  const url = rpc.wallet ? `${rpc.url}/wallet/${rpc.wallet}` : rpc.url;
  const auth = Buffer.from(`${rpc.user}:${rpc.pass}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = JSON.parse(await res.text());
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

/**
 * Dispense size: the $targetDdCents six-month-tier Mint collateral floor at the
 * current Oracle price, +10% headroom for fees and price drift, rounded up to
 * a whole DGB. AC: always clears the floor itself.
 */
export function dispenseSats(targetDdCents, oraclePriceMicroUsd) {
  const floor = requiredCollateralSats({
    ddCents: targetDdCents,
    tierId: '6months',
    oraclePriceMicroUsd,
  });
  const withHeadroom = (floor * 110n) / 100n;
  return ((withHeadroom + COIN - 1n) / COIN) * COIN; // round up to whole DGB
}

// ---- Claim ledger: per-address and per-IP cooldowns, JSON file at rest so a
// faucet restart does not reset anyone's clock.
function loadClaims(dataFile) {
  try {
    return JSON.parse(readFileSync(dataFile, 'utf8'));
  } catch {
    return { byAddress: {}, byIp: {} };
  }
}

function saveClaims(dataFile, claims) {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(claims));
}

function cooldownLeftMs(claims, { address, ip }, cooldownHours, now) {
  const cutoff = now - cooldownHours * 3600_000;
  const last = Math.max(claims.byAddress[address] ?? 0, claims.byIp[ip] ?? 0);
  return last > cutoff ? last - cutoff : 0;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const CHAIN_HRP = { main: 'dgb', test: 'dgbt', regtest: 'dgbrt' };

async function handleClaim(req, res, ctx) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let address;
  try {
    ({ address } = JSON.parse(raw || '{}'));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  if (typeof address !== 'string') return sendJson(res, 400, { error: 'missing address' });

  const chain = (await ctx.rpc('getblockchaininfo', [])).chain;
  try {
    const dec = decodeWitnessAddress(address);
    if (dec.hrp !== CHAIN_HRP[chain]) throw new Error(`address is not for chain "${chain}"`);
  } catch (e) {
    return sendJson(res, 400, { error: `invalid address: ${e.message}` });
  }
  // Canonicalize to lowercase so an all-uppercase bech32 variant of the same
  // address can't bypass the per-address cooldown ledger (#55).
  address = address.toLowerCase();

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

  // Serialize concurrent claims for the same address or IP. The cooldown check
  // and the ledger write are separated by awaits (oracle + sendtoaddress), so
  // two simultaneous requests could both pass the check and drain the hot wallet
  // before either writes (#55 TOCTOU). This synchronous guard closes the window.
  const locks = [`a:${address}`, `i:${ip}`];
  if (locks.some((k) => ctx.inFlight.has(k))) {
    return sendJson(res, 429, { error: 'a claim from this address or IP is already being processed — try again shortly' });
  }
  locks.forEach((k) => ctx.inFlight.add(k));
  try {
    const leftMs = cooldownLeftMs(ctx.claims, { address, ip }, ctx.cooldownHours, ctx.now());
    if (leftMs > 0) {
      const hours = Math.ceil(leftMs / 3600_000);
      return sendJson(res, 429, {
        error: `already claimed — the Faucet allows one claim per address and IP every ${ctx.cooldownHours}h; try again in ~${hours}h`,
        retryAfterMs: leftMs,
      });
    }

    const oracle = await ctx.rpc('getoracleprice', []);
    if (!oracle?.price_micro_usd || oracle.is_stale) return sendJson(res, 503, { error: 'Oracle price unavailable or stale' });
    const priceMicroUsd = BigInt(oracle.price_micro_usd);

    const amountSats = dispenseSats(ctx.targetDdCents, priceMicroUsd);
    const amountDgb = Number(amountSats) / 1e8;
    const txid = await ctx.rpc('sendtoaddress', [address, amountDgb]);
    ctx.claims.byAddress[address] = ctx.now();
    ctx.claims.byIp[ip] = ctx.now();
    saveClaims(ctx.dataFile, ctx.claims);
    sendJson(res, 200, { txid, amountSats: amountSats.toString(), amountDgb });
  } finally {
    locks.forEach((k) => ctx.inFlight.delete(k));
  }
}

async function handleStatus(res, ctx) {
  const balanceDgb = await ctx.rpc('getbalance', []);
  const oracle = await ctx.rpc('getoracleprice', []);
  const dispenseDgb = oracle?.price_micro_usd
    ? Number(dispenseSats(ctx.targetDdCents, BigInt(oracle.price_micro_usd))) / 1e8
    : null;
  sendJson(res, 200, { balanceDgb, dispenseDgb, cooldownHours: ctx.cooldownHours });
}

export function startServer(overrides = {}) {
  const env = configFromEnv();
  const config = { ...env, ...overrides, rpc: { ...env.rpc, ...(overrides.rpc || {}) } };
  const ctx = {
    rpc: typeof overrides.rpc === 'function' ? overrides.rpc : (m, p) => callNode(config.rpc, m, p),
    targetDdCents: config.targetDdCents,
    cooldownHours: config.cooldownHours,
    dataFile: config.dataFile,
    claims: loadClaims(config.dataFile),
    now: overrides.now || Date.now,
    inFlight: new Set(), // address/IP keys with a claim currently in progress (#55)
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/claim') return await handleClaim(req, res, ctx);
      if (req.method === 'GET' && req.url === '/api/status') return await handleStatus(res, ctx);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (err) {
      // Keep upstream node/Electrum detail server-side; don't relay it to
      // clients where it can leak node internals (#55).
      console.error('faucet:', err);
      sendJson(res, 502, { error: 'faucet upstream error' });
    }
  });

  server.listen(config.port, config.bindHost, () => {
    const { port } = server.address();
    console.log(`  DigiDollar Faucet → http://localhost:${port} (bind ${config.bindHost})`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
