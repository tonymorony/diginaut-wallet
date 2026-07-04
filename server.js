// DigiDollar Testnet UI — zero-dependency server.
// Serves the static frontend and proxies JSON-RPC to a DigiByte Core node.
// Falls back to MOCK mode (realistic fake data) when no RPC creds are set,
// so the UI is usable before you have a testnet node running.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const CONFIG = {
  port: Number(process.env.PORT) || 8787,
  rpc: {
    // Point at your node's RPC (from digibyte.conf: rpcport). Set user/pass to leave mock mode.
    url: process.env.DGB_RPC_URL || 'http://127.0.0.1:14022',
    user: process.env.DGB_RPC_USER || '',
    pass: process.env.DGB_RPC_PASS || '',
  },
};

const MOCK_MODE = !CONFIG.rpc.user || !CONFIG.rpc.pass;

// Only these RPC methods are reachable from the browser. Keeps the proxy from
// exposing wallet-draining calls by accident. Extend deliberately.
const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getdeploymentinfo',
  'getoraclestatus',
  'listoracles',
  'getnewdigidollaraddress',
  'listredemptionpaths',
  'getdigidollarspendinfo',
  // mintdigidollartaproot / redeemdigidollar intentionally NOT exposed to the
  // browser yet — they move funds. Add them once auth/confirmation UX exists.
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- Mock data: shaped like the real RPC responses so the UI logic is identical ----
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
    case 'getoraclestatus':
      return { active: true, activeOracles: 15, threshold: 8, lastPrice: 0.01342, lastPriceBlock: 1_284_510, priceValidBlocks: 20, sources: 7 };
    case 'listoracles':
      return Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        pubkey: `dgbtoracle${String(i + 1).padStart(2, '0')}...`,
        active: i < 15,
        reliability: 0.96 + (i % 4) * 0.01,
        lastSeenBlock: 1_284_510 - (i % 3),
      }));
    case 'getnewdigidollaraddress':
      return 'dgbt1p' + 'q9x2mock' + Math.abs(hashStr(JSON.stringify(params) + Date.now())).toString(36).padStart(20, '0');
    case 'listredemptionpaths':
      return [];
    case 'getdigidollarspendinfo':
      return { internalKey: 'mock', merkleRoot: 'mock', scriptPaths: [] };
    default:
      throw new Error(`No mock for method: ${method}`);
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

async function callNode(method, params) {
  const auth = Buffer.from(`${CONFIG.rpc.user}:${CONFIG.rpc.pass}`).toString('base64');
  const res = await fetch(CONFIG.rpc.url, {
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

async function handleRpc(req, res) {
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
    const result = MOCK_MODE ? mockResponse(method, params) : await callNode(method, params);
    sendJson(res, 200, { result, mock: MOCK_MODE });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err), mock: MOCK_MODE });
  }
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/rpc') return await handleRpc(req, res);
    if (req.url === '/api/config') return sendJson(res, 200, { mock: MOCK_MODE, rpcUrl: MOCK_MODE ? null : CONFIG.rpc.url });
    if (req.method === 'GET') return await serveStatic(req, res);
    res.writeHead(405).end('method not allowed');
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(CONFIG.port, () => {
  console.log(`\n  DigiDollar Testnet UI`);
  console.log(`  → http://localhost:${CONFIG.port}`);
  console.log(`  mode: ${MOCK_MODE ? 'MOCK (set DGB_RPC_USER/DGB_RPC_PASS for a real node)' : `REAL node @ ${CONFIG.rpc.url}`}\n`);
});
