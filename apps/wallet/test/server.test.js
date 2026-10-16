import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startServer, importmapCspHash } from '../server.js';
// The wallet's broadcast classifier keys off these refusals' COPY (they are the
// only refusals it cannot detect structurally). Importing it here ties the two
// sides together: a reworded 413/429 fails this file, not a user's send.
import { classifyBroadcastError } from '../public/broadcastlog.js';

async function withServer(fn) {
  const server = startServer({ port: 0 }); // mock mode: no RPC creds passed
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('serves the wallet UI', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /DigiDollar/);
  });
});

test('sets a strict Content-Security-Policy and hardening headers on every response (#55)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header present');
    assert.match(csp, /script-src 'self' 'sha256-/); // inline importmap hashed
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/); // scripts never unsafe-inline → inline handlers blocked
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    // #M3: HSTS is opt-in (HSTS=1) — pinned here so the default can never flip
    // silently and poison a developer's http://localhost origin.
    assert.equal(res.headers.get('strict-transport-security'), null);
  });
});

test('the CSP script-src hash matches the inline importmap in index.html — no silent drift (#55)', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const inner = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = `'sha256-${createHash('sha256').update(inner).digest('base64')}'`;
  await withServer(async (base) => {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy');
    assert.ok(csp.includes(hash), `CSP must carry the current importmap hash ${hash}`);
  });
});

// The drift test above recomputes the hash with the SAME expression the server
// uses, so both sides move together and it is structurally incapable of failing
// on a CRLF checkout. This one feeds the function bytes directly (#L7).
test('the importmap CSP hash is CRLF-invariant — a Windows checkout still boots (#L7)', () => {
  const lf = '<script type="importmap">\n{ "imports": {} }\n</script>';
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');
  assert.equal(importmapCspHash(crlf), importmapCspHash(lf));
  assert.equal(importmapCspHash(cr), importmapCspHash(lf));
});

test('proxies allow-listed read RPCs (mock mode)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo' }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.mock, true);
    assert.ok(json.result.blocks > 0);
  });
});

test('allows broadcasting a client-signed raw transaction (issue #6)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sendrawtransaction', params: ['02000000' + '00'.repeat(60)] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.match(json.result, /^[0-9a-f]{64}$/); // mock echoes a txid
  });
});

test('stablecoin flows ship unconditionally — no mint feature flag in config (#17, ADR-0002)', async () => {
  await withServer(async (base) => {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal('mint' in cfg, false); // mint/transfer/redeem are always on, together
  });
});

test('refuses fund-moving RPCs at the proxy', async () => {
  await withServer(async (base) => {
    for (const method of ['mintdigidollartaproot', 'redeemdigidollar', 'sendtoaddress']) {
      const res = await fetch(base + '/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      assert.equal(res.status, 403, `${method} must be blocked`);
    }
  });
});

test('refuses getnewdigidollaraddress — addresses are derived client-side now (#3)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getnewdigidollaraddress' }),
    });
    assert.equal(res.status, 403);
  });
});

test('serves crypto deps under /vendor/ for the browser import map', async () => {
  await withServer(async (base) => {
    for (const path of [
      '/vendor/@scure/bip39/index.js',
      '/vendor/@scure/bip39/wordlists/english.js',
      '/vendor/@scure/bip32/index.js',
      '/vendor/@noble/curves/secp256k1.js',
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /javascript/, path);
    }
    // no directory escape
    const evil = await fetch(base + '/vendor/..%2f..%2fserver.js');
    assert.notEqual(evil.status, 200);
  });
});

// ---- Static assets revalidate before use ----
// With no cache-control and no validator, browsers pick their own expiry
// (heuristic freshness) — which is how phones ended up running days-old app.js
// after a deploy. /vendor and /lib are covered too: a vendor bump changes
// vendor.lock, and new app.js against stale vendored crypto is the bad case.
const STATIC_PATHS = ['/', '/app.js', '/lib/index.js', '/vendor/@noble/curves/secp256k1.js'];

test('every static path carries cache-control: no-cache and a strong ETag', async () => {
  await withServer(async (base) => {
    for (const path of STATIC_PATHS) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-cache', path);
      assert.match(res.headers.get('etag') ?? '', /^"[\w-]+"$/, `${path} has a strong ETag`);
      await res.arrayBuffer();
    }
  });
});

