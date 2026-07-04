// Faucet HTTP seam. The node RPC is injected as a fake — these tests assert
// faucet behavior (dispensing, sizing, limits), not node behavior (that's the
// env-gated e2e file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiredCollateralSats } from 'digidollar-js';
import { startServer } from '../server.js';

// Valid regtest taproot addresses (bech32m of 0x11…/0x22… 32-byte programs).
const ADDR = 'dgbrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygszk8z3a';
const ADDR2 = 'dgbrt1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q3zehg3';

const ORACLE_PRICE_USD = 0.01342;

function fakeRpc(calls = []) {
  return async (method, params = []) => {
    calls.push({ method, params });
    switch (method) {
      case 'getoraclestatus': return { active: true, lastPrice: ORACLE_PRICE_USD };
      case 'getbalance': return 1_000_000;
      case 'sendtoaddress': return 'f'.repeat(64); // txid
      case 'getblockchaininfo': return { chain: 'regtest' };
      default: throw new Error('unexpected rpc: ' + method);
    }
  };
}

async function withFaucet(fn, { rpc = fakeRpc(), dataDir } = {}) {
  const server = startServer({
    port: 0,
    rpc,
    dataFile: join(dataDir ?? mkdtempSync(join(tmpdir(), 'faucet-')), 'claims.json'),
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const claim = (base, address, headers = {}) =>
  fetch(base + '/api/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ address }),
  });

test('claim: dispenses to a valid address and the amount clears the $50 six-month mint floor', async () => {
  const calls = [];
  await withFaucet(async (base) => {
    const res = await claim(base, ADDR);
    assert.equal(res.status, 200);
    const { txid, amountSats } = await res.json();
    assert.equal(txid, 'f'.repeat(64));

    // AC: enough to mint $50 DigiDollar on the 6-month tier at the oracle price
    const floor = requiredCollateralSats({
      ddCents: 5000n,
      tierId: '6months',
      oraclePriceMicroUsd: BigInt(Math.round(ORACLE_PRICE_USD * 1_000_000)),
    });
    assert.ok(BigInt(amountSats) > floor, `${amountSats} sats must exceed the mint floor ${floor}`);

    const sent = calls.find((c) => c.method === 'sendtoaddress');
    assert.equal(sent.params[0], ADDR);
    assert.equal(sent.params[1], Number(BigInt(amountSats)) / 1e8);
  }, { rpc: fakeRpc(calls) });
});

test('claim: repeat for the same address within the cooldown → 429 with a clear message', async () => {
  await withFaucet(async (base) => {
    assert.equal((await claim(base, ADDR, { 'x-forwarded-for': '10.0.0.1' })).status, 200);
    const res = await claim(base, ADDR, { 'x-forwarded-for': '10.0.0.1' });
    assert.equal(res.status, 429);
    const { error } = await res.json();
    assert.match(error, /24h|cooldown|already/i);
  });
});

test('claim: a different address from the same IP is still rate-limited', async () => {
  await withFaucet(async (base) => {
    assert.equal((await claim(base, ADDR, { 'x-forwarded-for': '10.0.0.2' })).status, 200);
    assert.equal((await claim(base, ADDR2, { 'x-forwarded-for': '10.0.0.2' })).status, 429);
  });
});

test('claim: bad checksum and wrong-chain addresses → 400, nothing dispensed', async () => {
  const calls = [];
  await withFaucet(async (base) => {
    for (const bad of [
      'dgbrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygszk8z3b', // checksum
      'dgbt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsv89e8p', // testnet addr, regtest chain
      'not-an-address',
    ]) {
      assert.equal((await claim(base, bad)).status, 400, bad);
    }
    assert.equal(calls.filter((c) => c.method === 'sendtoaddress').length, 0);
  }, { rpc: fakeRpc(calls) });
});

test('cooldown survives a faucet restart (file-backed ledger)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'faucet-'));
  await withFaucet(async (base) => {
    assert.equal((await claim(base, ADDR, { 'x-forwarded-for': '10.0.0.3' })).status, 200);
  }, { dataDir });
  await withFaucet(async (base) => {
    assert.equal((await claim(base, ADDR, { 'x-forwarded-for': '10.0.0.3' })).status, 429);
  }, { dataDir });
});

test('status: operator sees hot-wallet balance and the current dispense amount', async () => {
  await withFaucet(async (base) => {
    const res = await fetch(base + '/api/status');
    assert.equal(res.status, 200);
    const st = await res.json();
    assert.equal(st.balanceDgb, 1_000_000);
    assert.ok(st.dispenseDgb > 0);
    assert.equal(st.cooldownHours, 24);
  });
});
