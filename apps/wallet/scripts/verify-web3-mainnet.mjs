// Web3 connect on MAINNET (#126 mainnet rollout): the one path that had no
// automated coverage. verify-connect-derive drives a testnet-shaped stack;
// verify-mainnet-bringup drives a mainnet-shaped node with no extension. This
// pairs them, because the two things that make the mainnet door safe are only
// observable together:
//
//   1. ADR 0005 — mainnet derives from the v2 bytes, never v1. Proven the hard
//      way: the fake wallet ACCEPTS ONLY the v2 message hex and throws on
//      anything else, so a regression that sends v1 fails the ceremony here
//      rather than silently deriving the wrong wallet on real funds.
//   2. The save path runs the SEALED backup ceremony (#C3) — no skip, no close.
//      A mainnet wallet cannot come into existence without its 24 words shown.
//
// Self-contained except Chrome. Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-web3-mainnet.mjs   # exit 0 = all green
import { createServer } from 'node:http';
import { once } from 'node:events';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';
import {
  S2D_MESSAGE, S2D_MESSAGE_MAIN, eip191Digest,
  canonicalizeEvmSignature, entropyFromSignature, mnemonicFromEntropy,
} from '../public/connect.js';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

const PASS = 'web3 mainnet pass';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const walletHex = (rec) => '0x' + hex(rec.subarray(1)) + (27 + rec[0]).toString(16);

// Same fixed test key as test/connect.test.js and verify-connect-derive.
const PRIV = new Uint8Array(32).fill(7);
const ETH_ADDR = '0x' + hex(keccak_256(secp256k1.getPublicKey(PRIV, false).subarray(1)).subarray(12));

// The two message hexes. V1_HEX exists only so the driver can prove the app
// never sends it here — the whole replay argument rests on that.
const V2_HEX = '0x' + hex(new TextEncoder().encode(S2D_MESSAGE_MAIN));
const V1_HEX = '0x' + hex(new TextEncoder().encode(S2D_MESSAGE));

// Deterministic signature over the v2 digest (a real extension signing v2).
const SIG_V2 = walletHex(secp256k1.sign(eip191Digest(new TextEncoder().encode(S2D_MESSAGE_MAIN)), PRIV, { format: 'recovered', prehash: false }));
const SIG_V1 = walletHex(secp256k1.sign(eip191Digest(new TextEncoder().encode(S2D_MESSAGE)), PRIV, { format: 'recovered', prehash: false }));

// mainnet coin type 20 — the address the v2 seed must produce.
const addrFor = async (sigHex) => {
  const { rs } = canonicalizeEvmSignature(sigHex);
  const mnemonic = mnemonicFromEntropy(await entropyFromSignature(rs));
  return deriveTaprootAddress(mnemonicToSeed(mnemonic), { ...HD_NETWORKS.mainnet, index: 0 }).address;
};
const ADDR_V2 = await addrFor(SIG_V2);
const ADDR_V1 = await addrFor(SIG_V1);

// The fake extension. It refuses anything but the v2 bytes: that refusal IS
// the assertion. `seen` records every message it was asked to sign so the
// driver can state positively which bytes crossed the wire.
const providerScript = `
  (() => {
    window.__signed = [];
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [${JSON.stringify(ETH_ADDR)}];
        if (method === 'personal_sign') {
          window.__signed.push(params[0]);
          if (params[0] !== ${JSON.stringify(V2_HEX)}) throw new Error('fake wallet: refused non-v2 message bytes');
          return ${JSON.stringify(SIG_V2)};
        }
        throw new Error('fake wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'mainnet-uuid', name: 'TestWallet', icon: 'data:image/svg+xml,x', rdns: 'io.testwallet' }, provider },
      }));
    });
  })();`;