test('if-none-match with the current ETag → 304 and no body; a stale one → 200', async () => {
  await withServer(async (base) => {
    for (const path of STATIC_PATHS) {
      const first = await fetch(base + path);
      const etag = first.headers.get('etag');
      const bytes = (await first.arrayBuffer()).byteLength;
      assert.ok(bytes > 0, `${path} served a body`);

      const revalidated = await fetch(base + path, { headers: { 'if-none-match': etag } });
      assert.equal(revalidated.status, 304, path);
      assert.equal(revalidated.headers.get('etag'), etag, path);
      assert.equal(revalidated.headers.get('cache-control'), 'no-cache', path);
      assert.equal((await revalidated.arrayBuffer()).byteLength, 0, `${path} 304 carries no body`);
      // a redeploy changes the bytes, so the client's held tag stops matching
      const stale = await fetch(base + path, { headers: { 'if-none-match': '"not-the-current-one"' } });
      assert.equal(stale.status, 200, path);
      assert.equal((await stale.arrayBuffer()).byteLength, bytes, path);
    }
  });
});

test('the ETag is derived from the bytes, not the path or mtime', async () => {
  await withServer(async (base) => {
    const tags = [];
    for (const path of ['/index.html', '/app.js', '/vault.js']) {
      const res = await fetch(base + path);
      tags.push(res.headers.get('etag'));
      await res.arrayBuffer();
    }
    assert.equal(new Set(tags).size, tags.length, 'different files, different ETags');
    // the same file twice is byte-identical, so the tag is stable
    const a = await fetch(base + '/app.js'); await a.arrayBuffer();
    const b = await fetch(base + '/app.js'); await b.arrayBuffer();
    assert.equal(a.headers.get('etag'), b.headers.get('etag'));
  });
});

// The other half of the same finding: static content going stale is a bad
// deploy, an API answer going stale is money. These carry no validator, so
// there is nothing to revalidate against — they must not be stored at all.
test('every API answer is no-store, success and failure alike', async () => {
  const { createServer } = await import('node:http');
  const indexer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ address: 'x', utxos: [] }));
  });
  await new Promise((r) => indexer.listen(0, r));
  try {
    await withConfiguredServer({ indexerUrl: `http://127.0.0.1:${indexer.address().port}` }, async (base) => {
      const paths = [
        '/api/config', // stale here can serve chainMismatch:false after a cross-wire (#64)
        '/api/price-history',
        '/api/indexer/address/dgbrt1qfoo/utxos', // stale here feeds coin selection spent coins
        '/api/indexer/tx/nothex', // a refusal is as cacheable as an answer
      ];
      for (const path of paths) {
        const res = await fetch(base + path);
        assert.equal(res.headers.get('cache-control'), 'no-store', `${path} (status ${res.status})`);
        await res.arrayBuffer();
      }
      // the POST routes answer through the same seam
      const claim = await fetch(base + '/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'dgbrt1qfoo' }),
      });
      assert.equal(claim.headers.get('cache-control'), 'no-store', `/api/faucet/claim (status ${claim.status})`);
      await claim.arrayBuffer();
    });
  } finally {
    indexer.close();
  }
});

test('a 304 keeps the hardening headers — writeHead must not drop them (#55)', async () => {
  await withServer(async (base) => {
    const first = await fetch(base + '/app.js');
    await first.arrayBuffer();
    const res = await fetch(base + '/app.js', { headers: { 'if-none-match': first.headers.get('etag') } });
    assert.equal(res.status, 304);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self' 'sha256-/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('wallet HTML hardcodes no network banner — chrome is set at runtime from the node chain (#61)', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /TESTNET ONLY/);
    assert.doesNotMatch(html, /<title>[^<]*testnet/i);
    assert.match(html, /id="net-banner"/);
  });
});

test('proxies faucet claims to FAUCET_URL and reports faucet availability in config', async () => {
  // stub faucet
  const { createServer } = await import('node:http');
  const hits = [];
  const faucet = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    hits.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ txid: 'a'.repeat(64), amountDgb: 12345 }));
  });
  await new Promise((r) => faucet.listen(0, r));
  const faucetUrl = `http://127.0.0.1:${faucet.address().port}`;

  const server = startServer({ port: 0, faucetUrl });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.faucet, true);

    const res = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dgbrt1q...' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).txid, 'a'.repeat(64));
    assert.deepEqual(hits[0], { url: '/api/claim', body: { address: 'dgbrt1q...' } });
  } finally {
    server.close();
    faucet.close();
  }
});

test('faucet claim without FAUCET_URL configured → 503', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'x' }),
    });
    assert.equal(res.status, 503);
  });
});

