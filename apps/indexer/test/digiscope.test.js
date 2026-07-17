// DigiScope FALLBACK backend (digiscope.js): shape-mapping unit tests plus the
// façade's HTTP seam over a faked DigiScope API. Fixtures are hand-built to
// the field names the Android client (DgbNodeClient.kt) parses — utxos[].
// {txid, vout, amountSatoshi, address, height}, rawTxs.{txid}.{hex, height,
// time}, top-level height — since the real API was NOT probed (see the
// UNVERIFIED notes in digiscope.js). Raw-hex parsing is tested against the
// Core-built mint fixture (digidollar-js test/fixtures/mint-tx.json), which
// carries the genuine wire hex next to Core's own decode of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseRawTx, spkToAddress, verboseFromRaw, mapReconcile } from '../digiscope.js';
import { startServer } from '../server.js';

const MINT = JSON.parse(await readFile(
  new URL('../../../packages/digidollar-js/test/fixtures/mint-tx.json', import.meta.url), 'utf8',
)).result;
const OWNER_ADDR = MINT.vout[1].scriptPubKey.address;      // DD token P2TR = wallet receive address
const CHANGE_ADDR = MINT.vout[3].scriptPubKey.address;     // P2WPKH change of the mint
const COLLATERAL_ADDR = MINT.vout[0].scriptPubKey.address; // collateral NUMS P2TR
const satsOf = (dgb) => String(BigInt(Math.round(dgb * 1e8)));

// ---- parseRawTx: the Core fixture's hex must round-trip to Core's decode ----

test('parseRawTx: the Core mint hex re-derives txid, version, prevouts, and outputs exactly', () => {
  const parsed = parseRawTx(MINT.hex);
  assert.equal(parsed.txid, MINT.txid); // txid recomputed from (witness-stripped) hex, not trusted
  assert.equal(parsed.version, MINT.version);
  assert.equal(parsed.locktime, MINT.locktime);
  assert.deepEqual(parsed.vin, [{ txid: MINT.vin[0].txid, vout: MINT.vin[0].vout }]);
  assert.deepEqual(
    parsed.vout.map((v) => ({ n: v.n, sats: String(v.sats), spkHex: v.spkHex })),
    MINT.vout.map((v) => ({ n: v.n, sats: satsOf(v.value), spkHex: v.scriptPubKey.hex })),
  );
});

test('parseRawTx: a legacy (non-segwit) coinbase parses, with the null prevout flagged as coinbase', () => {
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(625_000_000n);
  const hex = Buffer.concat([
    Buffer.from('01000000', 'hex'),            // version
    Buffer.from('01', 'hex'),                  // 1 input
    Buffer.alloc(32),                          // null prevout hash
    Buffer.from('ffffffff', 'hex'),            // prevout index -1
    Buffer.from('0402ab0100', 'hex'),          // scriptSig (4 bytes)
    Buffer.from('ffffffff', 'hex'),            // sequence
    Buffer.from('01', 'hex'),                  // 1 output
    value,
    Buffer.from('160014' + '11'.repeat(20), 'hex'), // P2WPKH script (22 bytes)
    Buffer.from('00000000', 'hex'),            // locktime
  ]).toString('hex');
  const parsed = parseRawTx(hex);
  assert.deepEqual(parsed.vin, [{ coinbase: '' }]);
  assert.equal(parsed.vout[0].sats, 625_000_000n);
  assert.match(parsed.txid, /^[0-9a-f]{64}$/);
});

test('parseRawTx: junk, truncation, and trailing bytes are rejected', () => {
  assert.throws(() => parseRawTx('zz'), /hex/);
  assert.throws(() => parseRawTx(''), /hex/);
  assert.throws(() => parseRawTx(MINT.hex.slice(0, 60)), /truncated/);
  assert.throws(() => parseRawTx(MINT.hex + '00'), /trailing/);
});

// ---- spkToAddress ----

test('spkToAddress: P2TR and P2WPKH scripts encode to the fixture addresses; OP_RETURN → null', () => {
  assert.equal(spkToAddress(MINT.vout[1].scriptPubKey.hex, 'dgbrt'), OWNER_ADDR);
  assert.equal(spkToAddress(MINT.vout[3].scriptPubKey.hex, 'dgbrt'), CHANGE_ADDR);
  assert.equal(spkToAddress(MINT.vout[2].scriptPubKey.hex, 'dgbrt'), null); // OP_RETURN
  assert.equal(spkToAddress('76a914' + '00'.repeat(20) + '88ac', 'dgbrt'), null); // legacy P2PKH
});

