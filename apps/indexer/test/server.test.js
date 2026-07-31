// Indexer façade HTTP seam. ElectrumX is faked with an in-process TCP server
// speaking newline-delimited JSON-RPC — tests assert the façade's translation
// (address → scripthash → HTTP JSON), not ElectrumX itself (that's the e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { startServer, ElectrumClient, createTxCache, configFromEnv } from '../server.js';

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

// ---- DigiDollar positions (#13) ----
// Reference data is the Core-built mint fixture from digidollar-js
// (test/fixtures/mint-tx.json): $100 at the 6-months tier, unlock 1037552.
const { readFile } = await import('node:fs/promises');
const MINT = JSON.parse(await readFile(
  new URL('../../../packages/digidollar-js/test/fixtures/mint-tx.json', import.meta.url), 'utf8',
)).result;
const TRANSFER = JSON.parse(await readFile(
  new URL('../../../packages/digidollar-js/test/fixtures/transfer-tx.json', import.meta.url), 'utf8',
)).result;
const OWNER_ADDR = MINT.vout[1].scriptPubKey.address; // the DD token P2TR = wallet receive address
const scripthashOfHex = (hex) =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest().reverse().toString('hex');
const OWNER_SCRIPTHASH = scripthashOfHex(MINT.vout[1].scriptPubKey.hex);
const COLLATERAL_SCRIPTHASH = scripthashOfHex(MINT.vout[0].scriptPubKey.hex);

const POSITION_HANDLERS = (collateralUnspent) => ({
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.get_history': (params) =>
    params[0] === OWNER_SCRIPTHASH
      ? [
          { tx_hash: MINT.txid, height: 1800 },
          { tx_hash: TRANSFER.txid, height: 1810 }, // DD transfer — not a position
          { tx_hash: 'ee'.repeat(32), height: 1811 }, // plain DGB tx — not a position
        ]
      : [],
  'blockchain.transaction.get': (params) => {
    if (params[0] === MINT.txid) return MINT;
    if (params[0] === TRANSFER.txid) return TRANSFER;
    return { txid: params[0], version: 2, vout: [] }; // plain spend
  },
  'blockchain.scripthash.listunspent': (params) =>
    collateralUnspent && params[0] === COLLATERAL_SCRIPTHASH
      ? [{ tx_hash: MINT.txid, tx_pos: 0, value: 2_634_128_166_915, height: 1800 }]
      : [],
});

test('positions: a mint in history becomes an open position; transfers and plain txs do not', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      tipHeight: 1825,
      positions: [{
        txid: MINT.txid,
        height: 1800,
        ddCents: '10000',           // $100
        tierId: '6months',
        tierLabel: '6 months',
        unlockHeight: 1037552,
        collateralSats: '2634128166915',
      }],
    });
  }, POSITION_HANDLERS(true));
});

test('positions: a redeemed mint (collateral spent) is no longer an open position', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).positions, []);
  }, POSITION_HANDLERS(false));
});

// ---- DigiDollar spendable balance (#15) ----
// DD tokens live in zero-value P2TR outputs; their amounts come from the
// creating tx's OP_RETURN, paired positionally (mint: [ddCents], transfer:
// amountsCents in output order). dd-utxos resolves each zero-value UTXO on the
// address to its DD cents so the wallet can display and spend DigiDollar.
const TRANSFER_RECIPIENT_ADDR = TRANSFER.vout[0].scriptPubKey.address;
const TRANSFER_RECIPIENT_SCRIPTHASH = scripthashOfHex(TRANSFER.vout[0].scriptPubKey.hex);