test('proxies indexer GETs to INDEXER_URL and reports availability in config', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  const indexer = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ address: 'x', utxos: [] }));
  });
  await new Promise((r) => indexer.listen(0, r));
  const server = startServer({ port: 0, indexerUrl: `http://127.0.0.1:${indexer.address().port}` });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(base + '/api/config')).json()).indexer, true);
    const res = await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos');
    assert.equal(res.status, 200);
    // DigiDollar positions (#13) and dd-utxos (#15) go through the same seam
    assert.equal((await fetch(base + '/api/indexer/address/dgbrt1qfoo/positions')).status, 200);
    assert.equal((await fetch(base + '/api/indexer/address/dgbrt1qfoo/dd-utxos')).status, 200);
    // per-tx history enrichment (#69) — /tx/<64-hex> is on the allow-list
    assert.equal((await fetch(base + `/api/indexer/tx/${'ab'.repeat(32)}`)).status, 200);
    assert.deepEqual(hits, ['/api/address/dgbrt1qfoo/utxos', '/api/address/dgbrt1qfoo/positions', '/api/address/dgbrt1qfoo/dd-utxos', `/api/tx/${'ab'.repeat(32)}`]);
    // anything outside the allow-list is not forwarded
    assert.equal((await fetch(base + '/api/indexer/../evil')).status, 404);
    assert.equal((await fetch(base + '/api/indexer/tx/nothex')).status, 404);
  } finally {
    server.close();
    indexer.close();
  }
});

test('indexer queries without INDEXER_URL → 503; config says indexer: false', async () => {
  await withServer(async (base) => {
    assert.equal((await (await fetch(base + '/api/config')).json()).indexer, false);
    assert.equal((await fetch(base + '/api/indexer/address/a/utxos')).status, 503);
  });
});

test('stale spec-era oracle RPC names are gone; real ones are allowed with real-shaped mocks', async () => {
  await withServer(async (base) => {
    for (const stale of ['getoraclestatus', 'listoracles', 'listredemptionpaths', 'getdigidollarspendinfo']) {
      const res = await fetch(base + '/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: stale }),
      });
      assert.equal(res.status, 403, stale + ' must be gone');
    }
    const price = await (await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getoracleprice' }),
    })).json();
    assert.ok(price.result.price_micro_usd > 0);
    assert.equal(price.result.is_stale, false);
    const oracles = await (await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getoracles' }),
    })).json();
    assert.ok(Array.isArray(oracles.result) && oracles.result[0].total_oracle_slots > 0);
  });
});

test('mock mode serves a synthetic 24h price history for the chart', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/price-history');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.mock, true);
    assert.ok(Array.isArray(json.series) && json.series.length >= 100, 'a day of points');
    const now = Math.floor(Date.now() / 1000);
    const first = json.series[0];
    const last = json.series[json.series.length - 1];
    assert.ok(now - first.t >= 23 * 3600, 'spans ~24h back');
    assert.ok(Math.abs(last.t - now) < 3600, 'ends near now');
    for (let i = 1; i < json.series.length; i++) {
      assert.ok(json.series[i].t > json.series[i - 1].t, 'timestamps ascend');
    }
    for (const p of json.series) {
      assert.ok(p.price_micro_usd > 0, 'plausible positive price');
    }
  });
});

