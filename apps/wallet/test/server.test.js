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

test('wallet UI carries the permanent TESTNET ONLY banner', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /TESTNET ONLY/);
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
