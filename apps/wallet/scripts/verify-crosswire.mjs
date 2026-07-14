// Cross-wire guard, end to end (#64): a wallet deployment whose node reports
// the WRONG chain must fail loudly and closed — danger banner, CROSS-WIRED
// badge, no wallet boot, every RPC refused. Server unit tests cover the guard
// logic; this drives the UI's blocking state through a real browser.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-crosswire.mjs   # exit 0 = all green
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

// ---- stub DigiByte node that reports TESTNET ----
const node = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const { method, id } = JSON.parse(raw);
  const result = method === 'getblockchaininfo'
    ? { chain: 'test', blocks: 1_200_000, headers: 1_200_000, initialblockdownload: false }
    : { price_micro_usd: 2_546, is_stale: false };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, result }));
});
await new Promise((r) => node.listen(0, r));

// …behind a wallet that claims MAINNET
const server = startServer({
  port: 0,
  rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
  expectedChain: 'main',
});
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

// give the guard's boot probe a moment to learn the node's chain
for (let i = 0; i < 40; i++) {
  const cfg = await (await fetch(APP + '/api/config')).json();
  if (cfg.chain) break;
  await new Promise((r) => setTimeout(r, 50));
}

// ---- CDP plumbing lives in ./lib/cdp.mjs — one copy for all drivers ----
const b = await connectCdp();
const { evaluate, waitFor, check } = b;

await b.navigate(APP);
await waitFor(`!document.getElementById('net-banner').hidden`, 'banner renders');

const banner = await evaluate(`document.getElementById('net-banner').textContent`);
check(/SERVER MISCONFIGURED/.test(banner), `danger banner names the failure: "${banner}"`);
check(/MAIN/.test(banner) && /TEST/.test(banner), 'banner names both chains (expected vs actual)');
check(await evaluate(`document.getElementById('net-banner').classList.contains('danger')`), 'banner is danger-red');
check(await evaluate(`document.getElementById('modeBadge').textContent === 'CROSS-WIRED'`), 'mode badge says CROSS-WIRED');
check(await evaluate(`document.getElementById('w-loading').textContent.includes('wallet disabled')`), 'wallet boot is blocked with an explanation');
check(!(await evaluate(`document.getElementById('w-none').style.display !== 'none'`)), 'create-wallet flow never appears');

// the server side of the same coin: every RPC is refused
const rpcRes = await fetch(APP + '/api/rpc', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'getoracleprice', params: [] }),
});
check(rpcRes.status === 503 && /refusing to serve/.test((await rpcRes.json()).error), 'server refuses ALL rpc (503, names the cross-wire)');

await b.shot('100-crosswire-blocked.png');

console.log(process.exitCode ? '\nFAILED' : '\nall green');
b.close();
node.close();
server.close();
process.exit(process.exitCode || 0);