const DD_UTXO_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.scripthash.listunspent': (params) => {
    if (params[0] === OWNER_SCRIPTHASH) {
      return [
        { tx_hash: MINT.txid, tx_pos: 1, value: 0, height: 1800 },     // fresh mint DD
        { tx_hash: TRANSFER.txid, tx_pos: 1, value: 0, height: 1810 }, // DD change of a transfer
        { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 150_000_000, height: 1805 }, // plain DGB
      ];
    }
    if (params[0] === TRANSFER_RECIPIENT_SCRIPTHASH) {
      return [{ tx_hash: TRANSFER.txid, tx_pos: 0, value: 0, height: 1810 }];
    }
    return [];
  },
  'blockchain.transaction.get': (params) => {
    if (params[0] === MINT.txid) return MINT;
    if (params[0] === TRANSFER.txid) return TRANSFER;
    return { txid: params[0], version: 2, vout: [] };
  },
};

test('dd-utxos: zero-value DD outputs resolve to cents (mint full amount, transfer change)', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/dd-utxos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      totalCents: '17000', // $100 mint + $70 transfer change
      utxos: [
        { txid: MINT.txid, vout: 1, cents: '10000', height: 1800 },
        { txid: TRANSFER.txid, vout: 1, cents: '7000', height: 1810 },
      ],
    });
  }, DD_UTXO_HANDLERS);
});