test('real mode samples getoracleprice on an interval and serves the series', async () => {
  let price = 13_000;
  const node = await stubNode('test', () => (price += 10));
  await new Promise((r) => node.listen(0, r));
  const server = startServer({
    port: 0,
    rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
    priceHistory: { intervalMs: 50 },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await new Promise((r) => setTimeout(r, 300));
    const json = await (await fetch(base + '/api/price-history')).json();
    assert.equal(json.mock, false);
    assert.ok(json.series.length >= 2, `sampled repeatedly, got ${json.series.length}`);
    const prices = json.series.map((p) => p.price_micro_usd);
    assert.ok(prices.every((v) => v > 13_000), 'prices came from the node');
    assert.ok(prices[prices.length - 1] > prices[0], 'successive samples recorded');
  } finally {
    server.close();
    node.close();
  }
});

test('price history survives a server restart via the persist file', async () => {
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataFile = join(tmpdir(), `price-history-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const node = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: JSON.parse(raw).id, result: { price_micro_usd: 13_420, is_stale: false } }));
  });
  await new Promise((r) => node.listen(0, r));
  const rpc = { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' };

  const first = startServer({ port: 0, rpc, priceHistory: { intervalMs: 50, dataFile } });
  await once(first, 'listening');
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  let sampled;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    sampled = (await (await fetch(firstBase + '/api/price-history')).json()).series;
    if (sampled.length >= 3) break;
  }
  assert.ok(sampled.length >= 3, 'first server sampled some points');
  await new Promise((r) => setTimeout(r, 120)); // let the persist write flush
  first.close();
  await once(first, 'close');

  // second server, long interval: only its own single startup sample is new,
  // so extra points right after start can only have been loaded from disk
  const second = startServer({ port: 0, rpc, priceHistory: { intervalMs: 3_600_000, dataFile } });
  await once(second, 'listening');
  try {
    const json = await (await fetch(`http://127.0.0.1:${second.address().port}/api/price-history`)).json();
    assert.ok(json.series.length >= 3, `restored from disk: got ${json.series.length} points right after start`);
  } finally {
    second.close();
    node.close();
    (await import('node:fs')).unlinkSync(dataFile);
  }
});

test('price history is a 24h window — older points are pruned', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const dataFile = join(tmpdir(), `price-history-prune-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const now = Math.floor(Date.now() / 1000);
  const stale = { t: now - 25 * 3600, price_micro_usd: 11_111 };
  const fresh = { t: now - 3600, price_micro_usd: 13_400 };
  writeFileSync(dataFile, JSON.stringify([stale, fresh]));

  // unreachable node: no new samples; whatever is served came from the file
  const server = startServer({
    port: 0,
    rpc: { url: 'http://127.0.0.1:1', user: 'u', pass: 'p' },
    priceHistory: { intervalMs: 3_600_000, dataFile },
  });
  await once(server, 'listening');
  try {
    const json = await (await fetch(`http://127.0.0.1:${server.address().port}/api/price-history`)).json();
    assert.deepEqual(json.series, [fresh], 'stale point pruned, fresh point kept');
  } finally {
    server.close();
    unlinkSync(dataFile);
  }
});

test('config exposes the block-explorer tx prefix so the UI can link txids', async () => {
  const server = startServer({ port: 0, explorerTxUrl: 'https://testnet-explorer.example/tx/' });
  await once(server, 'listening');
  try {
    const cfg = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
    assert.equal(cfg.explorerTxUrl, 'https://testnet-explorer.example/tx/');
  } finally {
    server.close();
  }
  await withServer(async (base) => {
    assert.equal((await (await fetch(base + '/api/config')).json()).explorerTxUrl, '', 'unset by default');
  });
});

// ---- Honest quotes (#62): DCA multiplier + protection status, read-only ----

test('proxies getdcamultiplier — mock mirrors the real RPC shape (#62)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getdcamultiplier' }),
    });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(typeof result.multiplier, 'number');
    assert.equal(typeof result.system_health, 'number');
    assert.match(result.tier_status, /^(healthy|warning|critical|emergency)$/);
    assert.equal(typeof result.description, 'string');
  });
});

test('mock getdcamultiplier honors the optional health param with Core tier math', async () => {
  await withServer(async (base) => {
    const at = async (health) => {
      const res = await fetch(base + '/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'getdcamultiplier', params: [health] }),
      });
      return (await res.json()).result;
    };
    // Core dca.cpp HEALTH_TIERS bands
    assert.deepEqual([(await at(150)).multiplier, (await at(150)).tier_status], [1.0, 'healthy']);
    assert.deepEqual([(await at(130)).multiplier, (await at(130)).tier_status], [1.25, 'warning']);
    assert.deepEqual([(await at(115)).multiplier, (await at(115)).tier_status], [1.5, 'critical']);
    assert.deepEqual([(await at(90)).multiplier, (await at(90)).tier_status], [2.0, 'emergency']);
  });
});

test('proxies getprotectionstatus — mock has the freeze flags the mint gate reads (#62)', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getprotectionstatus' }),
    });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(typeof result.volatility.minting_restricted, 'boolean');
    assert.equal(typeof result.oracle.minting_restricted, 'boolean');
    assert.equal(typeof result.dca.current_multiplier, 'number');
  });
});

test('the #62 whitelist extension added no fund-moving RPC', async () => {
  await withServer(async (base) => {
    for (const method of ['mintdigidollar', 'senddigidollar', 'sendmanydigidollar', 'redeemdigidollar', 'walletpassphrase']) {
      const res = await fetch(base + '/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      assert.equal(res.status, 403, `${method} must stay blocked`);
    }
  });
});

// ---- cross-wire guard (#64): a mainnet deployment backed by a testnet node
// (or vice versa) must fail loudly and closed, not serve the wrong network ----

// `price` may be a number or a function (per-call values, e.g. an increasing
// series for the sampler test). Only the two methods the server's background
// loops use are answered — anything else is a test bug.
async function stubNode(chain, price = 13_420) {
  const { createServer } = await import('node:http');
  return createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { method, id } = JSON.parse(raw);
    assert.ok(['getoracleprice', 'getblockchaininfo'].includes(method), `unexpected method ${method}`);
    const result = method === 'getblockchaininfo'
      ? { chain, blocks: 100, headers: 100, initialblockdownload: false }
      : { price_micro_usd: typeof price === 'function' ? price() : price, is_stale: false };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, result }));
  });
}

