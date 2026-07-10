import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startServer } from '../server.js';

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
    assert.deepEqual(hits, ['/api/address/dgbrt1qfoo/utxos', '/api/address/dgbrt1qfoo/positions', '/api/address/dgbrt1qfoo/dd-utxos']);
    // anything outside /api/address/ is not forwarded
    assert.equal((await fetch(base + '/api/indexer/../evil')).status, 404);
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
  const { createServer } = await import('node:http');
  let price = 13_000;
  const node = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { method, id } = JSON.parse(raw);
    assert.equal(method, 'getoracleprice');
    price += 10;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, result: { price_micro_usd: price, is_stale: false } }));
  });
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
