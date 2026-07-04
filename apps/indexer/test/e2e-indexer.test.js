// E2E (#4 AC): seed real regtest transactions, read them back through the
// façade + live ElectrumX (scripts/electrumx-regtest/run.sh).
// Gated: DD_E2E_RPC='http://dd:ddpass@127.0.0.1:18500' DD_E2E_ELECTRUM='127.0.0.1:50001'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS, buildSignedMintTx } from 'digidollar-js';
import { startServer } from '../server.js';

const RPC_URL = process.env.DD_E2E_RPC;
const ELECTRUM = process.env.DD_E2E_ELECTRUM;
const WALLET = process.env.DD_E2E_WALLET || 'stand';

test('e2e: seeded regtest txs are returned for a known address (utxos + history, mempool → confirmed)',
  { skip: !(RPC_URL && ELECTRUM) && 'set DD_E2E_RPC and DD_E2E_ELECTRUM to run' }, async () => {
    const url = new URL(RPC_URL);
    const nodeRpc = async (method, params = [], onWallet = true) => {
      const res = await fetch(onWallet ? `${url.origin}/wallet/${WALLET}` : url.origin, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64'),
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
      });
      const json = JSON.parse(await res.text());
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    };

    const [host, port] = ELECTRUM.split(':');
    const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host, port: Number(port) } });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      return res.json();
    };

    try {
      // fresh client-side address, seeded with two known amounts
      const seed = mnemonicToSeed(generateMnemonic());
      const { address } = deriveTaprootAddress(seed, { ...HD_NETWORKS.regtest, index: 0 });
      const txid1 = await nodeRpc('sendtoaddress', [address, 1.5]);

      // mempool first: history must show it at height 0 within a few seconds
      let history;
      for (let i = 0; i < 40; i++) {
        ({ history } = await get(`/api/address/${address}/history`));
        if (history.some((h) => h.txid === txid1)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(history.some((h) => h.txid === txid1 && h.height === 0), 'seeded tx visible in mempool history');

      // confirm + second seed
      await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress')]);
      const txid2 = await nodeRpc('sendtoaddress', [address, 0.25]);
      await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress')]);

      let utxos;
      for (let i = 0; i < 40; i++) {
        ({ utxos } = await get(`/api/address/${address}/utxos`));
        if (utxos.length === 2) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const byTxid = Object.fromEntries(utxos.map((u) => [u.txid, u]));
      assert.equal(byTxid[txid1]?.valueSats, String(150_000_000));
      assert.equal(byTxid[txid2]?.valueSats, String(25_000_000));
      assert.ok(byTxid[txid1].height > 0 && byTxid[txid2].height > 0, 'both confirmed with heights');

      ({ history } = await get(`/api/address/${address}/history`));
      assert.equal(history.filter((h) => [txid1, txid2].includes(h.txid) && h.height > 0).length, 2);
    } finally {
      server.close();
    }
  });

test('e2e (#13): a real client-side mint surfaces as an open DigiDollar position',
  { skip: !(RPC_URL && ELECTRUM) && 'set DD_E2E_RPC and DD_E2E_ELECTRUM to run' }, async () => {
    const url = new URL(RPC_URL);
    const nodeRpc = async (method, params = [], onWallet = true) => {
      const res = await fetch(onWallet ? `${url.origin}/wallet/${WALLET}` : url.origin, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64'),
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
      });
      const json = JSON.parse(await res.text());
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    };

    const [host, port] = ELECTRUM.split(':');
    const server = startServer({ port: 0, hrp: 'dgbrt', electrum: { host, port: Number(port) } });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // fresh owner, funded, mints $250 at the 1-year tier — fully client-side
      const seed = mnemonicToSeed(generateMnemonic());
      const d0 = deriveTaprootAddress(seed, { ...HD_NETWORKS.regtest, index: 0 });
      const miner = await nodeRpc('getnewaddress');
      const fundTxid = await nodeRpc('sendtoaddress', [d0.address, 100_000]);
      await nodeRpc('generatetoaddress', [1, miner]);
      const fundTx = await nodeRpc('getrawtransaction', [fundTxid, true], false);
      const vout = fundTx.vout.findIndex((o) => o.scriptPubKey.address === d0.address);

      await nodeRpc('setmockoracleprice', [13_420], false);
      const tipHeight = await nodeRpc('getblockcount', [], false);
      const { hex, collateralSats, unlockHeight } = buildSignedMintTx({
        utxo: { txidHex: fundTxid, vout, valueSats: BigInt(Math.round(fundTx.vout[vout].value * 1e8)) },
        privKeyHex: d0.privKeyHex,
        ddCents: 25_000n,
        tierId: '1year',
        oraclePriceMicroUsd: 13_420n,
        tipHeight,
      });
      const mintTxid = await nodeRpc('sendrawtransaction', [hex], false);
      await nodeRpc('generatetoaddress', [1, miner]);

      let body;
      for (let i = 0; i < 40; i++) {
        body = await (await fetch(`${base}/api/address/${d0.address}/positions`)).json();
        if (body.positions?.length) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.deepEqual(body.positions, [{
        txid: mintTxid,
        height: tipHeight + 1,
        ddCents: '25000',
        tierId: '1year',
        tierLabel: '1 year',
        unlockHeight,
        collateralSats: String(collateralSats),
      }]);
      assert.ok(body.tipHeight >= tipHeight + 1, 'tip height present for expiry math');
    } finally {
      server.close();
    }
  });
