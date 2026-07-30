// Sign-to-derive (#130): drive the connect-a-web3-wallet ceremony end to end
// with a FAKE EIP-6963 provider (fixed test key, signatures precomputed here
// with the same noble the app serves) — no real extension involved.
// Scenarios, one fresh tab each (the vault persists in IndexedDB between them):
//   1. empty state: no provider injected → picker says so
//   2. happy path: deterministic provider → checkbox gate (its named origin is
//      read out of the very bytes being signed) → double-sign → save (creates
//      the vault) → derived address matches the Node-side pipeline; badge red;
//      switcher row carries "via TestWallet"
//   3. reconnect verified: same provider again → fingerprint match → switch,
//      no new wallet
//   4. drift hard stop: provider signs a DIFFERENT (still self-consistent)
//      signature → mismatch view, no silent wallet; "NEW wallet anyway" saves
//   5. MPC refusal: two different signatures in one ceremony → brand refused
//   6. Phantom path: window.phantom.solana only → Ed25519 derive
//   7. era-crossing reconnect: a source minted under msgVersion 1 (what this
//      origin produced before ADR 0006 moved it to era 2) re-derives from the
//      V1 bytes and MATCHES — reconnect follows the record, not the hostname
//
// Self-contained except Chrome:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-connect-derive.mjs   # exit 0 = all green
// A fresh user-data-dir is REQUIRED (fresh IndexedDB = "no wallet" state).
import { once } from 'node:events';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';
import {
  S2D_MESSAGE, S2D_MESSAGE_TESTNET2, s2dOriginHost, eip191Digest, canonicalizeEvmSignature,
  entropyFromSignature, mnemonicFromEntropy,
} from '../public/connect.js';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

const PASS = 'connect derive pass';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const walletHex = (rec) => '0x' + hex(rec.subarray(1)) + (27 + rec[0]).toString(16);

// The fixed test key (32 × 0x07) — same as test/connect.test.js.
const PRIV = new Uint8Array(32).fill(7);
const ETH_ADDR = '0x' + hex(keccak_256(secp256k1.getPublicKey(PRIV, false).subarray(1)).subarray(12));
// The app is served from 127.0.0.1 here, which is NOT a legacy host, so the
// live testnet bytes are v3 (ADR 0006). Everything below signs v3 explicitly —
// eip191Digest()'s bare default is still the v1 message, and taking it would
// make the fake wallet reject every signature with "unexpected message bytes".
const MSG = S2D_MESSAGE_TESTNET2;
const MSG_HEX = '0x' + hex(new TextEncoder().encode(MSG));
const digest = eip191Digest(new TextEncoder().encode(MSG));
const SIG1 = walletHex(secp256k1.sign(digest, PRIV, { format: 'recovered', prehash: false }));
// extraEntropy = a *valid* signature from the same key that differs from SIG1 —
// exactly what a drifted firmware (constant) or an MPC signer (fresh) returns
const DRIFT = walletHex(secp256k1.sign(digest, PRIV, { format: 'recovered', prehash: false, extraEntropy: new Uint8Array(32).fill(1) }));
// A second key (32 × 0x08) plays the MPC wallet: a fresh account whose two
// ceremony signatures differ — must be refused before anything derives.
const PRIV2 = new Uint8Array(32).fill(8);
const ETH_ADDR2 = '0x' + hex(keccak_256(secp256k1.getPublicKey(PRIV2, false).subarray(1)).subarray(12));
const MPC_A = walletHex(secp256k1.sign(digest, PRIV2, { format: 'recovered', prehash: false }));
const MPC_B = walletHex(secp256k1.sign(digest, PRIV2, { format: 'recovered', prehash: false, extraEntropy: new Uint8Array(32).fill(3) }));
// A third key (32 × 0x0b) plays scenario 7's account: an ERA-1 wallet sitting in
// this origin's vault. Its provider can sign either era, so a regression that
// picks bytes by hostname does not throw — it lands on the mismatch screen,
// which is exactly the user-visible failure the check has to see.
const PRIV3 = new Uint8Array(32).fill(11);
const ETH_ADDR3 = '0x' + hex(keccak_256(secp256k1.getPublicKey(PRIV3, false).subarray(1)).subarray(12));
const V1_HEX = '0x' + hex(new TextEncoder().encode(S2D_MESSAGE));
const ERA1_SIGS = {
  [V1_HEX]: walletHex(secp256k1.sign(eip191Digest(new TextEncoder().encode(S2D_MESSAGE)), PRIV3, { format: 'recovered', prehash: false })),
  [MSG_HEX]: walletHex(secp256k1.sign(digest, PRIV3, { format: 'recovered', prehash: false })),
};