// wait for the chain guard's boot probe to learn the node's chain
async function waitForChain(base) {
  let cfg;
  for (let i = 0; i < 40; i++) {
    cfg = await (await fetch(base + '/api/config')).json();
    if (cfg.chain) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cfg;
}

test('cross-wired backend: RPC refused, config flags it, price history stays clean', async () => {
  const node = await stubNode('test'); // the node is testnet…
  await new Promise((r) => node.listen(0, r));
  const server = startServer({
    port: 0,
    rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
    expectedChain: 'main', // …but this deployment claims mainnet
    priceHistory: { intervalMs: 50 },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await waitForChain(base);
    assert.equal(cfg.expectedChain, 'main');
    assert.equal(cfg.chain, 'test');
    assert.equal(cfg.chainMismatch, true, '/api/config flags the cross-wire');

    // EVERY rpc method is refused — reads included
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo', params: [] }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /refusing to serve/);
    assert.match(body.error, /expects chain "main"/);
    assert.match(body.error, /reports "test"/);

    // the sampler recorded nothing from the wrong chain (boot sample included)
    await new Promise((r) => setTimeout(r, 200));
    const hist = await (await fetch(base + '/api/price-history')).json();
    assert.equal(hist.series.length, 0, 'no wrong-chain prices in the history');
  } finally {
    server.close();
    node.close();
  }
});

test('matching backend: guard passes RPC and sampling through', async () => {
  const node = await stubNode('main');
  await new Promise((r) => node.listen(0, r));
  const server = startServer({
    port: 0,
    rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
    expectedChain: 'main',
    priceHistory: { intervalMs: 50 },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await waitForChain(base);
    assert.equal(cfg.chainMismatch, false);
    assert.equal(cfg.chain, 'main');

    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo', params: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.chain, 'main');

    // sampling flows once the chain is confirmed
    let hist;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      hist = await (await fetch(base + '/api/price-history')).json();
      if (hist.series.length >= 2) break;
    }
    assert.ok(hist.series.length >= 2, `sampler runs with a matching guard (got ${hist.series.length})`);
  } finally {
    server.close();
    node.close();
  }
});

test('no EXPECTED_CHAIN set: guard is inert (single-net deployments unchanged)', async () => {
  const node = await stubNode('test');
  await new Promise((r) => node.listen(0, r));
  const server = startServer({
    port: 0,
    rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo', params: [] }),
    });
    assert.equal(res.status, 200, 'rpc flows with no guard configured');
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.expectedChain, null);
    assert.equal(cfg.chainMismatch, false);
  } finally {
    server.close();
    node.close();
  }
});

test('guarded deployment is fail-closed BEFORE the chain is confirmed (node down at boot)', async () => {
  // no node listening at all — the guard can never confirm the chain
  const server = startServer({
    port: 0,
    rpc: { url: 'http://127.0.0.1:1', user: 'u', pass: 'p' },
    expectedChain: 'main',
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getblockchaininfo', params: [] }),
    });
    assert.equal(res.status, 503, 'rpc held until the chain is confirmed');
    assert.match((await res.json()).error, /not yet confirmed/);
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.chainMismatch, false, 'down is not reported as cross-wired');
    assert.equal(cfg.chain, null);
  } finally {
    server.close();
  }
});

test('cross-wired backend: indexer and faucet proxies are refused too', async () => {
  const node = await stubNode('test');
  await new Promise((r) => node.listen(0, r));
  const server = startServer({
    port: 0,
    rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
    expectedChain: 'main',
    indexerUrl: 'http://127.0.0.1:1', // must never be contacted
    faucetUrl: 'http://127.0.0.1:1',
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitForChain(base);
    const idx = await fetch(base + `/api/indexer/tx/${'0'.repeat(64)}`);
    assert.equal(idx.status, 503);
    assert.match((await idx.json()).error, /refusing to serve/);
    const claim = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'x' }),
    });
    assert.equal(claim.status, 503);
    assert.match((await claim.json()).error, /refusing to serve/);
  } finally {
    server.close();
    node.close();
  }
});

