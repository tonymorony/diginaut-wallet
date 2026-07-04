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
