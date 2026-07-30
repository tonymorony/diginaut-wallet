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

// The frozen derivation messages. Consensus-grade: any byte change derives a
// DIFFERENT wallet for every user (tests pin the SHA-256 of each).
//
// ADR 0005 — the bytes name their network, so a signature produced on one
// network can NEVER be replayed against the other's funds. That is the whole
// point and it is not a copy detail: the derivation signature is phishable by
// construction (any site can present the same bytes), so a testnet-era
// signature captured anywhere must be worthless against mainnet. Reusing v1 on
// mainnet would also ask a user standing on diginaut.ludere.space to sign a
// message whose own last line tells them to refuse exactly that.
//
// ADR 0006 — the bytes also name their ORIGIN, so moving to a new domain mints
// NEW versions instead of rewriting these. v1/v2 stay byte-frozen forever; the
// serving hostname picks which pair is live (s2dForChain below).
//
// The cost, accepted in ADR 0005 and widened by ADR 0006: one source wallet
// derives one Diginaut wallet per (network, origin era). That asymmetry with
// restored mnemonics is deliberate.
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

// v2 = mainnet. Same shape as v1, every network-naming line re-pointed; the two
// risk sentences are byte-identical on purpose, so a reader who has seen one
// recognises the other.
export const S2D_VERSION_MAIN = 2;
export const S2D_MESSAGE_MAIN = [
  'Diginaut sign-to-derive v2',
  'Network: DigiByte mainnet',
  'Origin: https://diginaut.ludere.space',
  '',
  'This signature generates the private keys of your DigiByte wallet.',
  'Anyone who obtains this signature can steal your DigiByte funds.',
  'Only sign this message on https://diginaut.ludere.space. If any other site asks for this signature, refuse.',
].join('\n');

// v3/v4 = the diginaut.space era (ADR 0006, 2026-07-31). Same shape and the
// same two byte-identical risk sentences as v1/v2; only the network- and
// origin-naming lines move. They exist because the messages pin their origin:
// serving v1 on testnet.diginaut.space would hand a user a message whose own
// last line tells them to refuse it there, and re-pointing v1's Origin line
// instead would re-derive every existing wallet.
export const S2D_VERSION_TESTNET2 = 3;
export const S2D_MESSAGE_TESTNET2 = [
  'Diginaut sign-to-derive v3',
  'Network: DigiByte testnet',
  'Origin: https://testnet.diginaut.space',
  '',
  'This signature generates the private keys of your DigiByte wallet.',
  'Anyone who obtains this signature can steal your DigiByte funds.',
  'Only sign this message on https://testnet.diginaut.space. If any other site asks for this signature, refuse.',
].join('\n');

export const S2D_VERSION_MAIN2 = 4;
export const S2D_MESSAGE_MAIN2 = [
  'Diginaut sign-to-derive v4',
  'Network: DigiByte mainnet',
  'Origin: https://diginaut.space',
  '',
  'This signature generates the private keys of your DigiByte wallet.',
  'Anyone who obtains this signature can steal your DigiByte funds.',
  'Only sign this message on https://diginaut.space. If any other site asks for this signature, refuse.',
].join('\n');

/** The hosts that still derive from the v1/v2 bytes. PERMANENT — never remove a
 *  host from this set. Every wallet ever derived on dgb.ludere.space or
 *  diginaut.ludere.space came from those bytes; dropping a host here would
 *  silently start deriving DIFFERENT wallets at an address that still serves the
 *  old vaults, with no error anywhere. Adding the new domains is not the move
 *  either: they mint their own era, which is the whole point of ADR 0006. */
export const LEGACY_S2D_HOSTS = new Set(['dgb.ludere.space', 'diginaut.ludere.space']);

/** The frozen message a CHAIN derives from on THIS origin — first derive only.
 *
 *  Two axes, both allow-lists, never deny-lists:
 *  - era, by hostname: the two legacy hosts keep v1/v2 forever; everything else
 *    (the new domains, localhost, any self-host) is the current era, v3/v4. The
 *    unknown case has to be the NEW era — a self-host that fell to v1 would be
 *    handing out wallets under an origin line naming a site it is not.
 *  - network, BOTH spellings, for the same reason betaCapError takes both: the
 *    node says 'main', the wallet's netName says 'mainnet', and a mixed-up
 *    caller here would silently derive the testnet wallet on mainnet. An
 *    unrecognised chain falls to the TESTNET message of the selected era, which
 *    cannot touch mainnet funds. */
export function s2dForChain(chain, hostname = globalThis.location?.hostname) {
  const main = chain === 'main' || chain === 'mainnet';
  if (LEGACY_S2D_HOSTS.has(String(hostname ?? ''))) {
    return main
      ? { version: S2D_VERSION_MAIN, message: S2D_MESSAGE_MAIN }
      : { version: S2D_VERSION, message: S2D_MESSAGE };
  }
  return main
    ? { version: S2D_VERSION_MAIN2, message: S2D_MESSAGE_MAIN2 }
    : { version: S2D_VERSION_TESTNET2, message: S2D_MESSAGE_TESTNET2 };
}

/** The frozen message a STORED wallet was derived from. Re-derivation must use
 *  the version on the source record, not the current chain or origin: verifying
 *  "does this extension still reproduce THIS wallet" has to re-sign the same
 *  bytes that made it, or a v1 wallet inspected on mainnet would report a
 *  mismatch that is really just the other network's message. */
