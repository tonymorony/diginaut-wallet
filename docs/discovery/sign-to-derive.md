# Discovery: sign-to-derive — seeding a Diginaut wallet from a web3 extension signature

Date: 2026-07-26. Question: can a user derive their Diginaut (DigiByte testnet) wallet from a
signature made by a connected browser-extension wallet (MetaMask, Phantom, OKX, Rabby, any
EIP-6963 wallet) — with **no Ethereum or Solana RPC access**, every check client-side?

Sourced from primary material only: wallet source code fetched from the owning repos, EIPs/RFCs,
first-party docs, and this repo's own files (cited by path). Anything a primary source did not
establish is marked **UNVERIFIED**. Prior-art SDK files quoted below were fetched raw from GitHub.

## Verdict: feasible, client-side only, with ZERO new dependencies — but the double-sign check is load-bearing, not belt-and-suspenders

1. **Everything the protocol needs is already vendored** (`apps/wallet/vendor.lock`, served
   under `/vendor/` and boot-verified — `apps/wallet/vendor-integrity.js`): `@noble/curves` 2.2.0
   has secp256k1 ECDSA **public-key recovery** (`abstract/weierstrass.js:1191-1196`,
   `addRecoveryBit`/`recoverPublicKey`) and **ed25519.verify** (strict RFC 8032 via
   `{zip215:false}`, `abstract/edwards.js:124-136`); `@noble/hashes` 2.2.0 has `keccak_256`
   (`sha3.js`) for the EIP-191 digest and address derivation; `@scure/bip39` 2.2.0 exports
   `entropyToMnemonic` (`index.js:125`); `@scure/base` exports `base58` (Phantom pubkeys).
   WebCrypto `crypto.subtle` SHA-256 does the entropy hash. The import map
   (`apps/wallet/public/index.html:1036-1046`) already maps every package.
2. **Safe wallets (verified deterministic, RFC 6979, identical output shape):** MetaMask software
   keyring, Ledger-via-MetaMask, Trezor-via-MetaMask, Rabby. All emit 65-byte `r‖s‖v`, v=27/28,
   low-s, lowercase 0x hex. **Phantom-Solana** is Ed25519 — deterministic by RFC 8032
   construction. **OKX extension and Phantom-EVM are closed source — determinism UNVERIFIED**;
   they are admissible only because the double-sign gate applies to everyone.
3. **The three-layer refusal model works without any RPC** (§3): a 65-byte length check plus
   local ecrecover structurally rejects Safe/EIP-1271, ERC-4337, ERC-6492 and passkey wallets;
   the **double-sign check is the ONLY layer that catches MPC wallets** (threshold-ECDSA nonces
   are random by construction — verified in ZenGo and Fireblocks source); the stored fingerprint
   catches cross-session drift. EIP-7702-upgraded EOAs correctly pass — the EOA keeps its key.
4. **Framing correction:** no primary source supports a "Ledger 2023 personal_sign change" that
   altered signature bytes. The `LedgerHQ/app-ethereum` changelog shows 1.9.19/1.9.20/1.10.0
   changed message **display** and moved EIP-712 **hashing** on-device — not output bytes for the
   same input, and its tracker has no Immutable/Loopring/stark issue. The documented
   non-deterministic hardware signer was **GridPlus Lattice1** (random-nonce ECDSA until firmware
   v0.12.0, 2021-10-27). Treat "Ledger broke IMX/Loopring keys" as community lore (§5).
5. **No connector library** (§1): RainbowKit is React-only; wagmi/AppKit drag in a dependency
   tree plus a WalletConnect cloud projectId and hosted relay — all incompatible with the
   zero-runtime-deps + `vendor.lock` posture. EIP-6963 discovery is two window events,
   implementable first-party in ~30 lines. Accepted tradeoff: desktop extensions only.

## 0. What exists in the repo today (grounding)

- Mnemonic path: `packages/digidollar-js/src/hd.js:5-6` imports `@scure/bip39` + english
  wordlist; `generateMnemonic()` is 12-word/128-bit (`hd.js:22-24`); `mnemonicToSeed` is standard
  BIP39 PBKDF2 (`hd.js:32-34`); addresses are BIP86 `m/86'/coinType'/account'/change/index`,
  coinType 20 mainnet / 1 testnet+regtest (`hd.js:15-19,52-66`). A derived 24-word mnemonic drops
  into the existing `addWallet({name, mnemonic, backedUp})` flow unchanged
  (`apps/wallet/public/vault.js:190`), including the duplicate-mnemonic guard (`vault.js:15-17`).
- Vault: v2 keystore, PBKDF2-SHA256 600k → AES-256-GCM (`apps/wallet/public/keystore.js:2`);
  `meta` (wallet names, `backedUp`) is **cleartext while locked** by design
  (`docs/specs/wallet-management-v2.md:24-26`); secrets (mnemonics) are ciphertext. This split
  decides where the source fingerprint lives (§8).
