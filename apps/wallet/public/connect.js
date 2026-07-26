// Sign-to-derive — a Diginaut wallet from a web3 extension signature.
// Implements docs/discovery/sign-to-derive.md §Protocol decision byte-for-byte;
// custody semantics per #129. Everything here runs client-side: no Ethereum or
// Solana RPC exists in this app, so admission is structural — length gate,
// local ecrecover (EVM) / strict ed25519.verify (Solana), the double-sign
// equality check, and the reconnect fingerprint. The double-sign check is the
// ONLY layer that catches MPC signers (their nonces are random by
// construction) — it is load-bearing, never an optimization target.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base58 } from '@scure/base';

// The frozen v1 derivation message. Consensus-grade: any byte change derives a
// DIFFERENT wallet for every user (test pins the SHA-256). Mainnet gets a v2
// message with its own bytes — derived seeds never span networks (ADR 0005).
export const S2D_VERSION = 1;
export const S2D_MESSAGE = [
  'Diginaut sign-to-derive v1',
  'Network: DigiByte testnet',
  'Origin: https://dgb.ludere.space',
  '',
  'This signature generates the private keys of your DigiByte wallet.',
  'Anyone who obtains this signature can steal your DigiByte funds.',
  'Only sign this message on https://dgb.ludere.space. If any other site asks for this signature, refuse.',
].join('\n');

const te = new TextEncoder();
const SECP_N = secp256k1.Point.Fn.ORDER;
const HALF_N = SECP_N >> 1n;

const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex) => {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('not a hex signature');
  return Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
};
const bytesToBig = (b) => BigInt('0x' + (bytesToHex(b) || '0'));
const bigTo32 = (n) => hexToBytes(n.toString(16).padStart(64, '0'));

/** EIP-191 personal_sign digest of the frozen message (or any bytes). The
 * length prefix is the DECIMAL byte length, per go-ethereum's TextAndHash. */
export function eip191Digest(messageBytes = te.encode(S2D_MESSAGE)) {
  const prefix = te.encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const all = new Uint8Array(prefix.length + messageBytes.length);
  all.set(prefix, 0);
  all.set(messageBytes, prefix.length);
  return keccak_256(all);
}

/** Parse + canonicalize a personal_sign result. Fail-closed: anything that is
 * not exactly 65 bytes with a sane recovery id is refused (smart accounts,
 * ERC-6492 wrappers, passkey signers, suffixed encodings all die here).
 * Returns { rs: 64-byte canonical low-s r‖s, recid } — the ONLY form that
 * feeds the entropy hash and the double-sign comparison, so v-byte and
 * high-s re-encodings can never fork the derived seed. */
export function canonicalizeEvmSignature(sigHex) {
  const raw = hexToBytes(String(sigHex ?? ''));
  if (raw.length !== 65) throw new Error('not a plain key-wallet signature (expected 65 bytes)');
  const r = bytesToBig(raw.subarray(0, 32));
  let s = bytesToBig(raw.subarray(32, 64));
  const v = raw[64];
  let recid = v >= 27 ? v - 27 : v;
  if (recid !== 0 && recid !== 1) throw new Error('unsupported signature recovery id');
  if (r <= 0n || r >= SECP_N || s <= 0n || s >= SECP_N) throw new Error('signature values out of range');
  if (s > HALF_N) { s = SECP_N - s; recid ^= 1; } // low-s canonicalization flips the parity
  const rs = new Uint8Array(64);
  rs.set(bigTo32(r), 0);
  rs.set(bigTo32(s), 32);
  return { rs, recid };
}

/** Local ecrecover: the connected address must be the key that signed. This is
 * the structural refusal of EIP-1271 / ERC-4337 signers — they have no key
 * that recovers to the account address. EIP-7702-delegated EOAs pass (the EOA
 * keeps its key), which is correct and deliberate. */
export function recoverEthAddress(rs, recid, digest = eip191Digest()) {
  const sig = secp256k1.Signature.fromBytes(rs, 'compact').addRecoveryBit(recid);
  const uncompressed = sig.recoverPublicKey(digest).toBytes(false); // 0x04 ‖ X ‖ Y
  return '0x' + bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12));
}

/** Strict RFC 8032 verify for the Phantom/Solana path (zip215:false). */
export function verifySolanaSignature(sig, pubkeyBase58, messageBytes = te.encode(S2D_MESSAGE)) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  let pub;
  try { pub = base58.decode(String(pubkeyBase58 ?? '')); } catch { return false; }
  if (pub.length !== 32) return false;
  try { return ed25519.verify(sig, messageBytes, pub, { zip215: false }); } catch { return false; }
}

/** 64 canonical signature bytes → 32 bytes of BIP39 entropy. One SHA-256, no
 * grinding, no reduction — the IMX grindKey incident class cannot exist here. */