export function s2dForVersion(version) {
  switch (Number(version)) {
    case S2D_VERSION_MAIN: return { version: S2D_VERSION_MAIN, message: S2D_MESSAGE_MAIN };
    case S2D_VERSION_TESTNET2: return { version: S2D_VERSION_TESTNET2, message: S2D_MESSAGE_TESTNET2 };
    case S2D_VERSION_MAIN2: return { version: S2D_VERSION_MAIN2, message: S2D_MESSAGE_MAIN2 };
    // legacy records carry no msgVersion at all — they are v1 by construction
    default: return { version: S2D_VERSION, message: S2D_MESSAGE };
  }
}

const ORIGIN_PREFIX = 'Origin: ';

/** The host a frozen message pins, read OUT of the message. The ceremony's
 *  "only <host> may ever ask for this signature" checkbox is rendered from this
 *  — never from a second constant. A hardcoded host is exactly what made the
 *  mainnet ceremony name the TESTNET domain from the day the mainnet door
 *  shipped: the message moved, the sentence beside it did not, and nothing in
 *  the tests or the drivers could notice. */
export function s2dOriginHost(message) {
  const line = String(message ?? '').split('\n').find((l) => l.startsWith(ORIGIN_PREFIX));
  if (!line) throw new Error('internal: derivation message has no Origin line');
  return new URL(line.slice(ORIGIN_PREFIX.length)).host;
}

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
async function signOnce(entry, address, message) {
  // Explicit, never defaulted: a missing argument here would silently sign the
  // testnet bytes on mainnet, which is the one mistake ADR 0005 exists to stop.
  if (typeof message !== 'string' || !message) throw new Error('internal: no derivation message for this network');
  const msgBytes = te.encode(message);
  if (entry.kind === 'evm') {
    const hexMsg = '0x' + bytesToHex(msgBytes);
    const sigHex = await entry.provider.request({ method: 'personal_sign', params: [hexMsg, address] });
    const { rs, recid } = canonicalizeEvmSignature(sigHex);
    // The digest MUST be of the bytes we just asked them to sign. recoverEthAddress
    // defaults to the v1 message, so omitting this recovers a different address on
    // mainnet and fails every honest signer with the smart-account refusal.
    const recovered = recoverEthAddress(rs, recid, eip191Digest(msgBytes));
    if (recovered !== String(address).toLowerCase()) {
      throw new Error('the connected account is a smart account or did not sign itself — only plain key wallets can derive');
    }
    return rs;
  }
  const res = await entry.provider.signMessage(msgBytes, 'utf8');
  const sig = res?.signature instanceof Uint8Array ? res.signature
    : res?.signature ? Uint8Array.from(Object.values(res.signature)) : null;
  if (!sig || !verifySolanaSignature(sig, address, msgBytes)) throw new Error('Phantom returned an invalid signature');
  return sig;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Connect the source and return its signing account — no signature yet, so
 * the caller can decide between the first-derive ceremony (unknown account)
 * and the one-signature reconnect verification (known account, #129). */
export async function connectAccount(entry) {
  if (entry.kind === 'evm') {
    const accounts = await entry.provider.request({ method: 'eth_requestAccounts' });
    const address = String(accounts?.[0] ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${entry.brand} returned no account`);
    return address;
  }
  const conn = await entry.provider.connect();
  const address = String(conn?.publicKey ?? entry.provider.publicKey ?? '');
  if (!address) throw new Error('Phantom returned no account');
  return address;
}

// Signature bytes and entropy are key material: derive everything, then zero
// the buffers (best-effort in JS). Nothing in this module is ever logged.
async function packageDerived(entry, address, canonical, msgVersion) {
  const entropy = await entropyFromSignature(canonical);
  try {
    const mnemonic = mnemonicFromEntropy(entropy);
    const fp = await fingerprintOfEntropy(entropy);
    return {
      mnemonic,
      // msgVersion is what makes a derived wallet re-derivable years later: it
      // records WHICH frozen bytes produced this seed, so a reconnect re-signs
      // the same message even if the user is on the other network.
      source: { kind: entry.kind, rdns: entry.rdns, brand: entry.brand, address, msgVersion, fp },
    };
  } finally {
    entropy.fill(0);
  }
}

/** Reconnect verification (#129, spec §8): ONE signature, no ceremony — the
 * stored fingerprint is the cross-check on this path, not the double-sign. */
export async function deriveOnce(entry, address, msgVersion = S2D_VERSION) {
  const { version, message } = s2dForVersion(msgVersion);
  const sig = await signOnce(entry, address, message);
  try {
    return await packageDerived(entry, address, sig, version);
  } finally {
    sig.fill(0);
  }
}

/** The full first-derive ceremony. onStep(name) fires as the wizard advances
 * ('sign1' | 'sign2' | 'verify') so the UI can render the step machine.
 * Resolves { mnemonic, source } or throws with user-facing copy. */
export async function deriveFromSource(entry, { onStep = () => {}, address = null, chain = null } = {}) {
  // First derive picks by CHAIN — this is the moment the wallet is born, and
  // which network it is born on decides which frozen bytes own it forever.
  const { version, message } = s2dForChain(chain);
  const account = address ?? await connectAccount(entry);
  onStep('sign1');
  const first = await signOnce(entry, account, message);
  try {
    onStep('sign2');
    const second = await signOnce(entry, account, message);
    const secondMatches = sameBytes(first, second);
    second.fill(0);
    onStep('verify');
    if (!secondMatches) {
      // dYdX-v4-style refusal, brand by name: an MPC (or otherwise
      // non-deterministic) signer can never re-derive this wallet — deriving
      // once would strand the funds behind a signature that never comes back.
      throw new Error(`${entry.brand} does not sign deterministically (this is typical of MPC wallets). It cannot derive a recoverable wallet.`);
    }
    return await packageDerived(entry, account, first, version);
  } finally {
    first.fill(0);
  }
}