- No web3/wallet-connect code exists anywhere in `apps/wallet/public/` — greenfield.

## 1. Connector layer: vanilla EIP-6963, no library

- [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963): dapp dispatches `eip6963:requestProvider`,
  wallets answer with `eip6963:announceProvider` carrying `{uuid, name, icon, rdns}` + the
  EIP-1193 provider. The spec's reference implementation is bare `window` event listeners — no
  library. The `rdns` (e.g. `io.metamask`) is exactly the brand identifier the fingerprint needs.
- **Reject RainbowKit**: "RainbowKit is a React library", peer-deps `wagmi viem
  @tanstack/react-query` + WalletConnect Cloud projectId
  ([rainbowkit.com/docs/installation](https://rainbowkit.com/docs/installation)). Diginaut is
  vanilla JS.
- **Reject wagmi / Reown AppKit (WalletConnect)**: requires a projectId from dashboard.reown.com
  and adapter packages ([docs.reown.com](https://docs.reown.com/appkit/javascript/core/installation));
  WalletConnect's transport is a hosted relay — a third-party network dependency and an
  unvendorable tree in a wallet that refuses to boot on a single drifted vendored byte
  (`apps/wallet/server.js:52-67`). WalletConnect is also the main road by which Safe multisig
  connects — the class §3 refuses anyway. Cost of rejection: no mobile-wallet-via-QR (§10 Q2).
- Phantom: announces its **EVM** provider via EIP-6963 and exposes Solana at
  `window.phantom.solana` ([docs.phantom.com](https://docs.phantom.com/solana/signing-a-message)).
  Route `rdns` = `app.phantom` to the Solana path (§2, §10 Q3).

## 2. Signature determinism per wallet

Each open-source path was traced link-by-link to the code that computes k.

| Wallet / path | Signing stack (verified) | Deterministic | v byte | low-s | Hex |
|---|---|---|---|---|---|
| MetaMask (software keyring) | SignatureController → KeyringController → keyring-eth-hd → `@metamask/eth-sig-util` `personalSign` → `@ethereumjs/util` `ecsign` → `ethereum-cryptography` → `@noble/curves` secp256k1 | **Yes — RFC 6979** (noble default, `extraEntropy:false`) | 27/28 | Yes (noble `lowS:true` default) | `0x`+lowercase |
| MetaMask + Ledger | app-ethereum `bip32_derive_ecdsa_sign_rs_hash_256(CX_CURVE_256K1, …, CX_RND_RFC6979\|CX_LAST, CX_SHA256, …)`; v = `ETHEREUM_SIGNATURE_V_BASE` (=27) + parity; `hw-app-eth` passes `response[0]` through; MM keyring re-normalizes 0/1→27/28 defensively | **Yes — RFC 6979** in firmware | 27/28 (29/30 on the ~2⁻¹²⁷ r≥n edge) | Yes (SDK canonicalizes unless `CX_NO_CANONICAL`; not set) | lowercase |
| MetaMask + Trezor | trezor-firmware `sign_message.py` → trezor-crypto `ecdsa_sign_digest` (`USE_RFC6979 1` default); binding emits `27 + pby`; `CANONICAL_SIG_ETHEREUM` rejects recid≥2 (k-retry) | **Yes — RFC 6979** | 27/28 | Yes (unconditional s>n/2 negation) | `0x` by keyring (casing of Connect hexlify UNVERIFIED) |
| Rabby (built-in keyring) | `@rabby-wallet/eth-simple-keyring@5.1.2` line 315: `sigUtil.personalSign(…)` — pins `@metamask/eth-sig-util@8.2.0`, same noble path as MetaMask | **Yes — RFC 6979** | 27/28 | Yes | `0x`+lowercase |
| OKX extension | Closed source. First-party doc: the MPC "keyless wallet" service on the **extension was suspended 2025-04-07** (continues in the app) — [okx.com help](https://www.okx.com/en-us/help/what-is-okx-keyless-wallet) | **UNVERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Phantom — Solana `signMessage` | Ed25519 over the raw message bytes; verify with `nacl.sign.detached.verify` per [docs.phantom.com](https://docs.phantom.com/solana/signing-a-message) | **Yes — RFC 8032** (§5.1.6: r = SHA-512(prefix‖M); no randomness input exists; §8.2 "EdDSA signatures are deterministic") | n/a — 64-byte detached sig | n/a | n/a |
| Phantom — EVM `personal_sign` | Closed source; API first-party-documented (EIP-1193, hex-encoded message) | **UNVERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED |

Key sources: [eth-sig-util personal-sign.ts](https://github.com/MetaMask/eth-sig-util/blob/main/src/personal-sign.ts),
[ethereumjs util@8.1.0 signature.ts](https://github.com/ethereumjs/ethereumjs-monorepo/blob/%40ethereumjs/util%408.1.0/packages/util/src/signature.ts)
(`v = recovery + 27`), [ethereum-cryptography 2.1.2 secp256k1.ts](https://github.com/ethereum/js-ethereum-cryptography/blob/2.1.2/src/secp256k1.ts)
(one-line re-export of noble), [noble-curves weierstrass.ts](https://github.com/paulmillr/noble-curves/blob/main/src/abstract/weierstrass.ts)
(RFC 6979 HMAC-DRBG; low-s negation flips recovery bit),
[app-ethereum ui_common_sign_message.c](https://github.com/LedgerHQ/app-ethereum/blob/develop/src/features/sign_message/ui_common_sign_message.c),
[shared_context.h](https://github.com/LedgerHQ/app-ethereum/blob/develop/src/shared_context.h) (`V_BASE 27`),
[ledger-secure-sdk cx_ecdsa.c](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/lib_cxng/src/cx_ecdsa.c),
[trezor sign_message.py](https://github.com/trezor/trezor-firmware/blob/main/core/src/apps/ethereum/sign_message.py),
[modtrezorcrypto-secp256k1.h](https://github.com/trezor/trezor-firmware/blob/main/core/embed/upymod/modtrezorcrypto/modtrezorcrypto-secp256k1.h),
[trezor-crypto ecdsa.c + options.h](https://github.com/trezor/trezor-firmware/blob/main/crypto/ecdsa.c),
[Rabby keyring service](https://github.com/RabbyHub/Rabby/blob/develop/src/background/service/keyring/index.ts) (+ npm tarball of
`@rabby-wallet/eth-simple-keyring@5.1.2`), [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032).

### Normalization variance — why entropy must come from canonicalized r‖s only

Even among deterministic signers, the same (r,s) scalars can render differently:

- **v byte**: all verified paths emit 27/28 today, but 0/1 exists in the wild — dYdX shipped
  recovery machinery rotating `'00'↔'1b'`/`'01'↔'1c'` because both occurred
  ([v3-client PR #215](https://github.com/dydxprotocol/v3-client/pull/215)), and Loopring's SDK
  patches `'1c'↔'01'` with the comment "I don't know why this is needed"
  ([generateKeyPair.ts](https://github.com/loopexchange-labs/loopring-sdk/blob/main/packages/loopring-sdk/src/lib/generateKeyPair.ts)).
  **Exclude v from the hash input.**
- **low-s**: [EIP-2](https://eips.ethereum.org/EIPS/eip-2) is a TRANSACTION consensus rule; for
  `personal_sign` low-s is library convention only (consistently implemented in every verified
  stack). Canonicalize s before hashing anyway (§7) so a high-s re-encoding maps to the same seed.
- **hex**: MetaMask/Rabby/Ledger paths emit `0x`+lowercase; no examined wallet emits uppercase or
  drops `0x`; none returns EIP-2098 compact 64-byte sigs. Decode case-insensitively regardless.
- **suffix bytes**: Loopring's SDK appends `"02"` ("Needed when Loopring Wallet doesn't add it")
  — evidence that wallets have appended trailer bytes. The strict 65-byte length gate rejects it.

## 3. Refusal rules without an RPC — what each layer catches

[EIP-191](https://eips.ethereum.org/EIPS/eip-191) prefix: `0x19 ‖ 0x45('E') ‖ "thereum Signed
Message:\n" + len(message) ‖ message`, keccak256. The EIP text never says "decimal" — that is
fixed by the reference implementation it cites, go-ethereum `accounts.TextAndHash`:
`fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(data), data)` — decimal ASCII of the
**byte** length ([accounts.go](https://github.com/ethereum/go-ethereum/blob/master/accounts/accounts.go)).
The RPC message param is hex-encoded bytes; the wallet displays the UTF-8 decoding; params order
`[message, address]` ([MetaMask sign docs](https://docs.metamask.io/wallet/how-to/sign-data/)).

| Wallet class | `personal_sign` returns | ecrecover==addr? | Caught by |
|---|---|---|---|
| Plain EOA (MetaMask, Rabby, Ledger/Trezor via extension) | 65-byte EOA sig over the EIP-191 digest | Yes | **Accepted** (intended) |
| EIP-7702-upgraded EOA (MetaMask Smart Account) | Same — the EOA retains its key | Yes | **Accepted** — see below |
| Safe via WalletConnect | EIP-1271 flow: owner sigs over the EIP-712-wrapped SafeMessage, validated only via on-chain `isValidSignature` (magic `0x1626ba7e`); multisig-over-WC currently fails outright ([safe-wallet-monorepo #7178](https://github.com/safe-global/safe-wallet-monorepo/issues/7178), user-reported) | No — a Safe has no key; an owner sig recovers to the owner, and it signs the SafeMessage digest, not our digest → recovers to a pseudorandom address either way | **ecrecover** (structural) |
| ERC-4337 smart account, deployed (Coinbase Smart Wallet) | ABI-encoded `SignatureWrapper` (ERC-1271-style), never 65 bytes ([coinbase/smart-wallet](https://github.com/coinbase/smart-wallet)) | No | **length + ecrecover** |
| ERC-4337 pre-deploy | [ERC-6492](https://eips.ethereum.org/EIPS/eip-6492) wrapper `abi.encode(…) ‖ 0x6492…6492` (32-byte magic suffix, ≥224 bytes; verification requires `eth_call`) | No | **length** (structural) |
| MPC / threshold-ECDSA (ZenGo, Fireblocks, OKX-MPC, Coinbase WaaS) | Ordinary 65-byte sig; address = aggregate pubkey | **Yes — passes ecrecover** | **double-sign ONLY** |
| Passkey/WebAuthn signers | P-256 assertion over `authenticatorData ‖ hash(clientDataJSON)` — wrong curve, and the payload embeds a per-request challenge + signCount ([W3C WebAuthn](https://www.w3.org/TR/webauthn-3/)) | No | **length + ecrecover** |

- **EIP-7702** ([spec](https://eips.ethereum.org/EIPS/eip-7702)): sets account code to the
  delegation indicator `0xef0100 ‖ address`; authorization tuples are themselves validated by
  `ecrecover` of the EOA key, and Security Considerations note the account can revoke/sweep with
  that key — the key retains full signing power. MetaMask first-party: "Your funds don't move and
  your account(s) are still governed by your SRP/private keys", "It still remains an EOA"
  ([support.metamask.io](https://support.metamask.io/configure/accounts/what-is-a-smart-account/)).
  **UNVERIFIED**: no doc says verbatim "personal_sign is unchanged after upgrade", and no
  evidence any 7702 wallet routes `personal_sign` through the delegate — the ecrecover +
  double-sign gates are the guarantee either way.
- **MPC nonce randomness is structural, not incidental**: GG18 signing Phase 1 draws
  `ki, γi ∈R Zq` ([eprint 2019/114](https://eprint.iacr.org/2019/114)); CGGMP21 presigns nonces
  **before the message is known** ([eprint 2021/060](https://eprint.iacr.org/2021/060)) — a nonce
  fixed pre-message cannot be RFC 6979. Verified in vendor code: ZenGo
  [`k_i: Scalar::random()`](https://github.com/ZenGo-X/multi-party-ecdsa/blob/master/src/protocols/multi_party_ecdsa/gg_2018/party_i.rs),
  ZenGo 2P [`ECScalar::new_random()`](https://github.com/ZenGo-X/two-party-ecdsa/blob/master/src/party_two.rs),
  Fireblocks [`algebra->rand(…&data.k…)`](https://github.com/fireblocks/mpc-lib/blob/main/src/common/cosigner/cmp_ecdsa_signing_service.cpp).
  Two signings of the same message give different (r,s) with overwhelming probability. **This is
  the only layer that catches them — double-sign is load-bearing.**
- **Ed25519 path**: verify the 64-byte signature against the connected pubkey with
  `ed25519.verify(sig, msg, pub, {zip215:false})` (strict RFC 8032) — rejects a wrong-key or
  malformed response; determinism then needs no extra trust (RFC 8032 §8.2), but run the
  double-sign anyway (uniform ceremony; catches a non-compliant impersonating provider).
- Hypothesis check: (a) **confirmed and sharpened** — add the strict 65-byte gate before
  ecrecover; (b) **confirmed and upgraded** — double-sign is the sole MPC defense; (c)
  **confirmed** — 7702 EOAs pass and are safe to allow.

## 4. Prior art

- **zkSync Lite** — message `'Access zkSync account.\n\nOnly sign this message for a trusted
  client!'` (+ `\nChain ID: N.` on non-mainnet), plain `personal_sign`
  ([signer.ts](https://raw.githubusercontent.com/matter-labs/zksync/master/sdk/zksync.js/src/signer.ts)).
  Seed = the **entire 65-byte signature** (v included); `privateKeyFromSeed` = iterated
  SHA-256 with rejection sampling into the alt-BabyJubjub field
  ([zksync-crypto lib.rs](https://raw.githubusercontent.com/matter-labs/zksync/master/sdk/zksync-crypto/src/lib.rs)).
  Contract wallets classified via EIP-1271 (`getEthSignatureType`); CREATE2 L2 accounts skip
  signature derivation entirely. Including v was a latent bug we do not copy (§2).
- **Loopring** — message `Sign this message to access Loopring Exchange: <exchangeAddress> with
  key nonce: <N>` via `web3.eth.personal.sign`; pipeline `sha256(sig)` → little-endian →
  `mod` BabyJubjub subOrder (no grinding) ([sign_tools.ts, preserved copy](https://raw.githubusercontent.com/UptickNetwork/upticklite-on-loopring/main/upticklite-service/src/loopringSDK/api/sign/sign_tools.ts)).
  Contract wallets: a 5-way cascade including their own relayer's counterfactual-wallet check —
  i.e. they needed server infrastructure we don't have. The maintained SDK still patches
  signatures (`"02"` suffix, `1c↔01`) before deriving — cross-wallet re-encoding, in code.
  The Ledger/GameStop-wallet failure issue (`Loopring/website#220`) survives only as a search-index
  title — repo deleted, body **UNVERIFIED**.
- **dYdX v3** — framing correction: primarily **EIP-712** (domain `{name:'dYdX', version:'1.0',
  chainId}`), actions `'dYdX Onboarding'` / `'dYdX STARK Key'`, mainnet `onlySignOn:
  'https://trade.dydx.exchange'`; `personal_sign` existed only as a fallback signing a
  2-space-indented JSON of the same fields
  ([sign-off-chain-action.ts](https://raw.githubusercontent.com/dydxprotocol/v3-client/master/src/eth-signing/sign-off-chain-action.ts)).
  STARK key = `keccak256(sig ‖ typeByte) >> 5` ([starkex-lib keys.ts](https://raw.githubusercontent.com/dydxprotocol/starkex-lib/master/src/keys.ts));
  API creds from keccak of r and s separately. After v/type-byte mismatches they shipped
  `deriveAllStarkKeys` trying **four** rotations against the server-registered key
  ([PR #215](https://github.com/dydxprotocol/v3-client/pull/215)). dYdX v4 added the guard string
  `"Your wallet does not support deterministic signing. Please switch to a different wallet
  provider."` ([v4-localization app.json](https://github.com/dydxprotocol/v4-localization/blob/main/config/localization/en/app.json)).
- **StarkNet / EIP-2645** — [ERC-2645](https://eips.ethereum.org/EIPS/eip-2645) (Stagnant)
  defines the HD path `m/2645'/layer'/application'/…` and the grinding loop (`hash(root_key|i)`
  until below `N − (N mod n)`, then `mod n`). StarkWare's helper derives from **r only** with the
  doc note "not recommended when using any wallet that does not use a deterministic signing
  algorithm" ([key_derivation.ts](https://github.com/starkware-libs/starkware-crypto-utils/blob/master/src/js/key_derivation.ts),
  [docs.starkware.co](https://docs.starkware.co/starkex/crypto/key-derivation.html)). Argent X
  derives from its **own** seed, not an Ethereum signature; Braavos "Ethereum-derived" accounts:
  no first-party source found — **UNVERIFIED/likely nonexistent**.
- **Immutable X** — message `Only sign this request if you’ve initiated an action with Immutable
  X.` — note the **U+2019 curly apostrophe** (bytes `e2 80 99`), a re-encoding trap. Pipeline:
  `s` component → BIP-32 master seed → EIP-2645 path → grindKey
  ([starkCurve.ts](https://github.com/immutable/imx-core-sdk/blob/main/src/utils/stark/starkCurve.ts)).
  The SDK now carries **three** grindKey generations behind `DANGER: DO NOT MODIFY` banners
  because a loop-index refactor (`i = i++` no-op in the legacy SDK, then a start-at-0 change in
  v2.0.1) silently changed keys for ~1/32 of users; runtime resolves by querying IMX's server for
  the registered pubkey and trying all three. Hardware wallets that don't sign deterministically:
  recovery = forced L1 withdrawal, impossible if the stark key was never registered on-chain
  (support article delisted post-zkEVM — **UNVERIFIED** body).
- **Polymarket** — EIP-712 `ClobAuth` with literal `"This message attests that I control the
  given wallet"` and a **fresh timestamp** — deliberately non-derivational: the server mints the
  API creds; nothing is derived client-side
  ([py-clob-client eip712.py](https://github.com/Polymarket/py-clob-client/blob/main/py_clob_client/signing/eip712.py)).
  Not a sign-to-derive precedent, but evidence that volatile fields and derivation don't mix.

## 5. Incidents — what actually locked people out

1. **GridPlus Lattice1, pre-v0.12.0**: ECDSA nonces were random — every signature different →
   every zkSync/Loopring/dYdX-style derived key different per unlock. Fixed 2021-10-27: "Adds
   determinism to ECDSA signatures using RFC6979 and BIP62. This enables SNARK-based
   functionality on e.g. ZK-rollups"
   ([GridPlus release history](https://github.com/GridPlus/lattice-software-releases/blob/main/history/HSM.md)).
   This is the documented incident the double-sign check exists for.
2. **Immutable X grindKey regression** (core-sdk v2.0.1 / legacy `i = i++` bug): the same
   signature produced a different key after a "harmless" refactor; permanent three-grinder
   fallback + server-side pubkey matching now shipped in code (§4). Lesson: **freeze the
   derivation code path forever**, byte-for-byte.
3. **dYdX v/type-byte rotations** and **Loopring's suffix/v patching** (§2, §4): the scalars were
   stable; the **encoding** wasn't. Lesson: canonicalize to r‖s before hashing.
4. **Ledger `app-ethereum`**: no release changing personal_sign output bytes was found
   (changelog: 1.9.19/1.9.20 = EIP-191 display, 1.10.0 = EIP-712 hashing location;
   [CHANGELOG.md](https://github.com/LedgerHQ/app-ethereum/blob/develop/CHANGELOG.md)). The
   ticket's "Ledger 2023-ish personal_sign change" framing is **not supported by primary
   sources** — the defenses below don't depend on it either way.
5. **Recovery posture**: every burned project either had a server holding the registered pubkey
   (dYdX, IMX) or an L1 escape hatch. We have neither and need neither: **the derived 24-word
   mnemonic itself is the escape hatch** — it goes through the existing backup ceremony, so a
   later signature drift can never strand funds (§8).

## 6. Message format

Collision survey — every literal in the wild (§4): zkSync's `Access zkSync account.…`,
Loopring's `Sign this message to access Loopring Exchange:…`, dYdX's EIP-712/JSON, IMX's
`Only sign this request if you’ve initiated…`, Polymarket's EIP-712 `This message attests…`,
plus [EIP-4361 SIWE](https://eips.ethereum.org/EIPS/eip-4361) (`{domain} wants you to sign in…`).
None begins `Diginaut`; the proposal below collides with none. SIWE's format is **rejected** as a
base: it mandates a per-request nonce — volatile fields and derivation don't mix (Polymarket §4).

**Proposed message v1 — byte-frozen.** UTF-8, ASCII-only (IMX's U+2019 lesson), LF (`0x0a`)
newlines, **no trailing newline**. 321 bytes. SHA-256
`2666c5f978b46e18c683a5dd6480b596d9266c545cdb73acad12d97b1f42a029` — pin this in a test; any
change to the bytes is a different wallet for every user, so a change requires a version bump and
a migration story:

```
Diginaut sign-to-derive v1
Network: DigiByte testnet
Origin: https://dgb.ludere.space

This signature generates the private keys of your DigiByte wallet.
Anyone who obtains this signature can steal your DigiByte funds.
Only sign this message on https://dgb.ludere.space. If any other site asks for this signature, refuse.
```

- **Version field** (`v1`, line 1): bump = new message = new derived wallet, by design.
- **Network named** ("DigiByte testnet"): binds the ceremony to the deployment the wallet runs
  (`netchrome.js` decides chrome at runtime, but the *message* is frozen per deployment posture).
  The EVM chainId is deliberately absent — EIP-191 is chain-agnostic and the signature is
  identical on every EVM chain; naming an EVM chain would be false precision.
- **Origin line**: unenforceable — any site can present these exact bytes — but every prior-art
  system that survived phishing review carries one (dYdX `onlySignOn`), because the wallet
  renders the message and a user on `evil.example` can see the mismatch. Recognition, not
  enforcement; the plain-language warning does the honest work.
- **Same text on Phantom-Solana and EVM**: yes — one string to freeze, audit, and translate for
  display. Per-chain signature encoding already differs (Ed25519 64B vs ECDSA r‖s), so **a seed
  derived via Phantom is a different DigiByte wallet than one derived via MetaMask for the same
  human** — as are seeds from two different ETH accounts in one MetaMask. The UI must say this
  explicitly ("this wallet belongs to this signing account"), or users will expect one DGB
  wallet per person.

## 7. Signature → entropy

Pipeline (rationale after):

```
ECDSA (EVM):    sig(65B) → split r(32B)‖s(32B)‖v(1B) → drop v → canonicalize s to low-s
                → SHA-256(r‖s) = 32B entropy
Ed25519 (SOL):  sig(64B) → SHA-256(sig) = 32B entropy
Both:           entropy → entropyToMnemonic(entropy, english) = 24 words
                → existing mnemonicToSeed(mnemonic, '')  [BIP39 PBKDF2, hd.js:32-34]
                → existing deriveTaprootAddress, m/86'/1'/0'/0/i  [testnet coinType 1]
```

- **r‖s exactly, v excluded**: v encoding is the one field with documented cross-wallet variance
  (§2). zkSync hashed all 65 bytes including v — precisely the exposure dYdX's four-way rotation
  recovery exists to undo. Hypothesis confirmed by prior art's scar tissue.
- **Canonicalize s before hashing** (if s > n/2: s ← n−s, recid ^= 1;
  n = `0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`): a deterministic map
  that makes the entropy invariant under the only other known re-encoding. All verified wallets
  already emit low-s, so this is normally a no-op — it exists for the wallet version that
  doesn't. Reject rather than fix everything else (wrong length, bad recid): fail closed.
- **Hex decode case-insensitively, strip `0x` first, require exactly 65/64 bytes** — casing and
  prefix are presentation, not signature.
- **SHA-256 via `crypto.subtle.digest`**: already the platform primitive of record here
  (`keystore.js:11`). One hash invocation, no iteration: unlike zkSync/EIP-2645/IMX we need **no
  grinding or modular reduction** — BIP39 entropy is uniform bytes, not a field element. The
  entire class of grindKey incidents (§5.2) is structurally impossible for us. No
  domain-separation tag needed either: the message is already app-unique, so no other protocol
  hashes these signature bytes; SHA-256(sig) collides with nothing.
- **32 bytes → 24 words, not 16 → 12**: the hash outputs 32 uniform bytes; truncating to 16 adds
  a step that can be gotten wrong and halves headroom for no benefit. Side effect worth keeping:
  native Diginaut wallets are 12-word (`hd.js:22-24`), derived wallets 24-word — visibly
  distinct classes in the backup UI.
- Treat signature bytes as key material: never logged, never stored, buffers overwritten after
  derivation (best-effort in JS); only the AES-GCM-encrypted mnemonic persists (existing vault).

## 8. Safety ceremony

- **First derive — DOUBLE-SIGN.** Two `personal_sign` requests for the same bytes in one
  session (UI copy before prompt one: "you'll sign twice; the second signature proves your
  wallet signs deterministically"). Require byte-identical canonicalized r‖s (Ed25519: identical
  64 bytes). On mismatch: **refuse the wallet brand by name**, dYdX-v4-style ("<Brand> does not
  sign deterministically (this is typical of MPC wallets). It cannot derive a recoverable
  wallet."). No funds UI, no vault write, nothing derived is retained.
- **Stored source fingerprint.** On success, store in the **encrypted** secrets blob (not
  cleartext `meta` — the link "this DGB wallet belongs to ETH address X" is exactly what a
  locked-vault reader shouldn't get; `meta` is cleartext by design,
  `docs/specs/wallet-management-v2.md:24-26`):
  `sources[walletId] = { kind: 'evm'|'sol', rdns, brand, address, msgVersion: 1, fp }`
  where `fp` = first **4 bytes**, hex, of SHA-256(`"diginaut-s2d-fp:"` ‖ entropy). Cleartext
  `meta.wallets[i]` gets only `derived: true` for the switcher badge. 32 bits justification:
  false-match odds 2⁻³² (a drifted signature silently passing is negligible), while revealing 32
  bits of a 256-bit secret leaves 2²²⁴ — useless to a brute-forcer; it also can't help guess the
  signature (itself ≥256-bit unknowable). 8 bytes would also be fine; 4 is enough (§10 Q6).
- **Reconnect verification.** When the source wallet reconnects (routine reconnect, or restore
  on a new device): match `(kind, address)` against stored sources, request ONE signature,
  re-derive, compare `fp`. Match → verified badge. **Mismatch → hard stop**: "This signer no
  longer produces the signature that created '<name>'. Your funds are safe at the original
  addresses, but this wallet extension can no longer re-derive them. Restore from the 24-word
  phrase." Never silently derive-and-show — that is how prior-art users watched an empty
  stranger's account render under their name (§5; same one-wallet's-data-on-another failure
  class as #122). Deriving the mismatched seed as a NEW wallet stays possible behind an explicit
  "create different wallet" confirmation.
- **What double-sign does NOT catch** — anything that changes *between* sessions: firmware
  updates (GridPlus's v0.12.0 boundary), device/OS reinstalls, the same address imported into a
  different brand (same key + RFC 6979 *should* reproduce identical r‖s cross-brand, but
  cross-stack equality is UNVERIFIED — Trezor's RFC 6979 HMAC hash wasn't pinned), an MPC
  provider's server-side change. The **fingerprint** catches all of these at reconnect, before
  any funds UI can render at a wrongly-derived address. The residual gap — drift while the user
  also lost the 24 words — is why the derived wallet enters the **existing backup ceremony**
  (`backedUp: false` → reveal + quiz + persistent badge) immediately: the mnemonic is the only
  escape hatch prior art didn't have (§5.5). Sign-to-derive is a convenience door, never the
  only door.

## Protocol decision

Implementable byte-for-byte; everything referenced is already vendored.

1. **Discovery**: vanilla EIP-6963 (`eip6963:requestProvider` / `eip6963:announceProvider`).
   No `window.ethereum` fallback (fingerprint requires `rdns`). If `rdns == 'app.phantom'`,
   use the Solana path via `window.phantom.solana` (owner may allow Phantom-EVM later, §10 Q3).
2. **Message** `M` = the 321 frozen bytes of §6 (SHA-256 `2666c5f9…`, pinned in a test).
   Same bytes on both chains.
3. **EVM path**: `eth_requestAccounts` → `addr` (compare case-insensitively throughout).
   `personal_sign` with params `['0x'+lowercaseHex(M), addr]`.
   Parse the result: string, strip `0x`, hex-decode case-insensitively, require **exactly 65
   bytes** else refuse ("not a plain key wallet"). Split r,s,v; `recid = v>=27 ? v-27 : v`;
   require `recid ∈ {0,1}` else refuse. If `s > n/2`: `s = n−s`, `recid ^= 1`.
4. **ecrecover**: `digest = keccak_256(0x19 ‖ "Ethereum Signed Message:\n321" ‖ M)` (`321` =
   decimal ASCII byte-length of M; recompute from `M.length`, don't hardcode).
   `pub = secp256k1.Signature(r,s).addRecoveryBit(recid).recoverPublicKey(digest)`
   (`@noble/curves`); `ethAddr = keccak_256(uncompressedPub[1..65])[12..32]`. Require
   `ethAddr == addr` else refuse ("connected account is a smart account / not the signer").
5. **Solana path**: `window.phantom.solana.connect()` → pubkey (base58, decode via
   `@scure/base`); `signMessage(M-bytes, 'utf8')` → 64-byte sig; require
   `ed25519.verify(sig, M, pub, {zip215:false})` else refuse.
6. **Double-sign**: repeat the signature request once, same session; require byte-identical
   canonicalized r‖s (EVM) / sig (Solana). Mismatch → refuse the brand by name, derive nothing.
7. **Entropy**: `crypto.subtle.digest('SHA-256', r‖s)` (EVM, 64 bytes in) or
   `('SHA-256', sig)` (Solana, 64 bytes in) → 32 bytes.
8. **Mnemonic**: `entropyToMnemonic(entropy, english)` (`@scure/bip39`) → 24 words → existing
   `addWallet({name, mnemonic, backedUp: false})`; BIP39 passphrase empty; existing
   `m/86'/1'/…` testnet derivation. The vault's duplicate-mnemonic guard handles re-derives.
9. **Fingerprint**: store `{kind, rdns, brand, address, msgVersion: 1, fp}` in encrypted
   secrets; `fp` = hex of first 4 bytes of SHA-256(`"diginaut-s2d-fp:"` ‖ entropy);
   `derived: true` in cleartext meta. On every reconnect of a known source: one signature,
   re-derive, compare fp; mismatch → hard stop of §8, never a silent swap.
10. **Freeze forever**: message bytes, the r‖s canonicalization, the hash, and the
    entropy→mnemonic step get pinned test vectors (a fixed test key must yield a fixed
    mnemonic); any diff in that file is treated as consensus-grade (IMX §5.2).

### Open questions for the custody grilling (owner decisions, not research facts)

1. ~~**Mainnet message**~~ — **RESOLVED** by ADR 0005 and shipped 2026-07-27: a v2
   `Network: DigiByte mainnet` message, different seed per network, two wallets per user.
   Reuse was rejected because the derivation signature is phishable by construction, so
   reusing v1 would make every testnet-era signature a mainnet private key — and would ask a
   user on diginaut.ludere.space to sign bytes whose own last line says to refuse exactly that.
2. **Mobile wallets**: stay extension-only, or accept WalletConnect's relay + dependency tree
   later for QR-based mobile signing? (Rejected for v1 in §1.)
3. **Phantom policy**: hard-route Phantom to Solana signing (one Phantom = one wallet), or also
   allow its EVM provider (one Phantom = two different derivable wallets — confusing)?
4. **Closed-source EVM wallets (OKX et al.)**: admit anything that passes ecrecover +
   double-sign (current spec), or maintain an rdns allowlist of verified-deterministic brands
   and refuse the rest?
5. **Sign-in-with-wallet as unlock**: should re-deriving via signature ever substitute for the
   vault master password on a new device? (Custody shift: the extension becomes the key. Spec
   above keeps the vault password mandatory.)
6. **Fingerprint width**: 4 bytes (spec) vs 8 — larger is collision-safer, reveals more bits;
   both are cryptographically comfortable.
7. **Badge privacy**: is cleartext `derived: true` in locked-vault meta acceptable, or must even
   that live encrypted (cost: no derived badge on the locked wallet list)?
8. **Backup pressure**: derived wallets enter the skippable backup flow (`backedUp: false`).
   Given §8's residual gap (signature drift + lost words = gone), should sign-to-derive wallets
   get a *mandatory* backup quiz instead — contradicting the already-decided skippable policy?
