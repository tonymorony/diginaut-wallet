# Project status

Verified: 2026-07-26 (later), branch `audit/2026-07-26-external-audit`, main @ `afcee01`
(#134 connect-wallet + #135 llm-wiki merged).
This page rots fastest — reconcile with `git log` + the tracker before acting on it.

## Shipped

- **Testnet wallet SHIPPED 2026-07-05** (all 31 PRD stories) → <https://dgb.ludere.space>.
- **Mainnet launch (map #50) LIVE 2026-07-17** → <https://diginaut.ludere.space>.
  DigiDollar **activated on mainnet 2026-07-17 at block 23,869,441**.
- Android-parity map #67 — closed 2026-07-17 (legacy sends, rich history, fiat entry, BIP21,
  DD address interop, receive strategy).
- Wallet-management v2 (map #92) — vault, multi-wallet, backup UX; spec in
  `docs/specs/wallet-management-v2.md`.
- Server migration (old box OOM-killed electrumx-main) — closed 2026-07-23. Runbook
  `docs/runbooks/server-migration-2026-07.md` exists locally but is **untracked** (user
  decision pending) — don't treat it as reachable from a fresh clone.

## Active: external-audit changeset (branch `audit/2026-07-26-external-audit`)

- An external security audit (AUDIT.md, delivered outside the repo) described fixes that
  were never landed here. Every claim was re-verified against this tree: all 11 FIXED
  findings were genuinely missing and are now implemented (C1 broadcast ambiguity + recovery
  card, C2 storage persistence + tombstone, C3 mainnet backup-skip gate, H1 fetch timeouts,
  H2 indexer validation, H3 reject translations, H4 rate/body limits, H5 stale-tip warning,
  M1 backup file at ceremony, M2 roundtrip test, M3 HSTS) plus the Windows-path driver fix.
- 4 of the audit's 10 "already OK" claims were FALSE for this tree and are also fixed:
  L7 CRLF-unsafe CSP hash (total boot failure on CRLF checkouts), L3 drafts holding private
  keys surviving modal close, L10 fail-open `?autolockSecs=`, L5 two unhardened sinks.
- Deliberate deferrals: L10 FIX B (mock-mode proxy refusal — would break the NEEDS_STACK
  driver harness), L3 STEP 3 (mint quote-age gate), WASM keystore for L3 memory hardening.
- PR pending user merge. Deploy notes: TLS/dual overlays now set TRUST_PROXY=1 + HSTS=1;
  the faucet cooldown becomes per-user (was accidentally per-deployment behind Caddy).

## Recently shipped: map #126 — "Connect a web3 wallet" (sign-to-derive), TESTNET only

- #127 research → `docs/discovery/sign-to-derive.md` (merged). #129 custody grilling →
  ADR-0005 + glossary terms (merged, PR #133). #128 prototype → owner picked **variant A
  "third door"** (prototype preserved on `prototype/connect-flow-128`, **never merge it**).
- **#130 build merged 2026-07-26** (PR #134, squash `afcee01`; deployed to testnet, #136
  awaits the owner's live MetaMask smoke): sign-to-derive core +
  variant-A UI + pinned protocol vectors + CDP driver. Scope: injected connectors only
  (EIP-6963 + Phantom-Solana **only**, no Phantom-EVM), derived seed = first-class vault
  wallet with origin metadata. Out of scope: mainnet, Snap, WalletConnect, signing DGB txs
  with the connected wallet.
- Key protocol decisions (details: discovery doc + ADR-0005): frozen 321-byte v1 message,
  per-network; entropy = SHA-256(canonical r‖s, **v excluded**) → 24-word BIP39 → BIP86;
  double-sign determinism check is load-bearing; 4-byte reconnect fingerprint, hard-stop on
  mismatch; one unchecked checkbox gates the first signature; skippable backup, born
  `backedUp:false`.

## Loose ends

- Launch map #50: only **#59 real-funds verification** remains (needs user's DGB + non-zero
  oracle price; oracle showed price 0 at activation).
- PR #132 (driver assertion fixes) — merged 2026-07-26 (`4125fe4`).
- `verify-wallet-switch` is **flaky in CI** — fix before making CI a required check.
- Prod drift: as of 2026-07-26 testnet ran `7e76a4a` while mainnet was deliberately left one
  build behind (`da3fde2`) — testnet-first at user request. Check `/api/config` `version`.
- Untracked clutter in repo root: driver screenshots + brand PNGs (pending user decision).
  `deploy/digidollar-status-*` and `deploy/oracle-price-feeder.mjs` belong to a **different
  project** (api.digiscope.me) and are gitignored — leave them alone.