export async function entropyFromSignature(bytes64) {
  if (bytes64.length !== 64) throw new Error('entropy input must be 64 bytes');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes64));
}

/** Entropy → the derived wallet's 24-word mnemonic (native wallets are
 * 12-word — the length difference is a deliberate visible class marker). */
export const mnemonicFromEntropy = (entropy) => entropyToMnemonic(entropy, wordlist);

/** 4-byte drift-detection fingerprint of the derived seed, stored ENCRYPTED in
 * the vault sources record and re-checked on every reconnect. 32 bits: drift
 * false-match odds 2^-32, secret leakage nil (2^224 head-room remains). */
export async function fingerprintOfEntropy(entropy) {
  const tagged = new Uint8Array([...te.encode('diginaut-s2d-fp:'), ...entropy]);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', tagged)).subarray(0, 4));
}

export const shortAddress = (a) => (a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

// ---- Browser-side provider plumbing (EIP-6963 + Phantom) ----

/** Collect EIP-6963 announcements. Vanilla two-event protocol — no connector
 * library, by decision (#127 §1). No window.ethereum fallback: the source
 * fingerprint requires a stable rdns. Phantom's EVM provider is filtered out —
 * Phantom is hard-routed to its Solana path (#129), one Phantom = one wallet. */
export function discoverProviders({ timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const found = new Map(); // rdns → { info, provider }
    const onAnnounce = (e) => {
      const { info, provider } = e.detail ?? {};
      if (info?.rdns && provider && info.rdns !== 'app.phantom') found.set(info.rdns, { info, provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const list = [...found.values()].map(({ info, provider }) => ({
        kind: 'evm', rdns: info.rdns, brand: info.name, icon: info.icon, provider,
      }));
      const phantom = window.phantom?.solana;
      if (phantom) list.push({ kind: 'sol', rdns: 'app.phantom', brand: 'Phantom', icon: null, provider: phantom });
      resolve(list);
    }, timeoutMs);
  });
}

/** One signature from the source, chain-appropriately. Returns the 64 canonical
 * bytes that feed everything downstream, after the structural admission checks. */
async function signOnce(entry, address) {
  if (entry.kind === 'evm') {
    const hexMsg = '0x' + bytesToHex(te.encode(S2D_MESSAGE));
    const sigHex = await entry.provider.request({ method: 'personal_sign', params: [hexMsg, address] });
    const { rs, recid } = canonicalizeEvmSignature(sigHex);
    const recovered = recoverEthAddress(rs, recid);
    if (recovered !== String(address).toLowerCase()) {
      throw new Error('the connected account is a smart account or did not sign itself — only plain key wallets can derive');
    }
    return rs;
  }
  const res = await entry.provider.signMessage(te.encode(S2D_MESSAGE), 'utf8');
  const sig = res?.signature instanceof Uint8Array ? res.signature
    : res?.signature ? Uint8Array.from(Object.values(res.signature)) : null;
  if (!sig || !verifySolanaSignature(sig, address)) throw new Error('Phantom returned an invalid signature');
  return sig;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The full derive ceremony for a picked source. onStep(name) fires as the
 * wizard advances ('sign1' | 'sign2' | 'verify') so the UI can render the
 * step machine. Resolves { mnemonic, source } or throws with user-facing copy.
 * Signature bytes are treated as key material: canonical copies are zeroed
 * before return (best-effort in JS), and nothing here is ever logged. */
export async function deriveFromSource(entry, { onStep = () => {} } = {}) {
  let address;
  if (entry.kind === 'evm') {
    const accounts = await entry.provider.request({ method: 'eth_requestAccounts' });
    address = String(accounts?.[0] ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${entry.brand} returned no account`);
  } else {
    const conn = await entry.provider.connect();
    address = String(conn?.publicKey ?? entry.provider.publicKey ?? '');
    if (!address) throw new Error('Phantom returned no account');
  }
  onStep('sign1');
  const first = await signOnce(entry, address);
  onStep('sign2');
  const second = await signOnce(entry, address);
  onStep('verify');
  if (!sameBytes(first, second)) {
    // dYdX-v4-style refusal, brand by name: an MPC (or otherwise
    // non-deterministic) signer can never re-derive this wallet — deriving
    // once would strand the funds behind a signature that never comes back.
    throw new Error(`${entry.brand} does not sign deterministically (this is typical of MPC wallets). It cannot derive a recoverable wallet.`);
  }
  const entropy = await entropyFromSignature(first);
  const mnemonic = mnemonicFromEntropy(entropy);
  const fp = await fingerprintOfEntropy(entropy);
  first.fill(0);
  second.fill(0);
  return {
    mnemonic,
    source: { kind: entry.kind, rdns: entry.rdns, brand: entry.brand, address, msgVersion: S2D_VERSION, fp },
  };
}