// ---- verboseFromRaw ----

test('verboseFromRaw: rebuilds the Core-verbose shape the enrichment consumes', () => {
  const tx = verboseFromRaw({ hex: MINT.hex, height: 1800, time: 1_720_000_000 }, 1810, 'dgbrt');
  assert.equal(tx.txid, MINT.txid);
  assert.equal(tx.confirmations, 11); // tip 1810, height 1800
  assert.equal(tx.blocktime, 1_720_000_000);
  assert.equal(tx.vout[0].value, MINT.vout[0].value);
  assert.equal(tx.vout[1].scriptPubKey.address, OWNER_ADDR);
  assert.equal(tx.vout[2].scriptPubKey.address, null);
});

test('verboseFromRaw: unconfirmed (height 0) or unknown-time entries degrade to 0 confirmations / null time', () => {
  const tx = verboseFromRaw({ hex: MINT.hex, height: 0, time: null }, 1810, 'dgbrt');
  assert.equal(tx.confirmations, 0);
  assert.equal(tx.blocktime, null);
});

// ---- mapReconcile: exact Android field names, tolerant types, honest errors ----

const GOOD = {
  utxos: [{ txid: MINT.txid.toUpperCase(), vout: 3, amountSatoshi: 4_565_859_933_085, address: CHANGE_ADDR, height: 1800 }],
  rawTxs: { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
  height: 1810,
};

test('mapReconcile: a well-formed response normalizes (case-folded txids, BigInt sats)', () => {
  const r = mapReconcile(GOOD);
  assert.deepEqual(r.utxos, [{ txid: MINT.txid, vout: 3, sats: 4_565_859_933_085n, address: CHANGE_ADDR, height: 1800 }]);
  assert.deepEqual(r.rawTxs, { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } });
  assert.equal(r.height, 1810);
});

test('mapReconcile: numeric strings are tolerated; missing rawTxs/height degrade, never invent', () => {
  const r = mapReconcile({ utxos: [{ ...GOOD.utxos[0], amountSatoshi: '4565859933085', height: '1800' }] });
  assert.equal(r.utxos[0].sats, 4_565_859_933_085n);
  assert.equal(r.utxos[0].height, 1800);
  assert.deepEqual(r.rawTxs, {});
  assert.equal(r.height, 0);
});

test('mapReconcile: a malformed required field is an ERROR, not a silently dropped utxo', () => {
  assert.throws(() => mapReconcile(null), /not a JSON object/);
  assert.throws(() => mapReconcile({}), /missing utxos/);
  assert.throws(() => mapReconcile({ utxos: [{ ...GOOD.utxos[0], txid: 'nothex' }] }), /txid/);
  assert.throws(() => mapReconcile({ utxos: [{ ...GOOD.utxos[0], amountSatoshi: 1.5 }] }), /satoshi/);
  assert.throws(() => mapReconcile({ utxos: [{ ...GOOD.utxos[0], address: undefined }] }), /address/);
  assert.throws(() => mapReconcile({ utxos: [], rawTxs: { [MINT.txid]: { height: 1 } } }), /hex/);
});

// ---- HTTP seam: the façade over a faked DigiScope API ----

function fakeDigiScope(handler) {
  const requests = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed, contentType: req.headers['content-type'] });
      const out = handler({ method: req.method, url: req.url, body: parsed });
      if (typeof out === 'number') {
        res.writeHead(out);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return { server, requests };
}

async function withFallbackIndexer(handler, fn) {
  const { server: digiscope, requests } = fakeDigiScope(handler);
  await new Promise((r) => digiscope.listen(0, r));
  const server = startServer({
    port: 0,
    hrp: 'dgbrt',
    digiscopeUrl: `http://127.0.0.1:${digiscope.address().port}/api`, // like Android: base includes /api
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, requests);
  } finally {
    server.close();
    digiscope.close();
  }
}

