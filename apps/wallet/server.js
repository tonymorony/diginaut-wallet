// DigiDollar wallet app — zero-dependency server.
// Serves the static frontend and proxies JSON-RPC to a DigiByte Core node.
// Falls back to MOCK mode (realistic fake data) when no RPC creds are set,
// so the UI is usable before you have a testnet node running.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
const VENDOR_PACKAGES = ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39'];
const VENDOR_ROOTS = Object.fromEntries(
  VENDOR_PACKAGES.map((pkg) => [pkg, dirname(fileURLToPath(import.meta.resolve(pkg)))]),
);

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
  };
}

// Forward address-level reads to the indexer façade (#5: all balance/history
// queries go through the indexer seam — never node RPC).
async function handleIndexer(req, res, { indexerUrl }) {
  if (!indexerUrl) return sendJson(res, 503, { error: 'no indexer configured' });
  const rel = req.url.slice('/api/indexer'.length);
  if (!/^\/address\/[a-z0-9]+\/(utxos|history)$/.test(rel)) {
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
  // mintdigidollar / redeemdigidollar / senddigidollar intentionally NOT
  // exposed — fund-moving flows arrive client-signed via M2/M3 (ADR-0001).
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
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

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/rpc') return await handleRpc(req, res, { rpc: config.rpc, mockMode });
      if (req.method === 'POST' && req.url === '/api/faucet/claim') return await handleFaucetClaim(req, res, config);
      if (req.method === 'GET' && req.url.startsWith('/api/indexer/')) return await handleIndexer(req, res, config);
      if (req.url === '/api/config') return sendJson(res, 200, { mock: mockMode, rpcUrl: mockMode ? null : config.rpc.url, faucet: Boolean(config.faucetUrl), indexer: Boolean(config.indexerUrl) });
      if (req.method === 'GET') return await serveStatic(req, res);
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  });

  server.listen(config.port, () => {
    const { port } = server.address();
    console.log(`\n  DigiDollar Wallet (testnet)`);
    console.log(`  → http://localhost:${port}`);
    console.log(`  mode: ${mockMode ? 'MOCK (set DGB_RPC_USER/DGB_RPC_PASS for a real node)' : `REAL node @ ${config.rpc.url}`}\n`);
  });
  return server;
}

// Auto-start only when run directly (node server.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