test('dd-utxos: a transfer RECIPIENT sees the positional amount for their output', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/address/${TRANSFER_RECIPIENT_ADDR}/dd-utxos`);
    assert.deepEqual((await res.json()).utxos, [
      { txid: TRANSFER.txid, vout: 0, cents: '3000', height: 1810 },
    ]);
  }, DD_UTXO_HANDLERS);
});

// ---- Per-tx enrichment (#69) ----
// Resolve one tx into a real history entry: DD type, resolved in/out addresses,
// fee (Σin − Σout, needing each input's prevout), timestamp, confirmations.
const PREV1 = TRANSFER.vin[0].txid; // funds vout[1]
const PREV2 = TRANSFER.vin[1].txid; // funds vout[1] (the DD fee coin)
const stubPrevout = (value, address) => ({ txid: 'ff'.repeat(32), version: 2, vout: [{ n: 0, value: 0, scriptPubKey: {} }, { n: 1, value, scriptPubKey: { address, hex: '00' } }] });

const TX_HANDLERS = {
  'server.version': () => ['FakeElectrumX 0.0', '1.4'],
  'blockchain.headers.subscribe': () => ({ height: 1825, hex: '00' }),
  'blockchain.transaction.get': (params) => {
    if (params[0] === TRANSFER.txid) return { ...TRANSFER, confirmations: 12, blocktime: 1_720_000_000 };
    if (params[0] === PREV1) return stubPrevout(14.36, 'dgbrt1qfunder00000000000000000000000000funder0');
    if (params[0] === PREV2) return stubPrevout(0.01, 'dgbrt1qfeecoin0000000000000000000000000feecn0');
    throw new Error('unexpected tx: ' + params[0]);
  },
};

test('tx: a DD transfer resolves to type, signed in/out addresses, fee, timestamp, confirmations', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/tx/${TRANSFER.txid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      txid: TRANSFER.txid,
      confirmations: 12,
      time: 1_720_000_000,
      type: 'transfer',
      feeSats: '9244', // (14.36 + 0.01) − 14.36990756 DGB, in sats
      vin: [
        { address: 'dgbrt1qfunder00000000000000000000000000funder0', valueSats: '1436000000' },
        { address: 'dgbrt1qfeecoin0000000000000000000000000feecn0', valueSats: '1000000' },
      ],
      vout: [
        { n: 0, address: TRANSFER.vout[0].scriptPubKey.address, valueSats: '0', ddCents: '3000' },
        { n: 1, address: TRANSFER.vout[1].scriptPubKey.address, valueSats: '0', ddCents: '7000' },
        { n: 2, address: TRANSFER.vout[2].scriptPubKey.address, valueSats: '1436990756', ddCents: null },
        { n: 3, address: null, valueSats: '0', ddCents: null }, // OP_RETURN — no address, not DD-valued
      ],
    });
  }, TX_HANDLERS);
});

test('tx: a coinbase input makes the fee uncomputable (feeSats null), tx still resolves', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/tx/${'11'.repeat(32)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'dgb');
    assert.equal(body.feeSats, null);
    assert.deepEqual(body.vin, [{ address: null, valueSats: null }]);
    assert.deepEqual(body.vout, [{ n: 0, address: 'dgbrt1qminer0000000000000000000000000000miner0', valueSats: '625000000', ddCents: null }]);
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => ({
      txid: params[0], version: 2, confirmations: 100, blocktime: 1_720_000_500,
      vin: [{ coinbase: '02abcd', sequence: 0 }],
      vout: [{ n: 0, value: 6.25, scriptPubKey: { address: 'dgbrt1qminer0000000000000000000000000000miner0', hex: '0014' } }],
    }),
  });
});

test('tx: malformed txid in the path is rejected (404), Electrum never queried', async () => {
  await withIndexer(async (base, seen) => {
    assert.equal((await fetch(`${base}/api/tx/nothex`)).status, 404);
    assert.equal((await fetch(`${base}/api/tx/${'zz'.repeat(32)}`)).status, 404);
    assert.equal(seen.filter((m) => m.method.startsWith('blockchain.')).length, 0);
  }, TX_HANDLERS);
});

test('tx: prevout fan-out is capped at 40 — inputs past the cap are unresolved and the fee is null', async () => {
  const BIGTX = '99'.repeat(32);
  const PREVBIG = 'dd'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${BIGTX}`)).json();
    assert.equal(body.vin.length, 45);
    assert.deepEqual(body.vin[0], { address: 'dgbrt1qfunder0000000000000000000000000fundr0', valueSats: '300000000' });
    assert.deepEqual(body.vin[39], { address: 'dgbrt1qfunder0000000000000000000000000fundr0', valueSats: '300000000' });
    assert.deepEqual(body.vin[40], { address: null, valueSats: null }); // past the cap
    assert.deepEqual(body.vin[44], { address: null, valueSats: null });
    assert.equal(body.feeSats, null); // inputs incomplete → fee not asserted
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === BIGTX) return { txid: BIGTX, version: 2, confirmations: 3, blocktime: 1_720_000_000,
        vin: Array.from({ length: 45 }, () => ({ txid: PREVBIG, vout: 0 })),
        vout: [{ n: 0, value: 100, scriptPubKey: { address: 'dgbrt1qbig000000000000000000000000000000big0', hex: '0014' } }] };
      if (params[0] === PREVBIG) return { txid: PREVBIG, version: 2, vout: [{ n: 0, value: 3, scriptPubKey: { address: 'dgbrt1qfunder0000000000000000000000000fundr0', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('tx: a mempool tx (no confirmations/blocktime) reports confirmations 0 and time null, fee still resolves', async () => {
  const MEMTX = '77'.repeat(32);
  const PREVM = '66'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${MEMTX}`)).json();
    assert.equal(body.confirmations, 0);
    assert.equal(body.time, null);
    assert.equal(body.feeSats, '1000000'); // 10 − 9.99 DGB
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === MEMTX) return { txid: MEMTX, version: 2, // no confirmations, no blocktime
        vin: [{ txid: PREVM, vout: 0 }],
        vout: [{ n: 0, value: 9.99, scriptPubKey: { address: 'dgbrt1qrecv00000000000000000000000000recv0', hex: '0014' } }] };
      if (params[0] === PREVM) return { txid: PREVM, version: 2, vout: [{ n: 0, value: 10, scriptPubKey: { address: 'dgbrt1qspend0000000000000000000000000spend0', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('tx: a vin whose prevout vout index is missing leaves the fee null, tx still resolves', async () => {
  const GAPTX = '88'.repeat(32);
  const PREVG = '55'.repeat(32);
  await withIndexer(async (base) => {
    const body = await (await fetch(`${base}/api/tx/${GAPTX}`)).json();
    assert.deepEqual(body.vin, [{ address: null, valueSats: null }]); // vout[5] absent → unresolved
    assert.equal(body.feeSats, null);
  }, {
    'server.version': () => ['FakeElectrumX 0.0', '1.4'],
    'blockchain.transaction.get': (params) => {
      if (params[0] === GAPTX) return { txid: GAPTX, version: 2, confirmations: 1, blocktime: 1_720_000_000,
        vin: [{ txid: PREVG, vout: 5 }], // prevout only has vout[0]
        vout: [{ n: 0, value: 1, scriptPubKey: { address: 'dgbrt1qgap000000000000000000000000000000gap0', hex: '0014' } }] };
      if (params[0] === PREVG) return { txid: PREVG, version: 2, vout: [{ n: 0, value: 2, scriptPubKey: { address: 'x', hex: '0014' } }] };
      throw new Error('unexpected tx: ' + params[0]);
    },
  });
});

test('health reports the electrum tip height', async () => {
  await withIndexer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.deepEqual(await res.json(), { height: 1825 });
  });
});

test('reconnect after a dropped TCP session re-does the server.version handshake (#32)', async () => {
  // Strict fake: like real ElectrumX ≥1.4, it KILLS any connection whose first
  // message is not server.version. The façade must survive its long-lived
  // connection being dropped (idle timeout, ElectrumX restart) without a
  // process restart.
  const sockets = new Set();
  let handshakes = 0;
  const electrum = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let handshaken = false;
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!handshaken && msg.method !== 'server.version') return sock.destroy();
        if (msg.method === 'server.version') { handshaken = true; handshakes++; }
        const result = msg.method === 'server.version' ? ['StrictFake 0.0', '1.4']
          : msg.method === 'blockchain.scripthash.listunspent' ? []
          : msg.method === 'blockchain.headers.subscribe' ? { height: 1, hex: '00' }
          : null;
        sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }) + '\n');
      }
    });
  });
  await new Promise((r) => electrum.listen(0, r));
  const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host: '127.0.0.1', port: electrum.address().port } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/address/${ADDR}/utxos`)).status, 200, 'first query works');
    // drop the live TCP session server-side, as an idle timeout would
    for (const s of sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${base}/api/address/${ADDR}/utxos`);
    assert.equal(res.status, 200, 'query after reconnect must succeed without a façade restart');
    assert.equal(handshakes, 2, 'a fresh server.version handshake on the new connection');
  } finally {
    server.close();
    electrum.close();
  }
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

// ---- Frame assembly ----
// These drive ElectrumClient directly against a fake ElectrumX socket, below
// the façade: the seam tests above always get their frames in one chunk, and
// chunking is exactly where a multi-MB verbose-tx body is won or lost.
async function withElectrumClient(onMessage, fn) {
  const electrum = createTcpServer((sock) => {
    sock.setNoDelay(true); // don't let Nagle coalesce writes a test split on purpose
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        onMessage(sock, msg);
      }
    });
  });
  await new Promise((r) => electrum.listen(0, r));
  const client = new ElectrumClient({ host: '127.0.0.1', port: electrum.address().port });
  try {
    await fn(client);
  } finally {
    client.sock?.destroy();
    electrum.close();
  }
}
const HANDSHAKE = ['FakeElectrumX 0.0', '1.4'];

test('framing: a 12MB single-line frame delivered in 4KB chunks assembles correctly and fast', async () => {
  const BIG = 'x'.repeat(12 * 1024 * 1024);
  await withElectrumClient((sock, msg) => {
    const result = msg.method === 'server.version' ? HANDSHAKE : { data: BIG };
    const frame = JSON.stringify({ id: msg.id, jsonrpc: '2.0', result }) + '\n';
    // One 4KB slice per event-loop turn. Writing the slices back-to-back does
    // NOT deliver 4KB chunks — the kernel coalesces them and the reader still
    // gets ~64KB reads, which is not the shape this guards. Chunk COUNT is what
    // the quadratic parser was quadratic in, so the pacing is the point.
    let i = 0;
    const pump = () => {
      if (i >= frame.length) return;
      sock.write(frame.slice(i, i + 4096));
      i += 4096;
      setImmediate(pump);
    };
    pump();
  }, async (client) => {
    const t0 = performance.now();
    const res = await client.request('blockchain.transaction.get', ['big', true]);
    const elapsed = performance.now() - t0;
    assert.equal(res.data, BIG);
    // Decisive, not a benchmark: at ~3000 chunks the flatten-and-rescan-per-
    // chunk framing measures ~6s against ~0.22s linear, so this bound goes red
    // if that parser is reintroduced. (Delivered in 64KB chunks the old parser
    // finished in ~550ms and this assertion proved nothing.)
    assert.ok(elapsed < 2000, `framing took ${Math.round(elapsed)}ms — O(n²) regression?`);
  });
});

test('framing: several pipelined frames arriving in one chunk are all dispatched', async () => {
  const queued = [];
  await withElectrumClient((sock, msg) => {
    if (msg.method === 'server.version') {
      return sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: HANDSHAKE }) + '\n');
    }
    queued.push(Buffer.from(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: `pong:${msg.method}` }) + '\n'));
    // Flush all three in ONE write. Writing them separately left it to loopback
    // segment packing whether the multi-frame-per-chunk path — the for(;;) loop
    // and its scan reset between frames — ran at all on a given run.
    if (queued.length === 3) sock.write(Buffer.concat(queued));
  }, async (client) => {
    assert.deepEqual(
      await Promise.all([client.request('a'), client.request('b'), client.request('c')]),
      ['pong:a', 'pong:b', 'pong:c'],
    );
  });
});

test('framing: a multi-byte character split across a chunk boundary is not corrupted', async () => {
  // Decoding each chunk on its own turns the split sequence into replacement
  // characters — JSON.parse still SUCCEEDS, so the frame is silently wrong.
  const LABEL = 'café — 日本';
  await withElectrumClient((sock, msg) => {
    if (msg.method === 'server.version') {
      return sock.write(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: HANDSHAKE }) + '\n');
    }
    const frame = Buffer.from(JSON.stringify({ id: msg.id, jsonrpc: '2.0', result: { label: LABEL } }) + '\n', 'utf8');
    const at = frame.indexOf(0xc3) + 1; // between the two bytes of 'é' (C3 A9)
    sock.write(frame.subarray(0, at));
    setTimeout(() => sock.write(frame.subarray(at)), 10); // force two 'data' events
  }, async (client) => {
    assert.equal((await client.request('blockchain.transaction.get', ['x', true])).label, LABEL);
  });
});

// ---- Shared verbose-tx cache ----
// The first test pins the cache BOUNDARY through the real HTTP seam; the rest
// drive createTxCache directly, where the mechanics (in-flight dedupe, expiry,
// eviction) are visible and the seam's timing is not in the way.

test('tx cache seam: a second dd-utxos read re-queries the UTXO set but reuses the tx body', async () => {
  // The money-safety invariant, in one assertion. What decides spendability
  // (listunspent) must be asked upstream every time; the immutable tx body may
  // be shared. A refactor that widened the cache over the UTXO set would serve
  // a stale spendable set, and this is the test that would go red.
  await withIndexer(async (base, seen) => {
    for (let i = 0; i < 2; i++) {
      assert.equal((await fetch(`${base}/api/address/${TRANSFER_RECIPIENT_ADDR}/dd-utxos`)).status, 200);
    }
    const calls = (method) => seen.filter((m) => m.method === method).length;
    assert.equal(calls('blockchain.scripthash.listunspent'), 2, 'the spendable set is NEVER memoized');
    assert.equal(calls('blockchain.transaction.get'), 1, 'the tx body is shared across the two reads');
  }, DD_UTXO_HANDLERS);
});

const TX_BODY = (txid) => ({ txid, version: 2, vout: [] });

test('tx cache: callers overlapping on one txid share a single upstream call', async () => {
  const txid = 'c7'.repeat(32);
  let calls = 0;
  const slow = async (method, params) => {
    assert.equal(method, 'blockchain.transaction.get');
    assert.deepEqual(params, [txid, true]);
    calls++;
    await new Promise((r) => setTimeout(r, 25)); // stay in flight so the callers overlap
    return TX_BODY(txid);
  };
  const cache = createTxCache(slow, 5_000);
  const [a, b] = await Promise.all([cache.get(txid), cache.get(txid)]);
  assert.equal(calls, 1, 'two overlapping callers, ONE upstream call');
  assert.equal(a, b, 'both get the same body');
  await cache.get(txid);
  assert.equal(calls, 1, 'inside the TTL the body is reused');
});

test('tx cache: an entry past its TTL is re-fetched', async () => {
  const txid = 'c8'.repeat(32);
  let calls = 0;
  const cache = createTxCache(async () => { calls++; return TX_BODY(txid); }, 20);
  await cache.get(txid);
  await new Promise((r) => setTimeout(r, 40));
  await cache.get(txid);
  assert.equal(calls, 2);
});

// Synchronous on purpose: node:test runs a file's tests in order, so mutating
// process.env without awaiting cannot leak into a concurrently-built server.
test('config: TX_CACHE_TTL_MS=0 survives as 0 and is not read as "unset"', () => {
  const saved = process.env.TX_CACHE_TTL_MS;
  try {
    process.env.TX_CACHE_TTL_MS = '0';
    assert.equal(configFromEnv().txCacheTtlMs, 0, '0 is the kill switch, not a missing value');
    process.env.TX_CACHE_TTL_MS = '250';
    assert.equal(configFromEnv().txCacheTtlMs, 250);
    delete process.env.TX_CACHE_TTL_MS;
    assert.equal(configFromEnv().txCacheTtlMs, 5_000, 'unset → default');
    process.env.TX_CACHE_TTL_MS = 'nonsense';
    assert.equal(configFromEnv().txCacheTtlMs, 5_000, 'unparseable → default, never NaN');
  } finally {
    if (saved === undefined) delete process.env.TX_CACHE_TTL_MS;
    else process.env.TX_CACHE_TTL_MS = saved;
  }
});

test('tx cache: TX_CACHE_TTL_MS=0 is the kill switch — every get misses', async () => {
  // configFromEnv validates rather than `|| 5000` so an operator triaging a
  // staleness report can turn the cache off without a code change.
  const txid = 'ca'.repeat(32);
  let calls = 0;
  const cache = createTxCache(async () => { calls++; return TX_BODY(txid); }, 0);
  await cache.get(txid);
  await cache.get(txid);
  assert.equal(calls, 2, 'a zero TTL memoizes nothing');
});

test('tx cache: a failed fetch is evicted, not served for the rest of the TTL', async () => {
  const txid = 'c9'.repeat(32);
  let calls = 0;
  const flaky = async () => {
    if (++calls === 1) throw new Error('electrum down');
    return TX_BODY(txid);
  };
  const cache = createTxCache(flaky, 5_000);
  await assert.rejects(cache.get(txid), /electrum down/);
  await new Promise((r) => setTimeout(r, 0)); // let the eviction handler run
  assert.equal((await cache.get(txid)).txid, txid, 'the next caller retries upstream');
  assert.equal(calls, 2);
});

test('tx cache: it is bounded — the oldest entry makes room for the newest', async () => {
  let calls = 0;
  const cache = createTxCache(async (_method, [txid]) => { calls++; return TX_BODY(txid); }, 5_000);
  const first = '00'.repeat(32);
  await cache.get(first);
  for (let i = 1; i <= 500; i++) await cache.get(String(i).padStart(64, '0'));
  assert.equal(cache.entries.size, 500);
  assert.equal(cache.entries.has(first), false);
  const before = calls;
  await cache.get(first);
  assert.equal(calls, before + 1, 'an evicted txid is fetched again');
});