const derivedAddr = async (sigHex) => {
  const { rs } = canonicalizeEvmSignature(sigHex);
  const mnemonic = mnemonicFromEntropy(await entropyFromSignature(rs));
  return deriveTaprootAddress(mnemonicToSeed(mnemonic), { ...HD_NETWORKS.testnet, index: 0 }).address;
};
const ADDR1 = await derivedAddr(SIG1);

// Phantom fake: Ed25519 key 32 × 0x09.
const EDSK = new Uint8Array(32).fill(9);
const PUB58 = base58.encode(ed25519.getPublicKey(EDSK));
const EDSIG = ed25519.sign(new TextEncoder().encode(MSG), EDSK);
const EDADDR = deriveTaprootAddress(
  mnemonicToSeed(mnemonicFromEntropy(new Uint8Array(await crypto.subtle.digest('SHA-256', EDSIG)))),
  { ...HD_NETWORKS.testnet, index: 0 },
).address;

// Injected before the app loads: an EIP-6963 wallet answering with canned
// signatures (sigs[min(n, len-1)] per personal_sign call). A wrong message
// hex from the app throws — the ceremony must send the frozen bytes verbatim.
const evmProviderScript = (sigs, addr = ETH_ADDR) => `
  (() => {
    let calls = 0;
    const sigs = ${JSON.stringify(sigs)};
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [${JSON.stringify(addr)}];
        if (method === 'personal_sign') {
          if (params[0] !== ${JSON.stringify(MSG_HEX)}) throw new Error('fake wallet: unexpected message bytes');
          return sigs[Math.min(calls++, sigs.length - 1)];
        }
        throw new Error('fake wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'test-uuid', name: 'TestWallet', icon: 'data:image/svg+xml,x', rdns: 'io.testwallet' }, provider },
      }));
    });
  })();`;
// Scenario 7's provider: answers for EITHER era, records every message hex it
// was asked to sign, and exposes itself so the driver can mint an era-1 source
// through the app's own connect.js before reconnecting through the UI.
const eraProviderScript = `
  (() => {
    window.__signed = [];
    const sigs = ${JSON.stringify(ERA1_SIGS)};
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [${JSON.stringify(ETH_ADDR3)}];
        if (method === 'personal_sign') {
          window.__signed.push(params[0]);
          if (!sigs[params[0]]) throw new Error('fake wallet: unexpected message bytes');
          return sigs[params[0]];
        }
        throw new Error('fake wallet: ' + method);
      },
    };
    window.__provider = provider;
    window.addEventListener('eip6963:requestProvider', () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'era-uuid', name: 'TestWallet', icon: 'data:image/svg+xml,x', rdns: 'io.testwallet' }, provider },
      }));
    });
  })();`;
const phantomScript = `
  window.phantom = { solana: {
    publicKey: ${JSON.stringify(PUB58)},
    connect: async () => ({ publicKey: ${JSON.stringify(PUB58)} }),
    signMessage: async (bytes) => ({ signature: Uint8Array.from(${JSON.stringify([...EDSIG])}) }),
  } };`;

const server = startServer({ port: 0, rpc: { user: '', pass: '' } }); // mock node (chain 'test'), no indexer
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

const root = await connectCdp();
const { check } = root;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const hidden = (id) => `document.getElementById('${id}').style.display === 'none'`;

