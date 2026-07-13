// DigiDollar wallet app — zero-dependency server.
// Serves the static frontend and proxies JSON-RPC to a DigiByte Core node.
// Falls back to MOCK mode (realistic fake data) when no RPC creds are set,
// so the UI is usable before you have a testnet node running.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
// The pure-protocol library, served to the browser as /lib/ (ADR-0004: the
// wallet is the lib's first consumer — same code runs in Node and browser).
// Resolved via Node's module resolution — works wherever npm hoists the package.
const LIB_DIR = dirname(fileURLToPath(import.meta.resolve('digidollar-js')));
// Crypto deps of the lib, served under /vendor/ so the browser import map can
// resolve the lib's bare specifiers (@noble/*, @scure/*) to real URLs.
const VENDOR_PACKAGES = ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39', 'qrcode-generator'];
const VENDOR_ROOTS = Object.fromEntries(
  VENDOR_PACKAGES.map((pkg) => [pkg, dirname(fileURLToPath(import.meta.resolve(pkg)))]),
);

// ---- Security headers (#55) ----
// A key-holding wallet locks its origin down. The CSP allows scripts only from
// same origin plus a hash for index.html's inline importmap (browsers block an
// inline <script type="importmap"> under a bare script-src 'self'). Crucially it
// carries NO 'unsafe-inline' for scripts and no 'unsafe-hashes', so an injected
// inline event handler (e.g. onerror= from a malicious node/indexer/oracle JSON)
// cannot execute even if an innerHTML sink is ever missed — defence in depth
// behind the per-sink escaping in app.js. Derived from the real index.html so it
// can never silently drift out of sync (a changed importmap fails loudly here).
function importmapCspHash() {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html: inline importmap not found — cannot build a script-src CSP');
  return `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`;
}
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${importmapCspHash()}`,
  "style-src 'self' 'unsafe-inline'", // index.html <style> + inline style="" on generated nodes
  "img-src 'self' data:",
  "media-src 'self'",                 // the loading.mp4 clip
  "connect-src 'self'",               // /api/* is same-origin
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",           // the wallet is never legitimately framed (clickjacking)
  "form-action 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',   // never leak the wallet URL/path to an explorer or upstream
};

export function configFromEnv() {
  return {
    port: Number(process.env.PORT) || 8787,
    rpc: {
      // Point at your node's RPC (from digibyte.conf: rpcport). Set user/pass to leave mock mode.
      url: process.env.DGB_RPC_URL || 'http://127.0.0.1:14022',
      user: process.env.DGB_RPC_USER || '',
      pass: process.env.DGB_RPC_PASS || '',
    },
    // Faucet service base URL; unset = no faucet button in the UI.
    faucetUrl: process.env.FAUCET_URL || '',
    // Indexer façade base URL (apps/indexer); unset = no balance/history in the UI.
    indexerUrl: process.env.INDEXER_URL || '',
    // Where the price sampler persists its series; unset = memory only.
    priceHistory: { dataFile: process.env.PRICE_HISTORY_FILE || '' },
    // Block-explorer tx URL prefix (e.g. https://…/tx/); unset = plain txids.
    explorerTxUrl: process.env.EXPLORER_TX_URL || '',
  };
}

// Forward address-level reads to the indexer façade (#5: all balance/history
// queries go through the indexer seam — never node RPC).
async function handleIndexer(req, res, { indexerUrl }) {
  if (!indexerUrl) return sendJson(res, 503, { error: 'no indexer configured' });
  const rel = req.url.slice('/api/indexer'.length);
  if (!/^\/(address\/[a-z0-9]+\/(utxos|history|positions|dd-utxos)|tx\/[0-9a-f]{64})$/.test(rel)) {
    return sendJson(res, 404, { error: 'unknown indexer path' });
  }
  try {
    const upstream = await fetch(`${indexerUrl}/api${rel}`, { signal: AbortSignal.timeout(15_000) });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    sendJson(res, 502, { error: `indexer unreachable: ${String(err.message || err)}` });
  }
}

// Forward a claim to the Faucet service (same-origin for the browser; the
// faucet's own rate limiting sees the real client IP via x-forwarded-for).
async function handleFaucetClaim(req, res, { faucetUrl }) {
  if (!faucetUrl) return sendJson(res, 503, { error: 'no faucet configured' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    const upstream = await fetch(faucetUrl + '/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': req.socket.remoteAddress ?? '' },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    sendJson(res, 502, { error: `faucet unreachable: ${String(err.message || err)}` });
  }
}

// Only these RPC methods are reachable from the browser. Keeps the proxy from
// exposing wallet-draining calls by accident. Extend deliberately.
const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getdeploymentinfo',
  // Real v9.26.4 names (docs/discovery/regtest-oracle-findings.md) — the
  // spec-discussion names (getoraclestatus, listoracles, …) don't exist.
  'getoracleprice',
  'getoracles',
  // Broadcast of CLIENT-SIGNED transactions (issue #6). The node only relays;
  // it cannot spend anything the browser didn't already sign.
  'sendrawtransaction',
  // Honest quotes (#62): both read-only. The DCA multiplier scales required
  // collateral with network health — quoting without it under-quotes on a
  // degraded system. Protection status carries the volatility-freeze flags the
  // mint flow checks BEFORE asking the user to sign.
  'getdcamultiplier',
  'getprotectionstatus',
  // mintdigidollar / redeemdigidollar / senddigidollar intentionally NOT
  // exposed — fund-moving flows arrive client-signed via M2/M3 (ADR-0001).
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

// ---- Mock data: shaped like the real RPC responses so the UI logic is identical.
// Oracle numbers mirror Core v9.26.4 consensus params: 35 oracle slots, threshold 7.
function mockResponse(method, params) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain: 'test', blocks: 1_284_512, headers: 1_284_512, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: {
            type: 'bip9',
            bip9: { status: 'active', bit: 5, start_time: 1746057600, timeout: 1809129600, since: 1_240_000 },
            active: true,
          },
          taproot: { type: 'bip9', bip9: { status: 'active' }, active: true },
        },
      };
    case 'getoracleprice':
      return {
        price_micro_usd: 13_420, price_cents: 1, price_usd: 0.01342,
        last_update_height: 1_284_510, validity_blocks: 20, is_stale: false,
        oracle_count: 35, status: 'ok',
      };
    case 'getoracles':
      return Array.from({ length: 35 }, (_, i) => ({
        oracle_id: i,
        name: `oracle-${i}`,
        pubkey: `03${String(i).padStart(64, '0')}`,
        is_active: true,
        in_consensus: i % 5 !== 4,
        active_oracle_count: 35,
        total_oracle_slots: 35,
        consensus_threshold: 7,
      }));
    case 'getdcamultiplier': {
      // Mirrors Core dca.cpp HEALTH_TIERS exactly, including the real RPC's
      // optional system_health param (lets tests exercise degraded tiers).
      const health = Number.isFinite(Number(params?.[0])) && params?.[0] !== undefined
        ? Math.min(30_000, Math.max(0, Number(params[0])))
        // healthy by default; MOCK_SYSTEM_HEALTH lets drivers demo degraded tiers
        : Number(process.env.MOCK_SYSTEM_HEALTH) || 200;
      const tier = health >= 150 ? { multiplier: 1.0, tier_status: 'healthy' }
        : health >= 120 ? { multiplier: 1.25, tier_status: 'warning' }
        : health >= 110 ? { multiplier: 1.5, tier_status: 'critical' }
        : { multiplier: 2.0, tier_status: 'emergency' };
      return {
        ...tier,
        system_health: health,
        description: tier.multiplier === 1.0
          ? 'No additional collateral required (healthy system)'
          : `${tier.multiplier.toFixed(1)}x base collateral required (${tier.tier_status} system)`,
      };
    }
    case 'getprotectionstatus':
      return {
        oracle: { available: true, status: 'available', minting_restricted: false, minting_restricted_reason: '' },
        dca: { active: false, current_multiplier: 1.0, tier: 'healthy', system_health: 200, trend: 'stable' },
        err: { active: false, threshold: 100, current_ratio: 200, err_ratio_bps: 10_000, required_burn_per_10000: 10_000, status: 'normal', evaluation_status: 'priced' },
        volatility: { protection_active: false, current_volatility: 2.1, protection_threshold: 20, minting_restricted: false },
        overall: { status: 'secure', active_protections: [], warnings: [] },
      };
    case 'sendrawtransaction': {
      // Fake txid: sha256 would be overkill for a mock — a stable-looking hash
      // derived from the hex keeps the UI flow exercisable offline.
      const hex = String(params?.[0] ?? '');
      let h = 0;
      for (const c of hex) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return h.toString(16).padStart(8, '0').repeat(8);
    }
    default:
      throw new Error(`No mock for method: ${method}`);
  }
}

// ---- Price history for the chart. Mock mode: a synthetic 24h random walk
// around the mock oracle price, regenerated per request (nothing to persist).
function syntheticPriceSeries(nowSec = Math.floor(Date.now() / 1000)) {
  const points = [];
  const stepSec = 300; // 5-minute candles, 24h back
  let price = 13_420;
  for (let t = nowSec - 24 * 3600; t <= nowSec; t += stepSec) {
    // gentle deterministic wave + hash-noise: plausible, stable within a step
    const wave = Math.sin(t / 7200) * 180;
    const noise = ((t * 2654435761) % 97) - 48;
    points.push({ t, price_micro_usd: Math.round(price + wave + noise) });
  }
  return points;
}

// Real mode: poll the node's oracle price on an interval into an in-memory
// series the chart endpoint serves. Persisted to a JSON file so history
// survives restarts. Stops with the server.
function startPriceSampler({ rpc, intervalMs = 60_000, dataFile = '', windowSec = 24 * 3600 }, server) {
  let series = [];
  const cutoff = () => Math.floor(Date.now() / 1000) - windowSec;
  if (dataFile) {
    try {
      const loaded = JSON.parse(readFileSync(dataFile, 'utf8'));
      if (Array.isArray(loaded)) series = loaded.filter((p) => p && p.t > cutoff() && p.price_micro_usd > 0);
    } catch {
      // no file yet / corrupt: start fresh
    }
  }
  async function sample() {
    try {
      const { price_micro_usd } = await callNode(rpc, 'getoracleprice', []);
      if (price_micro_usd > 0) series.push({ t: Math.floor(Date.now() / 1000), price_micro_usd });
    } catch {
      return; // node down / oracle stale: skip the point, keep sampling
    }
    while (series.length && series[0].t <= cutoff()) series.shift();
    if (dataFile) {
      try {
        await writeFile(dataFile, JSON.stringify(series));
      } catch {
        // read-only disk: chart still works from memory
      }
    }
  }
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  server.on('close', () => clearInterval(timer));
  return series;
}

async function callNode(rpc, method, params) {
  const auth = Buffer.from(`${rpc.user}:${rpc.pass}`).toString('base64');
  const res = await fetch(rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'ddui', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Node returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function handleRpc(req, res, { rpc, mockMode }) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  const { method, params = [] } = payload;
  if (!method || !ALLOWED_METHODS.has(method)) {
    return sendJson(res, 403, { error: `method not allowed: ${method}` });
  }
  try {
    const result = mockMode ? mockResponse(method, params) : await callNode(rpc, method, params);
    sendJson(res, 200, { result, mock: mockMode });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err), mock: mockMode });
  }
}

async function serveFrom(baseDir, relPath, res) {
  const filePath = normalize(join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/lib/')) return serveFrom(LIB_DIR, urlPath.slice('/lib/'.length), res);
  if (urlPath.startsWith('/vendor/')) {
    const rel = urlPath.slice('/vendor/'.length);
    const pkg = VENDOR_PACKAGES.find((p) => rel.startsWith(p + '/'));
    if (!pkg) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return serveFrom(VENDOR_ROOTS[pkg], rel.slice(pkg.length + 1), res);
  }
  return serveFrom(PUBLIC_DIR, urlPath, res);
}

export function startServer(overrides = {}) {
  const env = configFromEnv();
  const config = { ...env, ...overrides, rpc: { ...env.rpc, ...(overrides.rpc || {}) } };
  const mockMode = !config.rpc.user || !config.rpc.pass;

  let priceSeries = [];
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (req.method === 'POST' && req.url === '/api/rpc') return await handleRpc(req, res, { rpc: config.rpc, mockMode });
      if (req.method === 'POST' && req.url === '/api/faucet/claim') return await handleFaucetClaim(req, res, config);
      if (req.method === 'GET' && req.url.startsWith('/api/indexer/')) return await handleIndexer(req, res, config);
      // The stablecoin flows (mint/transfer/redeem) ship unconditionally as one
      // unit (ADR-0002, release gate #17) — no feature flag in the config.
      if (req.method === 'GET' && req.url === '/api/price-history') {
        return sendJson(res, 200, { series: mockMode ? syntheticPriceSeries() : priceSeries, mock: mockMode });
      }
      if (req.url === '/api/config') return sendJson(res, 200, { mock: mockMode, rpcUrl: mockMode ? null : config.rpc.url, faucet: Boolean(config.faucetUrl), indexer: Boolean(config.indexerUrl), explorerTxUrl: config.explorerTxUrl });
      if (req.method === 'GET') return await serveStatic(req, res);
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  });

  if (!mockMode) {
    priceSeries = startPriceSampler({ rpc: config.rpc, ...(config.priceHistory || {}) }, server);
  }

  server.listen(config.port, () => {
    const { port } = server.address();
    console.log(`\n  Diginaut · DigiDollar wallet`);
    console.log(`  → http://localhost:${port}`);
    console.log(`  mode: ${mockMode ? 'MOCK (set DGB_RPC_USER/DGB_RPC_PASS for a real node)' : `REAL node @ ${config.rpc.url}`}\n`);
  });
  return server;
}

// Auto-start only when run directly (node server.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
