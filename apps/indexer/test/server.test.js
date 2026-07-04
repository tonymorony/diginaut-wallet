// Indexer façade HTTP seam. ElectrumX is faked with an in-process TCP server
// speaking newline-delimited JSON-RPC — tests assert the façade's translation
// (address → scripthash → HTTP JSON), not ElectrumX itself (that's the e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { startServer } from '../server.js';

// bech32m of program 0x11…×32 (regtest); scripthash = reversed sha256(scriptPubKey)
const ADDR = 'dgbrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygszk8z3a';
const SCRIPTHASH = createHash('sha256')
  .update(Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from('11'.repeat(32), 'hex')]))
  .digest().reverse().toString('hex');

function fakeElectrum(handlers) {
  const seen = [];
  const server = createTcpServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        seen.push(msg);
        const impl = handlers[msg.method] ?? (() => { throw new Error('unexpected: ' + msg.method); });
        sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: impl(msg.params) }) + '\n');
      }
    });
  });
  return { server, seen };
}

const DEFAULT_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.listunspent': (params) =>
    params[0] === SCRIPTHASH
      ? [{ tx_hash: 'ab'.repeat(32), tx_pos: 1, value: 1_448_800_000_000, height: 1825 }]
      : [],
  'blockchain.scripthash.get_history': (params) =>
    params[0] === SCRIPTHASH
      ? [{ tx_hash: 'cd'.repeat(32), height: 1824, fee: 100 }, { tx_hash: 'ab'.repeat(32), height: 0 }]
      : [],
};

async function withIndexer(fn, handlers = DEFAULT_HANDLERS) {
  const { server: electrum, seen } = fakeElectrum(handlers);
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({
    port: 0,
    hrp: 'dgbrt',
    electrum: { host: '127.0.0.1', port: electrum.address().port },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, seen);
  } finally {
    server.close();
    electrum.close();
  }
}

test('utxos: address is translated to a scripthash query and mapped to wallet-friendly JSON', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: ADDR,
      utxos: [{ txid: 'ab'.repeat(32), vout: 1, valueSats: '1448800000000', height: 1825 }],
    });
  });
});

test('history: confirmed and mempool (height 0) entries come through in order', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${ADDR}/history`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: ADDR,
      history: [
        { txid: 'cd'.repeat(32), height: 1824 },
        { txid: 'ab'.repeat(32), height: 0 },
      ],
    });
  });
});

test('bad checksum / wrong-network / junk addresses → 400 and Electrum is never queried', async () => {
  await withIndexer(async (base, seen) => {
    for (const bad of [
      ADDR.slice(0, -1) + 'b', // checksum
      'dgbt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsv89e8p', // testnet on regtest facade
      'nonsense',
    ]) {
      assert.equal((await fetch(`${base}/api/address/${bad}/utxos`)).status, 400, bad);
    }
    assert.equal(seen.filter((m) => m.method.startsWith('blockchain.')).length, 0);
  });
});

test('health reports the electrum tip height', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.deepEqual(await res.json(), { height: 1825 });
  });
});

test('electrum backend down → 502 with an error body, not a hang', async () => {
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: 1 } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 502);
    assert.ok((await res.json()).error);
  } finally {
    server.close();
  }
});