test('config reports the build version (semver + commit stamp)', async () => {
  await withServer(async (base) => {
    const cfg = await (await fetch(base + '/api/config')).json();
    // working tree: git supplies "<sha> <date>"; archive: export-subst; else "dev"
    assert.match(cfg.version, /^v\d+\.\d+\.\d+\+\S/);
  });
});

// ---- H4: body caps + per-IP rate limits on the proxy ----
// Every test starts its own server, so limiter state never crosses tests.

// start a server with overrides and hand the test its base URL
async function withConfiguredServer(overrides, fn) {
  const server = startServer({ port: 0, ...overrides });
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const postRpc = (base, body, headers = {}) => fetch(base + '/api/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('refuses an oversized RPC body with 413 (#H4)', async () => {
  await withConfiguredServer({ maxBodyBytes: { rpc: 64 } }, async (base) => {
    const big = await postRpc(base, { method: 'sendrawtransaction', params: ['ab'.repeat(200)] });
    assert.equal(big.status, 413);
    const refusal = (await big.json()).error;
    assert.match(refusal, /too large/);
    // this server answered before the node saw anything, so the wallet must
    // read it as a definite reject — never "it MAY already have been broadcast"
    assert.equal(classifyBroadcastError(new Error(refusal)).kind, 'reject');
    // the same endpoint still works under the cap — the merge kept the other budgets
    const ok = await postRpc(base, { method: 'getblockchaininfo' });
    assert.equal(ok.status, 200);
  });
});

test('counts BYTES while streaming — a chunked body with no content-length still 413s (#H4)', async () => {
  await withConfiguredServer({ maxBodyBytes: { rpc: 64 } }, async (base) => {
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(64)));
        c.close();
      },
    });
    const res = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half', // Node 22 requires this for a stream body
    });
    assert.equal(res.status, 413);
  });
});

test('the faucet body cap runs BEFORE the upstream call (#H4)', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  const faucet = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    hits.push({ url: req.url, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ txid: 'a'.repeat(64) }));
  });
  await new Promise((r) => faucet.listen(0, r));
  const faucetUrl = `http://127.0.0.1:${faucet.address().port}`;
  try {
    await withConfiguredServer({ faucetUrl, maxBodyBytes: { faucet: 32 } }, async (base) => {
      const res = await fetch(base + '/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'dgbrt1q' + 'z'.repeat(180) }),
      });
      assert.equal(res.status, 413);
      assert.equal(hits.length, 0, 'nothing was forwarded to the Faucet');
    });
  } finally {
    faucet.close();
  }
});

test('spends the RPC budget then answers 429 with retry-after (#H4)', async () => {
  await withConfiguredServer({ rateLimit: { rpc: 3 } }, async (base) => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 200, `call ${i + 1}`);
    }
    const limited = await postRpc(base, { method: 'getblockchaininfo' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0, 'retry-after seconds');
    const body = await limited.json();
    assert.ok(body.retryAfterMs > 0);
    assert.match(body.error, /too many requests/);
    // same contract as the 413: the limiter runs before any upstream fetch
    assert.equal(classifyBroadcastError(new Error(body.error)).kind, 'reject');
  });
});

test('budgets are per-bucket; static, config and price-history are never limited (#H4)', async () => {
  const { createServer } = await import('node:http');
  const indexer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ address: 'x', utxos: [] }));
  });
  await new Promise((r) => indexer.listen(0, r));
  const indexerUrl = `http://127.0.0.1:${indexer.address().port}`;
  try {
    await withConfiguredServer({ rateLimit: { rpc: 1 }, indexerUrl }, async (base) => {
      assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 200);
      assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 429);
      // a spent RPC budget must not touch the other routes
      assert.equal((await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos')).status, 200);
      assert.equal((await fetch(base + '/api/config')).status, 200);
      assert.equal((await fetch(base + '/api/price-history')).status, 200);
      assert.equal((await fetch(base + '/')).status, 200); // a cold page load pulls ~50 files
    });
  } finally {
    indexer.close();
  }
});

test('the fixed window rolls over and refills the budget (#H4)', async () => {
  let t = 1_000_000;
  await withConfiguredServer({ now: () => t, rateLimit: { rpc: 1 } }, async (base) => {
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 200);
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 429);
    t += 60_000; // next window
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 200);
  });
});

test('a budget of 0 is unlimited — the escape hatch the CDP drivers use (#H4)', async () => {
  await withConfiguredServer({ rateLimit: { rpc: 0 } }, async (base) => {
    for (let i = 0; i < 25; i++) {
      assert.equal((await postRpc(base, { method: 'getblockchaininfo' })).status, 200, `call ${i + 1}`);
    }
  });
});

