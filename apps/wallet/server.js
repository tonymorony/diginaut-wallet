// DigiDollar wallet app — zero-dependency server.
// Serves the static frontend and proxies JSON-RPC to a DigiByte Core node.
// Falls back to MOCK mode (realistic fake data) when no RPC creds are set,
// so the UI is usable before you have a testnet node running.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { verifyVendorTree, describeVendorFailure } from './vendor-integrity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// ---- Build version ----
// Semver from package.json + the commit stamp. The stamp file carries a git
// export-subst placeholder that `git archive` expands at deploy time (the
// prod server has no .git); from a working tree it falls back to asking git,
// and failing that reports "dev". Shown in the UI footer and /api/config so
// each domain of a dual-network deployment names the exact build it runs.
function resolveVersion() {
  const semver = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
  let stamp = '';
  try {
    stamp = readFileSync(join(__dirname, '.version-stamp'), 'utf8').trim();
  } catch { /* file missing: fall through to git */ }
  if (!stamp || stamp.startsWith('$Format')) {
    try {
      stamp = execSync('git log -1 --format="%h %cs"', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().replace(/"/g, '');
    } catch {
      stamp = 'dev';
    }
  }
  return `v${semver}+${stamp.replace(' ', ' · ')}`;
}
const APP_VERSION = resolveVersion();
// The pure-protocol library, served to the browser as /lib/ (ADR-0004: the
// wallet is the lib's first consumer — same code runs in Node and browser).
// Resolved via Node's module resolution — works wherever npm hoists the package.
const LIB_DIR = dirname(fileURLToPath(import.meta.resolve('digidollar-js')));
// Crypto deps of the lib, served under /vendor/ so the browser import map can
// resolve the lib's bare specifiers (@noble/*, @scure/*) to real URLs.
const VENDOR_PACKAGES = ['@noble/curves', '@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39', 'qrcode-generator'];
export const VENDOR_ROOTS = Object.fromEntries(
  VENDOR_PACKAGES.map((pkg) => [pkg, dirname(fileURLToPath(import.meta.resolve(pkg)))]),
);

// Fail closed if the /vendor tree is not byte-for-byte what vendor.lock records.
// Pinned versions (#114) say what npm should install; this says what is actually
// on disk at boot. Regenerate deliberately with `npm run vendor:lock`.
function verifyVendorIntegrity() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(__dirname, 'vendor.lock'), 'utf8'));
  } catch (err) {
    throw new Error(`vendor.lock is missing or unreadable (${err.message}) — run: npm run vendor:lock`);
  }
  const result = verifyVendorTree(VENDOR_ROOTS, lock);
  if (!result.ok) {
    throw new Error(
      'REFUSING TO START: the /vendor tree does not match vendor.lock.\n' +
      describeVendorFailure(result) +
      '\n  If this change is intentional, re-run: npm run vendor:lock',
    );
  }
  return Object.keys(lock).length;
}

