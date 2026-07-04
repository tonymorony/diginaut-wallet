// E2E: the Faucet against a live regtest node with a funded hot wallet.
// Gated: DD_E2E_RPC='http://dd:ddpass@127.0.0.1:18500' DD_E2E_WALLET=stand node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';
import { startServer } from '../server.js';

const RPC_URL = process.env.DD_E2E_RPC;
const WALLET = process.env.DD_E2E_WALLET || 'stand';

test('e2e: claim lands spendable DGB on a fresh client-derived regtest address', { skip: !RPC_URL && 'set DD_E2E_RPC to run' }, async () => {
  const url = new URL(RPC_URL);
  const rpcCreds = { url: url.origin, user: url.username, pass: url.password, wallet: WALLET };
  const nodeRpc = async (method, params = [], onWallet = true) => {
    const target = onWallet ? `${rpcCreds.url}/wallet/${WALLET}` : rpcCreds.url;
    const res = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${rpcCreds.user}:${rpcCreds.pass}`).toString('base64'),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }),
    });
    const json = JSON.parse(await res.text());
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };

  // fresh, purely client-side wallet — the faucet must not need to know it
  const seed = mnemonicToSeed(generateMnemonic());
  const { address } = deriveTaprootAddress(seed, { ...HD_NETWORKS.regtest, index: 0 });

  const server = startServer({
    port: 0,
    rpc: { ...rpcCreds },
    dataFile: join(mkdtempSync(join(tmpdir(), 'faucet-e2e-')), 'claims.json'),
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(base + '/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    // the coins are really in that tx, to that address, for that amount
    await nodeRpc('generatetoaddress', [1, await nodeRpc('getnewaddress')]);
    const tx = await nodeRpc('getrawtransaction', [body.txid, true], false);
    const vout = tx.vout.find((o) => o.scriptPubKey?.address === address);
    assert.ok(vout, 'claim tx must pay the client-derived address');
    assert.equal(Math.round(vout.value * 1e8), Number(BigInt(body.amountSats)));

    // repeat within cooldown → 429 (same seam, real node)
    const again = await fetch(base + '/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    assert.equal(again.status, 429);
  } finally {
    server.close();
  }
});