async function freshTab(injection) {
  const b = await root.newTarget();
  if (injection) await b.cdp('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await b.navigate(APP);
  return b;
}
// Walk choice → picker → ceremony start for the injected TestWallet.
async function toCeremony(b) {
  await b.click('w-web3-choice');
  await b.waitFor(`document.querySelector('#w-web3-list [data-web3-pick]')`, 'picker row announced');
  await b.evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
  await b.waitFor(visible('w-web3-disclose'), 'disclosure step');
}
async function agreeAndGo(b) {
  await b.evaluate(`{ const c = document.getElementById('w-web3-agree'); c.checked = true; c.dispatchEvent(new Event('change')); }`);
  await b.click('w-web3-go');
}

// ============ 1. empty state: nothing announced ============
{
  const b = await freshTab(null);
  await b.waitFor(visible('w-none'), 'no-wallet state');
  await b.click('hero-connect');
  await b.click('w-web3-choice');
  await b.waitFor(`document.getElementById('w-web3-list').textContent.includes('No wallet extensions detected')`, 'empty state');
  check(true, 'no extensions → picker explains instead of listing');
}

// ============ 2. happy path: derive → save → address + badge + row ============
{
  const b = await freshTab(evmProviderScript([SIG1]));
  await b.waitFor(visible('w-none'), 'no-wallet state');
  await b.click('hero-connect');
  await toCeremony(b);
  check(await b.evaluate(`document.getElementById('w-web3-go').disabled`), 'checkbox gates signature 1 of 2');
  // The host in the checkbox must be the host the message itself pins — read
  // both from the same frozen bytes. Hardcoding it is how the mainnet ceremony
  // came to name the testnet domain (ADR 0006).
  check((await b.evaluate(`document.getElementById('w-web3-origin').textContent`)) === s2dOriginHost(MSG),
    `checkbox names the origin of the message being signed (${s2dOriginHost(MSG)})`);
  await agreeAndGo(b);
  await b.waitFor(visible('w-web3-save'), 'save step after double-sign + verify');
  await b.shot('80-web3-save.png');
  check((await b.evaluate(`document.getElementById('w-web3-name').value`)) === 'TestWallet wallet',
    'save step pre-fills "TestWallet wallet"');
  check(await b.evaluate(visible('w-web3-pass-fields')), 'master password fields shown (no vault yet)');
  await b.setVal('w-web3-pass', PASS);
  await b.setVal('w-web3-pass2', PASS);
  await b.click('w-web3-save-go');
  await b.waitFor(visible('w-open'), 'wallet open');
  await b.waitFor(`document.getElementById('w-chip-addr').textContent.length > 10`, 'address rendered');
  // the chip abbreviates (prefix…suffix) — match both ends against the full address
  const addr = (await b.evaluate(`document.getElementById('w-chip-addr').textContent`)).trim();
  const [pre, suf] = addr.split('…');
  check(Boolean(pre && suf) && ADDR1.startsWith(pre) && ADDR1.endsWith(suf),
    `derived address matches the Node-side pipeline (${addr})`);
  check(await b.evaluate(`document.getElementById('w-backup-badge').style.display !== 'none'`),
    'derived wallet is born not-backed-up (badge visible)');
  await b.evaluate(`document.getElementById('w-chip').click()`);
  await b.waitFor(`document.getElementById('w-wallet-list').textContent.includes('via TestWallet')`, 'switcher row');
  check(await b.evaluate(`document.getElementById('w-wallet-list').innerHTML.includes('EXPERIMENTAL')`),
    'switcher row carries via-brand + EXPERIMENTAL');
  await b.shot('81-web3-row.png');
}

// ============ 3. reconnect verified: known account → ONE signature, no checkbox, switch ============
{
  const b = await freshTab(evmProviderScript([SIG1]));
  await b.waitFor(visible('w-locked'), 'locked (vault persisted)');
  await b.setVal('w-unlock-pass', PASS);
  await b.click('w-unlock');
  await b.waitFor(visible('w-open'), 'unlocked');
  await b.evaluate(`document.getElementById('w-connect').click()`);
  await b.click('w-web3-choice');
  await b.waitFor(`document.querySelector('#w-web3-list [data-web3-pick]')`, 'picker row announced');
  await b.evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
  // #129: reconnects never re-ask — straight to the verified switch
  await b.waitFor(`document.getElementById('w-wallet-note').textContent.includes('Re-derived and verified')`,
    'reconnect verified note');
  const count = await b.evaluate(`document.querySelectorAll('#w-wallet-list .wal-row').length`);
  check(count === 1, `one-signature fingerprint match switches instead of duplicating (${count} wallet)`);
}

// ============ 4. drift: known account, ONE signature mismatches the fingerprint → hard stop;
// the explicit NEW-wallet path then requires the FULL ceremony (checkbox + double-sign) ============
{
  const b = await freshTab(evmProviderScript([DRIFT]));
  await b.waitFor(visible('w-locked'), 'locked');
  await b.setVal('w-unlock-pass', PASS);
  await b.click('w-unlock');
  await b.waitFor(visible('w-open'), 'unlocked');
  await b.evaluate(`document.getElementById('w-connect').click()`);
  await b.click('w-web3-choice');
  await b.waitFor(`document.querySelector('#w-web3-list [data-web3-pick]')`, 'picker row announced');
  await b.evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
  await b.waitFor(visible('w-web3-mismatch'), 'drift hard stop straight from the one-signature check');
  check((await b.evaluate(`document.getElementById('w-web3-mismatch-text').textContent`)).includes('no longer produces'),
    'hard-stop copy names the drift, points at the 24 words');
  check(await b.evaluate(hidden('w-web3-save')), 'no silent save on mismatch');
  await b.shot('82-web3-mismatch.png');
  await b.click('w-web3-newwallet');
  await b.waitFor(visible('w-web3-disclose'), 'NEW-wallet path demands the full ceremony (one signature proves nothing)');
  await agreeAndGo(b);
  await b.waitFor(visible('w-web3-save'), 'double-sign passed → save step');
  await b.click('w-web3-save-go');
  await b.waitFor(visible('w-open'), 'wallet open');
  await b.evaluate(`document.getElementById('w-chip').click()`);
  await b.waitFor(`document.querySelectorAll('#w-wallet-list .wal-row').length === 2`, 'second wallet exists');
  check(true, 'explicit confirmation + full ceremony saves the drifted signature as a separate wallet');
}

// ============ 5. MPC refusal: a FRESH account whose two signatures differ ============
{
  const b = await freshTab(evmProviderScript([MPC_A, MPC_B], ETH_ADDR2));
  await b.waitFor(visible('w-locked'), 'locked');
  await b.setVal('w-unlock-pass', PASS);
  await b.click('w-unlock');
  await b.waitFor(visible('w-open'), 'unlocked');
  await b.evaluate(`document.getElementById('w-connect').click()`);
  await toCeremony(b);
  await agreeAndGo(b);
  await b.waitFor(`document.getElementById('w-web3-err').textContent.includes('does not sign deterministically')`,
    'double-sign mismatch refuses the brand by name');
  check(await b.evaluate(visible('w-web3-disclose')), 'ceremony returns to the armed disclosure, nothing derived');
  await b.click('w-modal-close');
  await b.evaluate(`document.getElementById('w-chip').click()`);
  await b.waitFor(`document.querySelectorAll('#w-wallet-list .wal-row').length > 0`, 'switcher rendered');
  const count = await b.evaluate(`document.querySelectorAll('#w-wallet-list .wal-row').length`);
  check(count === 2, `refused ceremony added no wallet (still ${count})`);
}

// ============ 6. Phantom: Solana provider only → Ed25519 derive ============
{
  const b = await freshTab(phantomScript);
  await b.waitFor(visible('w-locked'), 'locked');
  await b.setVal('w-unlock-pass', PASS);
  await b.click('w-unlock');
  await b.waitFor(visible('w-open'), 'unlocked');
  await b.evaluate(`document.getElementById('w-connect').click()`);
  await b.click('w-web3-choice');
  await b.waitFor(`document.getElementById('w-web3-list').textContent.includes('Phantom')`, 'Phantom announced');
  check(await b.evaluate(`document.getElementById('w-web3-list').textContent.includes('Solana signature')`),
    'Phantom row is marked as the Solana path');
  await b.evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
  await b.waitFor(visible('w-web3-disclose'), 'disclosure step');
  await agreeAndGo(b);
  await b.waitFor(visible('w-web3-save'), 'save step');
  await b.click('w-web3-save-go');
  await b.waitFor(visible('w-open'), 'wallet open');
  await b.waitFor(
    `(() => { const t = document.getElementById('w-chip-addr').textContent.trim(); const [p, s] = t.split('…'); `
    + `return Boolean(p && s) && ${JSON.stringify(EDADDR)}.startsWith(p) && ${JSON.stringify(EDADDR)}.endsWith(s); })()`,
    'Phantom-derived address matches the Node-side Ed25519 pipeline');
  check(true, 'Phantom → Ed25519 → derived wallet');
}

// ============ 7. era-crossing reconnect: an ERA-1 source on an origin that is
// now era 2 must still re-derive from the V1 bytes ============
// ADR 0006 changed which era 127.0.0.1 (and localhost, and every self-host)
// mints under. Vaults created before that hold sources with msgVersion 1. If
// reconnect picked bytes by hostname it would sign v3 here, miss the stored
// fingerprint, and accuse the EXTENSION of changing how it signs — for a change
// the app made. The old build cannot be run, so the era-1 source is minted
// directly through the app's own connect.js + vault.js over the real IndexedDB,
// which is exactly the record that build would have left behind.
{
  const b = await freshTab(eraProviderScript);
  await b.waitFor(visible('w-locked'), 'locked');
  const seeded = await b.evaluate(`(async () => {
    const [ks, vm, c] = await Promise.all([import('/keystore.js'), import('/vault.js'), import('/connect.js')]);
    const vault = vm.createVaultManager(ks);
    await vault.load();
    await vault.unlock(${JSON.stringify(PASS)});
    const entry = { kind: 'evm', rdns: 'io.testwallet', brand: 'TestWallet', provider: window.__provider };
    const d = await c.deriveOnce(entry, ${JSON.stringify(ETH_ADDR3)}, 1);
    await vault.addWallet({ name: 'Era-1 wallet', mnemonic: d.mnemonic, source: d.source });
    return JSON.stringify({ v: d.source.msgVersion, signed: window.__signed, wallets: vault.meta().wallets.length });
  })()`);
  const seedState = JSON.parse(seeded);
  check(seedState.v === 1 && seedState.signed.length === 1 && seedState.signed[0] === V1_HEX,
    `seeded a source stamped msgVersion 1 from the v1 bytes (${seedState.signed.length} signature)`);

  // fresh tab = fresh window.__signed, so what follows is only the reconnect
  const r = await freshTab(eraProviderScript);
  await r.waitFor(visible('w-locked'), 'locked (era-1 source persisted)');
  await r.setVal('w-unlock-pass', PASS);
  await r.click('w-unlock');
  await r.waitFor(visible('w-open'), 'unlocked');
  await r.evaluate(`document.getElementById('w-connect').click()`);
  await r.click('w-web3-choice');
  await r.waitFor(`document.querySelector('#w-web3-list [data-web3-pick]')`, 'picker row announced');
  await r.evaluate(`document.querySelector('#w-web3-list [data-web3-pick]').click()`);
  // Wait for the reconnect to settle EITHER way, then assert which way. Waiting
  // only on the success note would make a regression fail by timing out 20 s
  // later with none of the diagnostics below printed.
  await r.waitFor(
    `document.getElementById('w-wallet-note').textContent.includes('Re-derived and verified')`
    + ` || document.getElementById('w-web3-mismatch').style.display !== 'none'`,
    'the one-signature reconnect settled (verified switch or hard stop)');
  check(await r.evaluate(`document.getElementById('w-wallet-note').textContent.includes('Re-derived and verified')`),
    'era-1 source re-derives and MATCHES on an era-2 origin');
  const sent = JSON.parse(await r.evaluate('JSON.stringify(window.__signed)'));
  check(sent.length === 1, `reconnect asked for exactly one signature (got ${sent.length})`);
  // the mechanism, not just the outcome: the bytes on the wire were v1's
  check(sent[0] === V1_HEX, 'and it signed the V1 bytes — the ones the record says made this wallet');
  check(!sent.includes(MSG_HEX), 'the era-2 v3 bytes were never sent for an era-1 record');
  check(await r.evaluate(hidden('w-web3-mismatch')), 'no mismatch screen — the extension is not accused');
  // openWalletModal() has rendered the switcher by now (that is what the note
  // above lives in), so the row count is the post-reconnect vault
  const after = await r.evaluate(`document.querySelectorAll('#w-wallet-list .wal-row').length`);
  check(after === seedState.wallets, `verified switch, no duplicate wallet (${seedState.wallets} → ${after})`);
}

console.log(process.exitCode ? 'RED' : 'ALL GREEN');
server.close();
process.exit(process.exitCode || 0);