// ---- stub MAINNET node (same shapes as verify-mainnet-bringup) ----
const HEIGHT = 23_828_832;
function nodeResult(method) {
  switch (method) {
    case 'getblockchaininfo':
      return { chain: 'main', blocks: HEIGHT, headers: HEIGHT, verificationprogress: 0.9999, initialblockdownload: false };
    case 'getdeploymentinfo':
      return {
        deployments: {
          digidollar: { type: 'bip9', active: false, bip9: { bit: 23, status: 'started', min_activation_height: 23_627_520 } },
          taproot: { type: 'bip9', active: true, bip9: { status: 'active' } },
        },
      };
    case 'getoracleprice':
      return { price_micro_usd: 8_420, price_cents: 1, price_usd: 0.00842, is_stale: false, oracle_count: 35, status: 'ok' };
    case 'getdcamultiplier':
      return { multiplier: 1.0, tier_status: 'healthy', system_health: 200, description: 'No additional collateral required (healthy system)' };
    case 'getdcamultiplier':
      return { multiplier: 1.0, tier_status: 'healthy', system_health: 200, description: 'No additional collateral required (healthy system)' };
    case 'getoracles':
      return Array.from({ length: 35 }, (_, i) => ({
        oracle_id: i, name: `oracle-${i}`, is_active: true, in_consensus: true,
        active_oracle_count: 35, total_oracle_slots: 35, consensus_threshold: 7,
      }));
    default:
      throw new Error(`stub node: no handler for ${method}`);
  }
}
const node = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const { method, id } = JSON.parse(raw);
  // Build the body BEFORE writing headers: nodeResult() throws for an
  // unhandled method, and writing first makes that surface as an unrelated
  // ERR_HTTP_HEADERS_SENT crash instead of the JSON-RPC error the app expects.
  let body;
  try {
    body = { id, result: nodeResult(method) };
  } catch (e) {
    console.log('  [stub node] unhandled method:', method);
    body = { id, error: { message: String(e.message) } };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((r) => node.listen(0, r));

// real mode (creds set) so mockMode is false and the chain guard runs
const server = startServer({
  port: 0,
  rpc: { url: `http://127.0.0.1:${node.address().port}`, user: 'u', pass: 'p' },
});
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

const root = await connectCdp();
const b = await root.newTarget();
await b.cdp('Page.addScriptToEvaluateOnNewDocument', { source: providerScript });
const { evaluate, waitFor, check, click, setVal, text, shot } = b;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;

await b.navigate(APP);

// The interstitial gates everything on mainnet — clear it first.
await waitFor(`document.getElementById('mainnet-ack-modal').classList.contains('open')`, 'mainnet interstitial opens');
await click('mainnet-ack-continue');
await waitFor(`!document.getElementById('mainnet-ack-modal').classList.contains('open')`, 'interstitial accepted');

// Settle on a REAL inline-display toggle. #hero-connect carries no inline
// style, so `visible()` on it is true before the app has booted — the
// documented gotcha: the click lands mid-boot and show() resets the mode
// under it. #w-none is written by show(), so it means the boot finished.
await waitFor(visible('w-none'), 'no-wallet state (boot settled)');
await click('hero-connect');
await waitFor(`document.getElementById('w-connect-modal').classList.contains('open')`, 'connect modal open');

// 1. THE REGRESSION THIS FILE EXISTS FOR: the door is on mainnet at all.
await waitFor(visible('w-web3-choice'), 'the web3 door is offered on MAINNET');
check(await evaluate(`document.getElementById('w-web3-group').style.display !== 'none'`),
  'w-web3-group is not chain-gated shut');
await shot('a0-web3-mainnet-door.png');

// 2. The ceremony: two signatures, both of which MUST be the v2 bytes or the
//    fake wallet throws.
await click('w-web3-choice');
await waitFor(`document.querySelector('#w-web3-list [data-web3-pick]')`, 'the fake extension is discovered');
await evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
await waitFor(visible('w-web3-disclose'), 'disclosure step armed');
await evaluate(`{ const c = document.getElementById('w-web3-agree'); c.checked = true; c.dispatchEvent(new Event('change',{bubbles:true})); }`);
await click('w-web3-go');

await waitFor(visible('w-web3-save'), 'both signatures accepted — save step reached');
const signed = await evaluate('JSON.stringify(window.__signed)');
const sent = JSON.parse(signed);
check(sent.length === 2, `the ceremony asked for exactly 2 signatures (got ${sent.length})`);
check(sent.every((m) => m === V2_HEX), 'BOTH signatures were over the v2 MAINNET bytes');
check(!sent.includes(V1_HEX), 'the testnet v1 bytes were never sent on mainnet (ADR 0005 replay guard)');

// 3. Save → the SEALED ceremony, not the light "back up when you're ready".
await setVal('w-web3-name', 'Mainnet derived');
await setVal('w-web3-pass', PASS);
await setVal('w-web3-pass2', PASS);
await click('w-web3-save-go');

// Wait on the TITLE, not on visible('w-backup'): #w-backup carries no inline
// display until setConnectMode writes one, so `style.display !== 'none'` is
// true before the ceremony ever opens. setConnectMode('backup') writes this
// exact string, so it is the first honest evidence the ceremony started.
await waitFor(`document.getElementById('w-connect-title').textContent === 'Back up your seed phrase'`,
  'saving a MAINNET derived wallet opens the backup ceremony');
check(await evaluate(`document.getElementById('w-backup-done').style.display === 'none'`),
  'sealed: no "Remind me later" skip on mainnet');
check(await evaluate(`document.getElementById('w-modal-close').style.display === 'none'`),
  'sealed: no close button — the ceremony cannot be dismissed');
await shot('a1-web3-mainnet-sealed-backup.png');

// 4. The wallet really is the v2 wallet, not the v1 one.
const words = await evaluate(`(() => { document.getElementById('w-backup-show').click();
  return [...document.querySelectorAll('.seed-grid li')].map((li) => li.textContent.trim()).join(' '); })()`);
const shownAddr = deriveTaprootAddress(mnemonicToSeed(words), { ...HD_NETWORKS.mainnet, index: 0 }).address;
check(shownAddr === ADDR_V2, `the ceremony shows the v2-derived seed (${shownAddr.slice(0, 16)}…)`);
check(shownAddr !== ADDR_V1, 'and NOT the v1/testnet-derived seed — the two networks are different wallets');

console.log('\nDone.');
await b.close();
server.close();
node.close();
process.exit(0);