test('x-forwarded-for is ignored unless TRUST_PROXY, and then the LAST element wins (#H4)', async () => {
  // untrusted: a forged header must not mint a fresh budget per request
  await withConfiguredServer({ rateLimit: { rpc: 1 } }, async (base) => {
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' }, { 'x-forwarded-for': '1.1.1.1' })).status, 200);
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' }, { 'x-forwarded-for': '2.2.2.2' })).status, 429);
  });
  // trusted: Caddy APPENDS the peer it saw, so only the last element is real
  await withConfiguredServer({ trustProxy: true, rateLimit: { rpc: 1 } }, async (base) => {
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' }, { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })).status, 200);
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' }, { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' })).status, 429);
    // same spoofable left element, different real peer → its own budget
    assert.equal((await postRpc(base, { method: 'getblockchaininfo' }, { 'x-forwarded-for': '9.9.9.9, 5.6.7.8' })).status, 200);
  });
});

test('the faucet proxy forwards the resolved client address, not the proxy socket (#H4)', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const faucet = createServer(async (req, res) => {
    for await (const _c of req) { /* drain */ }
    seen.push(req.headers['x-forwarded-for']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ txid: 'a'.repeat(64) }));
  });
  await new Promise((r) => faucet.listen(0, r));
  const faucetUrl = `http://127.0.0.1:${faucet.address().port}`;
  try {
    await withConfiguredServer({ faucetUrl, trustProxy: true }, async (base) => {
      const res = await fetch(base + '/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
        body: JSON.stringify({ address: 'dgbrt1q...' }),
      });
      assert.equal(res.status, 200);
      // the Faucet keys its 24h cooldown off the FIRST element it receives, so
      // exactly one address must arrive — and it must be the real peer
      assert.deepEqual(seen, ['1.2.3.4']);
    });
  } finally {
    faucet.close();
  }
});

test('a 429 costs the upstream nothing (#H4)', async () => {
  const { createServer } = await import('node:http');
  const hits = [];
  const indexer = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ address: 'x', utxos: [] }));
  });
  await new Promise((r) => indexer.listen(0, r));
  const indexerUrl = `http://127.0.0.1:${indexer.address().port}`;
  try {
    await withConfiguredServer({ rateLimit: { indexer: 1 }, indexerUrl }, async (base) => {
      assert.equal((await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos')).status, 200);
      const limited = await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos');
      assert.equal(limited.status, 429);
      assert.match((await limited.json()).error, /balance index/); // CONTEXT.md-free UI wording
      assert.equal(hits.length, 1, 'the limiter ran before the upstream fetch');
    });
  } finally {
    indexer.close();
  }
});

// ---- M3: HSTS on TLS deployments ----

test('no HSTS by default — the wallet also runs on plain-http localhost (#M3)', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + '/')).headers.get('strict-transport-security'), null);
    assert.equal((await fetch(base + '/api/config')).headers.get('strict-transport-security'), null);
  });
});

test('HSTS=1 adds Strict-Transport-Security to every response (#M3)', async () => {
  await withConfiguredServer({ hsts: true }, async (base) => {
    const expected = 'max-age=15552000; includeSubDomains';
    assert.equal((await fetch(base + '/')).headers.get('strict-transport-security'), expected, 'static');
    assert.equal((await fetch(base + '/api/config')).headers.get('strict-transport-security'), expected, 'json');
    // and on an error response — sendJson()'s writeHead must not drop it
    const denied = await postRpc(base, { method: 'sendtoaddress' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('strict-transport-security'), expected, '4xx');
    // no preload: that is an irreversible browser-vendor-list commitment
    assert.doesNotMatch(expected, /preload/);
    // the existing hardening headers are untouched
    assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  });
});

test('HSTS is per-server, not process-global — one instance must not leak into another (#M3)', async () => {
  const tls = startServer({ port: 0, hsts: true });
  const plain = startServer({ port: 0 });
  await Promise.all([once(tls, 'listening'), once(plain, 'listening')]);
  try {
    const tlsRes = await fetch(`http://127.0.0.1:${tls.address().port}/`);
    const plainRes = await fetch(`http://127.0.0.1:${plain.address().port}/`);
    assert.equal(tlsRes.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains');
    assert.equal(plainRes.headers.get('strict-transport-security'), null);
  } finally {
    tls.close();
    plain.close();
  }
});

// This proxy fronts the node's RPC surface, so a bare `node server.js` on a box
// with an open port must not publish it. Public deployments put a TLS
// terminator in front and the container opts back in with BIND_HOST.
test('binds loopback by default; a container opts back in with BIND_HOST', async () => {
  for (const [bindHost, expected] of [[undefined, '127.0.0.1'], ['0.0.0.0', '0.0.0.0']]) {
    const server = startServer({ port: 0, ...(bindHost ? { bindHost } : {}) });
    await once(server, 'listening');
    try {
      assert.equal(server.address().address, expected, `BIND_HOST=${bindHost ?? '(unset)'}`);
    } finally {
      server.close();
    }
  }
});

// ---- A proxy failure names no backend ----
// Both proxies used to answer `<peer> unreachable: ${err.message}`, printing the
// configured INDEXER_URL / FAUCET_URL host:port (and the OS error) to any
// caller — a map of an otherwise-unpublished internal network.
const NO_BACKEND_TRACE = /127\.0\.0\.1|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|:\d{4,5}/;

test('an unreachable indexer answers a fixed body — never the upstream address', async () => {
  await withConfiguredServer({ indexerUrl: 'http://127.0.0.1:1' }, async (base) => {
    const res = await fetch(base + '/api/indexer/address/dgbrt1qfoo/utxos');
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'the balance index is unavailable', cause: 'indexer-unreachable' });
    assert.doesNotMatch(text, NO_BACKEND_TRACE);
  });
});

