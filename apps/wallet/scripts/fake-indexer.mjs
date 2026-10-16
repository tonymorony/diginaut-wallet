// Minimal in-memory stand-in for the ElectrumX indexer façade (apps/indexer),
// serving just the four address endpoints the wallet reads. It has NO chain
// behind it: you POST canned UTXOs for an address and it echoes them back,
// deriving history from the UTXO set. Purpose: exercise the wallet's balance /
// send / send-max / fiat flows locally without a regtest node + ElectrumX.
//
// Usage:
//   PORT=8799 node apps/wallet/scripts/fake-indexer.mjs &
//   curl -XPOST 127.0.0.1:8799/__fund -d '{"address":"dgb1…","utxos":[{"txid":"aa..","vout":0,"valueSats":"30000000000","height":100}]}'
//   curl -XPOST 127.0.0.1:8799/__tip  -d '{"tip":284512}'   # make the index look behind
//
// Then run the wallet with INDEXER_URL=http://127.0.0.1:8799.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8799;
// Default matches the mock node's `blocks` (server.js getblockchaininfo). A
// lower default makes the wallet think the index is ~1.2M blocks behind and
// paint the stale-tip warning on every confirm screen (#H5), poisoning
// screenshots and any confirm-screen assertion. Drivers that WANT the warning
// set TIP explicitly or POST /__tip.
const TIP_DEFAULT = 1_284_512;
let tip = Number(process.env.TIP) || TIP_DEFAULT;
const funded = new Map(); // address -> { utxos, ddCents, ddUtxos }
const requests = []; // every /api/address read served, for /__requests introspection
let failing = false; // fault injection: make every address read answer 503

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  // Control endpoint: register canned UTXOs for an address.
  if (req.method === 'POST' && req.url === '/__fund') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { address, utxos = [], ddCents = '0', ddUtxos = [] } = JSON.parse(raw || '{}');
    funded.set(address, { utxos, ddCents: String(ddCents), ddUtxos });
    return json(res, 200, { ok: true, address, count: utxos.length });
  }
  // Deliberately does NOT clear `failing`: a driver that resets funding between
  // parts should not have its injected outage silently switched off underneath it.
  if (req.method === 'POST' && req.url === '/__reset') { funded.clear(); requests.length = 0; return json(res, 200, { ok: true }); }
  // Introspection: every address read served, in order. Lets a driver assert WHICH
  // indices a scan probed (e.g. that a restored wallet walked from index 0) instead
  // of racing the scan for a UI read that is only true until the scan finishes.
  if (req.method === 'GET' && req.url === '/__requests') return json(res, 200, { requests: [...requests] });
  // Control endpoint: make the address reads fail, so a driver can prove the
  // wallet recovers from an indexer outage rather than giving up on it.
  if (req.method === 'POST' && req.url === '/__fail') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    failing = JSON.parse(raw || '{}').on !== false;
    return json(res, 200, { ok: true, failing });
  }
  // Control endpoint: move the served tip at runtime, so a driver can prove the
  // stale-index warning (#H5) both appears when the index falls behind the node
  // AND clears when it catches up — the second half is what a fixture-only lag
  // can never show.
  if (req.method === 'POST' && req.url === '/__tip') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const next = Number(JSON.parse(raw || '{}').tip);
    if (!Number.isInteger(next)) return json(res, 400, { error: 'tip must be an integer' });
    tip = next;
    return json(res, 200, { ok: true, tip });
  }

  const m = req.url.match(/^\/api\/address\/([a-z0-9]+)\/(utxos|history|positions|dd-utxos)$/);
  if (!m) return json(res, 404, { error: 'unknown path' });
  requests.push(req.url);
  // After the route matches, so an unknown path is still a 404 either way.
  if (failing) return json(res, 503, { error: 'indexer down (injected)' });
  const [, address, what] = m;
  const entry = funded.get(address) || { utxos: [], ddCents: '0', ddUtxos: [] };

  if (what === 'utxos') return json(res, 200, { address, utxos: entry.utxos });
  if (what === 'history') {
    // one history row per distinct txid, carrying the UTXO's height
    const seen = new Map();
    for (const u of entry.utxos) if (!seen.has(u.txid)) seen.set(u.txid, u.height);
    return json(res, 200, { address, history: [...seen].map(([txid, height]) => ({ txid, height })) });
  }
  if (what === 'positions') return json(res, 200, { address, positions: [], tipHeight: tip });
  if (what === 'dd-utxos') return json(res, 200, { address, totalCents: entry.ddCents, utxos: entry.ddUtxos });
}).listen(PORT, () => console.log(`fake-indexer on :${PORT} (tip ${tip})`));