const TXB = 'ab'.repeat(32);
const reconcileHandler = (utxosByAddr, rawTxs, height = 1810) => ({ url, body }) => {
  if (url === '/api/wallet/reconcile') {
    return { utxos: body.addresses.flatMap((a) => utxosByAddr[a] ?? []), rawTxs, height };
  }
  if (url === '/api/chain/tip') return { height };
  return 404;
};

test('fallback utxos/history: derived from ONE reconcile POST with the Android payload shape', async () => {
  const handler = reconcileHandler(
    {
      [CHANGE_ADDR]: [
        { txid: MINT.txid, vout: 3, amountSatoshi: 4_565_859_933_085, address: CHANGE_ADDR, height: 1800 },
        { txid: TXB, vout: 0, amountSatoshi: 150_000_000, address: CHANGE_ADDR, height: 1795 },
        { txid: TXB, vout: 1, amountSatoshi: 25_000_000, address: CHANGE_ADDR, height: 1795 }, // same funding tx
      ],
    },
    { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
  );
  await withFallbackIndexer(handler, async (base, requests) => {
    const utxos = await (await fetch(`${base}/api/address/${CHANGE_ADDR}/utxos`)).json();
    assert.deepEqual(utxos, {
      address: CHANGE_ADDR,
      utxos: [
        { txid: MINT.txid, vout: 3, valueSats: '4565859933085', height: 1800 },
        { txid: TXB, vout: 0, valueSats: '150000000', height: 1795 },
        { txid: TXB, vout: 1, valueSats: '25000000', height: 1795 },
      ],
    });
    const history = await (await fetch(`${base}/api/address/${CHANGE_ADDR}/history`)).json();
    assert.deepEqual(history, {
      address: CHANGE_ADDR,
      history: [ // deduped by txid, confirmed ascending — Electrum get_history order
        { txid: TXB, height: 1795 },
        { txid: MINT.txid, height: 1800 },
      ],
    });
    // exact request contract (DgbNodeClient.requestBatch), and the TTL
    // micro-cache collapsed both routes into a single upstream call
    const reconciles = requests.filter((r) => r.url === '/api/wallet/reconcile');
    assert.equal(reconciles.length, 1);
    assert.equal(reconciles[0].method, 'POST');
    assert.match(reconciles[0].contentType, /application\/json/);
    assert.deepEqual(reconciles[0].body, { addresses: [CHANGE_ADDR] });
  });
});

test('fallback tx: enriched from cached raw hex — real outputs, honestly-unresolved inputs (fee null)', async () => {
  const handler = reconcileHandler(
    { [CHANGE_ADDR]: [{ txid: MINT.txid, vout: 3, amountSatoshi: 4_565_859_933_085, address: CHANGE_ADDR, height: 1800 }] },
    { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
  );
  await withFallbackIndexer(handler, async (base) => {
    await fetch(`${base}/api/address/${CHANGE_ADDR}/utxos`); // warms the raw-tx cache
    const res = await fetch(`${base}/api/tx/${MINT.txid}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      txid: MINT.txid,
      confirmations: 11, // reconcile height 1810 − block 1800 + 1
      time: 1_720_000_000,
      type: 'mint',
      feeSats: null, // prevouts are not in the reconcile response — never guessed
      vin: [{ address: null, valueSats: null }],
      vout: [
        { n: 0, address: COLLATERAL_ADDR, valueSats: '2634128166915', ddCents: null },
        { n: 1, address: OWNER_ADDR, valueSats: '0', ddCents: '10000' },
        { n: 2, address: null, valueSats: '0', ddCents: null }, // OP_RETURN
        { n: 3, address: CHANGE_ADDR, valueSats: '4565859933085', ddCents: null },
      ],
    });
  });
});

test('fallback tx: a txid never seen via reconcile is an honest 502, not fabricated data', async () => {
  await withFallbackIndexer(reconcileHandler({}, {}), async (base) => {
    const res = await fetch(`${base}/api/tx/${'99'.repeat(32)}`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /not seen via a reconcile/);
  });
});

test('fallback dd-utxos: zero-value token outputs resolve to cents through the parent raw hex', async () => {
  const handler = reconcileHandler(
    { [OWNER_ADDR]: [{ txid: MINT.txid, vout: 1, amountSatoshi: 0, address: OWNER_ADDR, height: 1800 }] },
    { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
  );
  await withFallbackIndexer(handler, async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/dd-utxos`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      totalCents: '10000',
      utxos: [{ txid: MINT.txid, vout: 1, cents: '10000', height: 1800 }],
    });
  });
});

test('fallback dd-utxos: a zero-value utxo whose parent hex is missing is an error, not a zeroed balance', async () => {
  const handler = reconcileHandler(
    { [OWNER_ADDR]: [{ txid: MINT.txid, vout: 1, amountSatoshi: 0, address: OWNER_ADDR, height: 1800 }] },
    {}, // parent hex withheld
  );
  await withFallbackIndexer(handler, async (base) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/dd-utxos`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /omitted the parent tx/);
  });
});

test('fallback positions: an unspent-collateral mint is open; the collateral is checked via a second reconcile', async () => {
  const handler = ({ url, body }) => {
    if (url === '/api/wallet/reconcile' && body.addresses[0] === OWNER_ADDR) {
      return {
        utxos: [{ txid: MINT.txid, vout: 1, amountSatoshi: 0, address: OWNER_ADDR, height: 1800 }],
        rawTxs: { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
        height: 1810,
      };
    }
    if (url === '/api/wallet/reconcile' && body.addresses[0] === COLLATERAL_ADDR) {
      return {
        utxos: [{ txid: MINT.txid, vout: 0, amountSatoshi: 2_634_128_166_915, address: COLLATERAL_ADDR, height: 1800 }],
        rawTxs: {},
        height: 1810,
      };
    }
    return 404;
  };
  await withFallbackIndexer(handler, async (base, requests) => {
    const res = await fetch(`${base}/api/address/${OWNER_ADDR}/positions`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      address: OWNER_ADDR,
      tipHeight: 1810,
      positions: [{
        txid: MINT.txid,
        height: 1800,
        ddCents: '10000',
        tierId: '6months',
        tierLabel: '6 months',
        unlockHeight: 1037552,
        collateralSats: '2634128166915',
      }],
    });
    assert.deepEqual(
      requests.filter((r) => r.url === '/api/wallet/reconcile').map((r) => r.body),
      [{ addresses: [OWNER_ADDR] }, { addresses: [COLLATERAL_ADDR] }],
    );
  });
});

test('fallback positions: a redeemed mint (collateral spent) is not an open position', async () => {
  const handler = ({ url, body }) => {
    if (url !== '/api/wallet/reconcile') return 404;
    if (body.addresses[0] === OWNER_ADDR) {
      return {
        utxos: [{ txid: MINT.txid, vout: 1, amountSatoshi: 0, address: OWNER_ADDR, height: 1800 }],
        rawTxs: { [MINT.txid]: { hex: MINT.hex, height: 1800, time: 1_720_000_000 } },
        height: 1810,
      };
    }
    return { utxos: [], rawTxs: {}, height: 1810 }; // collateral no longer unspent
  };
  await withFallbackIndexer(handler, async (base) => {
    const body = await (await fetch(`${base}/api/address/${OWNER_ADDR}/positions`)).json();
    assert.deepEqual(body.positions, []);
  });
});

test('fallback health: served from GET /chain/tip (ChainTipFetcher shape)', async () => {
  await withFallbackIndexer(reconcileHandler({}, {}, 1825), async (base, requests) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { height: 1825 });
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ['GET /api/chain/tip']);
  });
});

test('fallback health: a heightless tip response is a 502, not a fake height', async () => {
  await withFallbackIndexer(({ url }) => (url === '/api/chain/tip' ? { status: 'ok' } : 404), async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /no usable height/);
  });
});

test('fallback: DigiScope HTTP failures surface as 502 with an error body', async () => {
  await withFallbackIndexer(() => 500, async (base) => {
    const res = await fetch(`${base}/api/address/${CHANGE_ADDR}/utxos`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /HTTP 500/);
  });
});

test('fallback: invalid or wrong-network addresses → 400 and DigiScope is never contacted', async () => {
  await withFallbackIndexer(reconcileHandler({}, {}), async (base, requests) => {
    for (const bad of [
      OWNER_ADDR.slice(0, -1) + 'b', // checksum
      'dgbt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsv89e8p', // testnet on a regtest façade
      'nonsense',
    ]) {
      assert.equal((await fetch(`${base}/api/address/${bad}/utxos`)).status, 400, bad);
    }
    assert.equal(requests.length, 0);
  });
});