// ---- The indexer's verdict survives the proxy hop ----
// The browser never talks to the indexer directly, so `cause` is only a contract
// if this hop forwards it untouched. The recovery card turns `tx-not-found` into
// "it never reached the network — Rebroadcast is safe" and everything else into
// "keep the record": a proxy that dropped or rewrote the token would silently
// swap one for the other, and the server-side tests could not see it.
test('an indexer {error, cause} reaches the browser byte-identical, 502 and 404 alike', async () => {
  const { createServer } = await import('node:http');
  const ANSWERS = {
    [`/api/tx/${'0'.repeat(64)}`]: [404, { error: 'not found', cause: 'tx-not-found' }],
    [`/api/tx/${'1'.repeat(64)}`]: [502, { error: 'the balance index is unavailable', cause: 'upstream-error' }],
    ['/api/address/dgbrt1qfoo/utxos']: [500, { error: 'the balance index hit an unexpected error', cause: 'internal' }],
  };
  const indexer = createServer((req, res) => {
    const [status, body] = ANSWERS[req.url];
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  });
  await new Promise((r) => indexer.listen(0, r));
  try {
    await withConfiguredServer({ indexerUrl: `http://127.0.0.1:${indexer.address().port}` }, async (base) => {
      for (const [path, [status, body]] of Object.entries(ANSWERS)) {
        const res = await fetch(base + '/api/indexer' + path.slice('/api'.length));
        assert.equal(res.status, status, path);
        assert.equal(await res.text(), JSON.stringify(body), `${path} forwarded verbatim`);
      }
    });
  } finally {
    indexer.close();
  }
});

test('an unreachable faucet answers a fixed body — never the upstream address', async () => {
  await withConfiguredServer({ faucetUrl: 'http://127.0.0.1:1' }, async (base) => {
    const res = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dgbrt1qfoo' }),
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'the Faucet is unavailable', cause: 'faucet-unreachable' });
    assert.doesNotMatch(text, NO_BACKEND_TRACE);
  });
});

// The counterweight to the two above: /api/rpc must keep relaying the node's
// reject string WORD FOR WORD. Genericizing it would turn every definite reject
// into "may have been broadcast" and hand the user back the rebuild-and-send
// path onto the same coins — a money-safety regression, not a leak fix.
test('/api/rpc still relays the node reject verbatim, so a reject stays a reject (#H3)', async () => {
  const { createServer } = await import('node:http');
  const REJECT = 'bad-txns-inputs-missingorspent';
  const node = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { method, id } = JSON.parse(raw);
    const body = method === 'getblockchaininfo'
      ? { id, result: { chain: 'test', blocks: 100, headers: 100, initialblockdownload: false } }
      : method === 'sendrawtransaction'
        ? { id, error: { code: -26, message: REJECT } }
        : { id, result: { price_micro_usd: 13_420, is_stale: false } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => node.listen(0, r));
  try {
    await withConfiguredServer({
      rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
    }, async (base) => {
      const res = await postRpc(base, { method: 'sendrawtransaction', params: ['00'] });
      assert.equal(res.status, 502);
      const { error } = await res.json();
      assert.equal(error, REJECT, 'the node reject string reaches the browser unchanged');
      assert.equal(classifyBroadcastError(new Error(error)).kind, 'reject');
    });
  } finally {
    node.close();
  }
});