// ---- Security headers (#55) ----
// A key-holding wallet locks its origin down. The CSP allows scripts only from
// same origin plus a hash for index.html's inline importmap (browsers block an
// inline <script type="importmap"> under a bare script-src 'self'). Crucially it
// carries NO 'unsafe-inline' for scripts and no 'unsafe-hashes', so an injected
// inline event handler (e.g. onerror= from a malicious node/indexer/oracle JSON)
// cannot execute even if an innerHTML sink is ever missed — defence in depth
// behind the per-sink escaping in app.js. Derived from the real index.html so it
// can never silently drift out of sync (a changed importmap fails loudly here).
export function importmapCspHash(html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html: inline importmap not found — cannot build a script-src CSP');
  // #L7: the HTML parser normalizes CRLF and lone CR to LF while preprocessing
  // the input stream, so the browser hashes the LF form whatever is on disk.
  // Hashing raw bytes breaks every CRLF checkout (Windows core.autocrlf): no
  // hash matches, the importmap is blocked, and the wallet never boots — a
  // total outage with no diagnostic anywhere. The `html` parameter exists so a
  // test can prove the invariance; the zero-arg call below is unchanged.
  const normalized = m[1].replace(/\r\n?/g, '\n');
  return `'sha256-${createHash('sha256').update(normalized).digest('base64')}'`;
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

// #M3 — TLS deployments only (HSTS=1). Without it, a wallet served over HTTPS
// is one sslstrip away from handing the key-holding page over plain HTTP on a
// hostile network. 180 days; includeSubDomains because no name under this
// origin should ever be reachable over http. No `preload`: that is a one-way,
// browser-vendor-list commitment an operator opts into, not something a wallet
// build decides for them. Default OFF — the wallet also legitimately runs on
// http://localhost, where HSTS would poison the origin for every other
// localhost project on the developer's machine.
// Deliberately emitted here and NOT in deploy/Caddyfile: an app-level header
// also protects self-hosters who terminate TLS elsewhere (nginx, a Cloudflare
// tunnel), and Caddy forwards upstream response headers unchanged.
const HSTS_VALUE = 'max-age=15552000; includeSubDomains';

// Env numbers where 0 is MEANINGFUL (0 = unlimited). The `Number(x) || dflt`
// idiom used for PORT would silently turn an operator's deliberate 0 back
// into the default.
const numEnv = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function configFromEnv() {
  return {
    port: Number(process.env.PORT) || 8787,
    // Loopback by default: `node server.js` on a box with an open port used to
    // publish this proxy — and with it the node's RPC surface — to the whole
    // network. A public deployment puts a TLS terminator in front and the
    // container opts back in with BIND_HOST=0.0.0.0 (deploy/*.yml).
    bindHost: process.env.BIND_HOST || '127.0.0.1',
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
    // Cross-wire guard (#64): the chain this deployment MUST be backed by
    // ('main' | 'test' | 'regtest'). When set and the node reports a different
    // chain, the server refuses to proxy RPC — a mainnet wallet silently
    // serving testnet data (or vice versa) is the one misconfiguration a
    // dual-network host cannot afford. Unset = no guard (single-net setups).
    expectedChain: process.env.EXPECTED_CHAIN || '',
    // #M3: emit Strict-Transport-Security. Set on a TLS deployment; the header
    // is ignored by browsers over plain http (RFC 6797 §7.2), so it is harmless
    // on the container's http hop and reaches the browser via Caddy.
    hsts: process.env.HSTS === '1',
    // #H4: behind deploy/Caddyfile the socket peer is always Caddy, so per-IP
    // limiting would bucket every user into one key. TRUST_PROXY=1 makes the
    // limiter read the address Caddy appended to X-Forwarded-For. OFF by
    // default: with nothing in front, a trusted XFF is a free rate-limit
    // bypass — a client just forges a fresh value per request.
    trustProxy: process.env.TRUST_PROXY === '1',
    // Fixed-window per-IP budgets. 0 = unlimited (browser drivers, tests).
    rateLimit: {
      windowMs: numEnv('RATE_LIMIT_WINDOW_MS', 60_000),
      rpc: numEnv('RATE_LIMIT_RPC_PER_MIN', 120),
      indexer: numEnv('RATE_LIMIT_INDEXER_PER_MIN', 6000),
      faucet: numEnv('RATE_LIMIT_FAUCET_PER_MIN', 20),
    },
    // Body caps. 1 MiB RPC: a max-standard DigiByte tx (400 000 weight) is at
    // most ~400 KB serialized = ~800 KB of hex, so this admits every tx the
    // node would relay and nothing bigger — and the consolidate flow spends
    // EVERY confirmed coin (public/app.js, no input cap), which is where the
    // big bodies come from. 16 KiB faucet: the claim body is one JSON object
    // with one address.
    maxBodyBytes: { rpc: numEnv('MAX_RPC_BODY_BYTES', 1_048_576), faucet: numEnv('MAX_FAUCET_BODY_BYTES', 16_384) },
  };
}

// Forward address-level reads to the indexer façade (#5: all balance/history
// queries go through the indexer seam — never node RPC).
async function handleIndexer(req, res, { indexerUrl, guard }) {
  // same fail-closed rule as /api/rpc: a cross-wired deployment serves nothing
  if (guard?.blocked()) return sendJson(res, 503, { error: guard.describe() });
  if (!indexerUrl) return sendJson(res, 503, { error: 'no indexer configured' });
  const rel = req.url.slice('/api/indexer'.length);
  if (!/^\/(address\/[a-z0-9]+\/(utxos|history|positions|dd-utxos)|tx\/[0-9a-f]{64})$/.test(rel)) {
    return sendJson(res, 404, { error: 'unknown indexer path' });
  }
  try {
    const upstream = await fetch(`${indexerUrl}/api${rel}`, { signal: AbortSignal.timeout(15_000) });
    const body = await upstream.text();
    // no-store for the same reason as sendJson's — these ARE the balance reads
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    // Not `indexer unreachable: ${err.message}` — that named the configured
    // INDEXER_URL host:port (plus ECONNREFUSED/DNS text) to any caller. Same
    // `{error, cause}` shape the indexer itself answers: copy for the user,
    // token for the UI's flag check and for an operator triaging the hop.
    console.error('wallet: indexer fetch:', err);
    sendJson(res, 502, { error: 'the balance index is unavailable', cause: 'indexer-unreachable' });
  }
}

// Forward a claim to the Faucet service (same-origin for the browser). The
// Faucet keys its 24 h cooldown off the FIRST x-forwarded-for element
// (apps/faucet/server.js) and we send exactly one, so this header decides who
// the Faucet thinks is claiming. #H4: it used to be req.socket.remoteAddress,
// which behind deploy/Caddyfile is the Caddy container — i.e. every TLS
// deployment granted one claim per 24 h for ALL of its users combined.
// clientIp() resolves the real peer when TRUST_PROXY says a proxy is in front.
async function handleFaucetClaim(req, res, { faucetUrl, guard, maxBodyBytes, trustProxy }) {
  if (guard?.blocked()) return sendJson(res, 503, { error: guard.describe() });
  if (!faucetUrl) return sendJson(res, 503, { error: 'no faucet configured' });
  const raw = await readBody(req, res, maxBodyBytes);
  if (raw === null) return; // 413 already sent (or the client vanished)
  try {
    const upstream = await fetch(faucetUrl + '/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp(req, trustProxy) },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    // same rule as the indexer proxy: FAUCET_URL's host:port stays server-side
    console.error('wallet: faucet fetch:', err);
    sendJson(res, 502, { error: 'the Faucet is unavailable', cause: 'faucet-unreachable' });
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
function startPriceSampler({ rpc, intervalMs = 60_000, dataFile = '', windowSec = 24 * 3600, guard = null }, server) {
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
    // re-confirm the chain in the same cycle that records the price: a
    // backend swap between guard probes must not leak even one wrong-chain
    // point into this network's history file
    if (guard) {
      await guard.probeNow();
      if (guard.blocksSampling()) return;
    }
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

// Cross-wire guard (#64). A guarded deployment (EXPECTED_CHAIN set) is
// FAIL-CLOSED: proxying is refused until the node's chain has been confirmed
// once, and refused permanently while it reports the wrong chain. Probes at
// boot, then every 5s until first confirmation, then every intervalMs — so a
// backend swap behind the same URL is caught without a restart. handleRpc
// also feeds it every getblockchaininfo it proxies.
function startChainGuard({ rpc, expectedChain, intervalMs = 60_000 }, server) {
  const guard = {
    expected: expectedChain,
    actual: null,
    seen(chain) { guard.actual = chain; },
    mismatch: () => Boolean(guard.expected && guard.actual && guard.actual !== guard.expected),
    // unconfirmed ≠ cross-wired: the node may just be down/starting, so the
    // refusal message differs — but a guarded deployment still refuses
    unconfirmed: () => Boolean(guard.expected && !guard.actual),
    blocked: () => guard.mismatch() || guard.unconfirmed(),
    blocksSampling: () => Boolean(guard.expected && (guard.mismatch() || !guard.actual)),
    describe: () => guard.unconfirmed()
      ? `refusing to serve: this deployment expects chain "${guard.expected}" but the node has not yet confirmed its chain (down or starting) — retrying`
      : `refusing to serve: this deployment expects chain "${guard.expected}" but the node reports "${guard.actual}" — cross-wired backend (check DGB_RPC_URL / EXPECTED_CHAIN)`,
    async probeNow() {
      try {
        const { chain } = await callNode(rpc, 'getblockchaininfo', []);
        if (chain) {
          const chainChanged = guard.actual !== chain;
          guard.seen(chain);
          if (guard.mismatch() && chainChanged) console.error(`  CHAIN GUARD: ${guard.describe()}`);
        }
      } catch {
        // node down: keep the last known answer; the RPC proxy reports outages
      }
    },
  };
  let timer;
  async function loop() {
    await guard.probeNow();
    timer = setTimeout(loop, guard.actual ? intervalMs : 5_000);
    timer.unref?.();
  }
  loop();
  server.on('close', () => clearTimeout(timer));
  return guard;
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

// `no-store`, on every API answer, for the same reason static assets got a
// validator: with neither header a browser picks its own expiry (heuristic
// freshness, RFC 9111 §4.2.2) and may re-serve a JSON body it fetched days ago.
// Static content going stale is a bad deploy; THIS going stale is money — a
// cached /api/indexer/…/utxos feeds coin selection outputs that are already
// spent, and a cached /api/config can serve `chainMismatch:false` after the
// deployment was cross-wired, which is the one flag the #64 guard renders from.
// Not `no-cache`: these have no validator to revalidate against.
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

// ---- Client identity (#H4) ----
// Normalized peer address, WITHOUT rate-limit bucketing — this is also what
// gets forwarded to the Faucet, so it must stay a real address.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const list = String(Array.isArray(xff) ? xff.join(',') : xff || '').split(',');
    // LAST element, not first: Caddy APPENDS the address it saw to whatever
    // the client sent, so everything to the left is attacker-supplied.
    const last = list[list.length - 1].trim();
    if (last) return normalizeIp(last);
  }
  return normalizeIp(req.socket.remoteAddress || 'unknown');
}

function normalizeIp(addr) {
  let a = String(addr).trim().replace(/^\[/, '').replace(/\]$/, '');
  const pct = a.indexOf('%');            // fe80::1%eth0
  if (pct > -1) a = a.slice(0, pct);
  return a.replace(/^::ffff:/i, '');     // ::ffff:1.2.3.4 and 1.2.3.4 are one client
}

// Rate-limit key. An IPv6 client usually owns a whole /64, so counting per
// address would hand it 2^64 budgets; count per /64 instead. IPv4 unchanged.
function rateKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const groups = ip.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  if (groups.length !== 8) return ip;    // malformed: key on the raw string
  return groups.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// ---- Fixed-window per-IP limiter (#H4) ----
// One window for the whole process: at rollover the table is DROPPED, so a
// flood of distinct source addresses cannot grow it past one window's worth of
// clients (an ever-growing Map would be a slower version of the DoS this
// closes). No timer, no sweep, trivially testable with an injected clock.
export function createRateLimiter({ limits = {}, windowMs = 60_000, now = Date.now } = {}) {
  let windowStart = 0;
  let counts = new Map(); // `${bucket}|${rateKey}` -> hits this window
  return {
    /** @returns {number} 0 = allowed, else ms until the window resets */
    take(bucket, ip) {
      const limit = limits[bucket];
      if (!limit || limit <= 0) return 0; // 0/absent = unlimited
      const t = now();
      if (t - windowStart >= windowMs) { windowStart = t; counts = new Map(); }
      const key = `${bucket}|${rateKey(ip)}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n > limit ? windowStart + windowMs - t : 0;
    },
  };
}

// Which budget a request spends. MUST mirror the routing conditions in
// startServer exactly — a limited path that has drifted from a routed path is
// a hole. null = not limited (static assets, /api/config, /api/price-history:
// one cold page load pulls ~50 module/vendor files, and config/price-history
// are in-memory).
function rateBucket(req) {
  if (req.method === 'POST' && req.url === '/api/rpc') return 'rpc';
  if (req.method === 'POST' && req.url === '/api/faucet/claim') return 'faucet';
  if (req.method === 'GET' && req.url.startsWith('/api/indexer/')) return 'indexer';
  return null;
}

// ---- Bounded body read (#H4) ----
// Both proxies used to do `for await (…) raw += chunk` with no ceiling: one
// client streaming forever pinned the whole body in this process's heap.
// Returns null AFTER having answered 413 — callers must return immediately.
function readBody(req, res, limitBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      // Refuse before reading a byte. Nothing was consumed, so Node discards
      // the rest of the upload itself and the client still gets this answer.
      tooLarge(res, limitBytes);
      return resolve(null);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;               // BYTES — `raw += chunk` mis-counts
      if (size > limitBytes) {            // chunked, or a lying content-length
        done = true;
        // Stop reading and hang up once the 413 is flushed. Pause rather than
        // destroy: destroying mid-upload can reset the socket before the
        // response bytes leave, and the client then sees a network error
        // instead of the 413.
        req.pause();
        res.setHeader('connection', 'close');
        tooLarge(res, limitBytes);
        return resolve(null);
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    // Aborted upload: this used to reject the for-await and land in
    // startServer's catch, which then tried to sendJson on a dead socket.
    // Resolving null must never become a throw — a second sendJson on an
    // already-answered request is ERR_HTTP_HEADERS_SENT.
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
    // Belt-and-braces: 'close' always fires, so the promise always settles and
    // `chunks` is always released. A pending-forever read would pin the buffer
    // it holds — the very leak this function closes. Fires after 'end' on the
    // happy path, where `done` is already true.
    req.on('close', () => { if (!done) { done = true; resolve(null); } });
  });
}

function tooLarge(res, limitBytes) {
  sendJson(res, 413, { error: `request body too large (limit ${limitBytes} bytes)` });
}

async function handleRpc(req, res, { rpc, mockMode, guard, maxBodyBytes }) {
  const raw = await readBody(req, res, maxBodyBytes);
  if (raw === null) return;   // 413 already sent (or the client vanished)
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
  // Fail closed on a guarded deployment: EVERY method is refused while the
  // backend is cross-wired OR not yet confirmed — even reads would let the UI
  // render the wrong network's reality under this deployment's branding. The
  // guard's own probe keeps re-checking (5s until first confirmation), so a
  // recovering or fixed backend clears this without a restart.
  if (guard?.blocked()) {
    return sendJson(res, 503, { error: guard.describe(), mock: mockMode });
  }
  try {
    const result = mockMode ? mockResponse(method, params) : await callNode(rpc, method, params);
    if (method === 'getblockchaininfo' && result?.chain) guard?.seen(result.chain);
    sendJson(res, 200, { result, mock: mockMode });
  } catch (err) {
    // DELIBERATELY VERBATIM — do not genericize this one the way the indexer and
    // faucet proxies were. The node's reject string IS the answer: broadcastlog's
    // classifyBroadcastError string-matches its tokens (bad-txns-inputs-*,
    // txn-mempool-conflict, txn-already-in-mempool, the DigiDollar bad-dd-*
    // families) to decide reject vs already-broadcast vs ambiguous. Strip it and
    // every definite reject degrades to "this MAY have been broadcast", which
    // hands the user back the rebuild-and-send path onto the same coins.
    // Unlike the indexer's ElectrumX, this upstream is the node whose address the
    // caller can already read from /api/config (rpcUrl) — nothing new leaks.
    sendJson(res, 502, { error: String(err.message || err), mock: mockMode });
  }
}

// ---- Static caching: revalidate, never guess ----
// Responses used to carry content-type and nothing else. With no cache-control
// and no validator, a browser applies HEURISTIC freshness (RFC 9111 §4.2.2) and
// picks its own expiry — which is why phones kept running days-old app.js after
// a deploy while desktops looked fine. index.html has no cache-busting query on
// its script tags and deploy/Caddyfile is a bare reverse_proxy, so this is the
// only place that can fix it.
//
// `no-cache` does not mean "don't store": it means store, but revalidate before
// each use — so an unchanged file still costs one 304 and no body.
//
// The validator is a hash of the BYTES, not mtime. Docker COPY preserves
// build-context mtimes, so a rollback can hand a client an older file with a
// plausible last-modified and win the comparison; a content ETag makes a
// rollback revalidate correctly. Re-hashing per request adds no I/O — this
// function already re-reads the file every time.
const etagFor = (body) => `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

// A client may send several validators, and `*` matches anything it holds.
function ifNoneMatch(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return String(header).split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

async function serveFrom(baseDir, relPath, req, res) {
  const filePath = normalize(join(baseDir, relPath));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    // /vendor and /lib are NOT exempt: a vendor bump changes vendor.lock, and a
    // phone must never run a new app.js against stale vendored crypto.
    const revalidate = { 'cache-control': 'no-cache', etag: etagFor(body) };
    if (ifNoneMatch(req, revalidate.etag)) {
      res.writeHead(304, revalidate);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream', ...revalidate });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/lib/')) return serveFrom(LIB_DIR, urlPath.slice('/lib/'.length), req, res);
  if (urlPath.startsWith('/vendor/')) {
    const rel = urlPath.slice('/vendor/'.length);
    const pkg = VENDOR_PACKAGES.find((p) => rel.startsWith(p + '/'));
    if (!pkg) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return serveFrom(VENDOR_ROOTS[pkg], rel.slice(pkg.length + 1), req, res);
  }
  return serveFrom(PUBLIC_DIR, urlPath, req, res);
}

export function startServer(overrides = {}) {
  const vendorFileCount = verifyVendorIntegrity();
  const env = configFromEnv();
  const config = {
    ...env,
    ...overrides,
    rpc: { ...env.rpc, ...(overrides.rpc || {}) },
    // #H4 — same shallow-merge as rpc: overriding one budget must not drop the
    // others. 0 means unlimited here, so a dropped key silently DISABLES a
    // limit rather than failing loudly.
    rateLimit: { ...env.rateLimit, ...(overrides.rateLimit || {}) },
    maxBodyBytes: { ...env.maxBodyBytes, ...(overrides.maxBodyBytes || {}) },
  };
  const mockMode = !config.rpc.user || !config.rpc.pass;
  const limiter = createRateLimiter({
    limits: { rpc: config.rateLimit.rpc, indexer: config.rateLimit.indexer, faucet: config.rateLimit.faucet },
    windowMs: config.rateLimit.windowMs,
    now: config.now, // tests drive the window without sleeping; undefined → Date.now
  });
  // #M3 — built per server, not folded into the module-level SECURITY_HEADERS:
  // several instances share this process (the test file starts many) and HSTS
  // is a per-deployment decision.
  const responseHeaders = config.hsts
    ? { ...SECURITY_HEADERS, 'strict-transport-security': HSTS_VALUE }
    : SECURITY_HEADERS;

  let priceSeries = [];
  let guard = null;
  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(responseHeaders)) res.setHeader(k, v);
    try {
      // #H4 — rate limit FIRST: before any body is read, before the cross-wire
      // guard, before any upstream fetch. A limiter that runs after the
      // expensive work is decoration.
      const bucket = rateBucket(req);
      if (bucket) {
        const waitMs = limiter.take(bucket, clientIp(req, config.trustProxy));
        if (waitMs > 0) {
          const secs = Math.ceil(waitMs / 1000);
          res.setHeader('retry-after', String(secs));
          return sendJson(res, 429, {
            error: `too many requests — this server limits how often one client may call ${bucket === 'indexer' ? 'the balance index' : bucket === 'faucet' ? 'the Faucet' : 'the node'}; retry in ${secs}s`,
            retryAfterMs: waitMs,
          });
        }
      }
      if (req.method === 'POST' && req.url === '/api/rpc') return await handleRpc(req, res, { rpc: config.rpc, mockMode, guard, maxBodyBytes: config.maxBodyBytes.rpc });
      // the explicit maxBodyBytes after the spread is deliberate — the spread
      // would otherwise hand the handler the whole {rpc, faucet} object
      if (req.method === 'POST' && req.url === '/api/faucet/claim') return await handleFaucetClaim(req, res, { ...config, guard, maxBodyBytes: config.maxBodyBytes.faucet });
      if (req.method === 'GET' && req.url.startsWith('/api/indexer/')) return await handleIndexer(req, res, { ...config, guard });
      // The stablecoin flows (mint/transfer/redeem) ship unconditionally as one
      // unit (ADR-0002, release gate #17) — no feature flag in the config.
      if (req.method === 'GET' && req.url === '/api/price-history') {
        return sendJson(res, 200, { series: mockMode ? syntheticPriceSeries() : priceSeries, mock: mockMode });
      }
      if (req.url === '/api/config') {
        return sendJson(res, 200, {
          version: APP_VERSION,
          mock: mockMode,
          rpcUrl: mockMode ? null : config.rpc.url,
          faucet: Boolean(config.faucetUrl),
          indexer: Boolean(config.indexerUrl),
          explorerTxUrl: config.explorerTxUrl,
          // cross-wire guard (#64): the UI renders a blocking error on mismatch
          expectedChain: config.expectedChain || null,
          chain: guard?.actual ?? null,
          chainMismatch: Boolean(guard?.mismatch()),
        });
      }
      if (req.method === 'GET') return await serveStatic(req, res);
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      // Last-resort catch: whatever threw here was NOT handled deliberately, so
      // its message is unbounded — a filesystem path, a stack-shaped string, an
      // upstream body. Log it, answer a fixed line. That line names the actor,
      // because it reaches the user verbatim through fetchIndexer → busy() and
      // can land in #w-send-err mid-review; `internal error` was status-speak.
      // No "nothing was sent" reassurance: this also wraps /api/rpc, so it
      // cannot claim a broadcast failed to reach the node.
      console.error('wallet:', err);
      sendJson(res, 500, { error: 'the wallet server hit an unexpected error', cause: 'internal' });
    }
  });

  if (!mockMode) {
    guard = startChainGuard({ rpc: config.rpc, expectedChain: config.expectedChain }, server);
    priceSeries = startPriceSampler({ rpc: config.rpc, ...(config.priceHistory || {}), guard }, server);
  }

  server.listen(config.port, config.bindHost, () => {
    const { port } = server.address();
    console.log(`\n  Diginaut · DigiDollar wallet ${APP_VERSION}`);
    console.log(`  → http://localhost:${port} (bind ${config.bindHost})`);
    console.log(`  mode: ${mockMode ? 'MOCK (set DGB_RPC_USER/DGB_RPC_PASS for a real node)' : `REAL node @ ${config.rpc.url}`}`);
    console.log(`  vendor: ${vendorFileCount} files verified against vendor.lock\n`);
  });
  return server;
}

// Auto-start only when run directly (node server.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
