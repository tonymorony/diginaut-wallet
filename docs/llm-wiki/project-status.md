# Project status

Verified: 2026-07-31, branch `feat/diginaut-space-domain`, main @ `7bfe600`
(#141 mobile badge, #142 mainnet web3 door, #143 web3-mainnet driver, #110 Caddy access logs
merged since the last stamp). This page rots fastest — reconcile with `git log` + the tracker
before acting on it.

## Shipped

- **Testnet wallet SHIPPED 2026-07-05** (all 31 PRD stories) → canonical
  <https://testnet.diginaut.space>, legacy <https://dgb.ludere.space> (still served).
- **Mainnet launch (map #50) LIVE 2026-07-17** → canonical <https://diginaut.space>, legacy
  <https://diginaut.ludere.space> (still served).
  DigiDollar **activated on mainnet 2026-07-17 at block 23,869,441**.
- Android-parity map #67 — closed 2026-07-17 (legacy sends, rich history, fiat entry, BIP21,
  DD address interop, receive strategy).
- Wallet-management v2 (map #92) — vault, multi-wallet, backup UX; spec in
  `docs/specs/wallet-management-v2.md`.
- Server migration (old box OOM-killed electrumx-main) — closed 2026-07-23. Runbook
  `docs/runbooks/server-migration-2026-07.md` exists locally but is **untracked** (user
  decision pending) — don't treat it as reachable from a fresh clone.

## In flight: domain switch to diginaut.space (branch `feat/diginaut-space-domain`)

- **Code merged ≠ cutover done.** The PR mints frozen s2d **v3** (testnet, 333 B, SHA-256
  `be8ffbacb1…`) and **v4** (mainnet, 317 B, `51b9fe9bce…`) for the new origins, selected by
  serving hostname; v1/v2 stay byte-frozen for the two `ludere.space` hosts, which keep serving
  and are **never redirected**. ADR-0006. DNS + `.env` + deploy steps:
  `docs/runbooks/domain-cutover-2026-07.md` — until that runs, the new names don't resolve.
- Also fixes a live mainnet defect: the ceremony checkbox hardcoded `dgb.ludere.space`, so the
  mainnet ceremony named the testnet domain. It now renders from the selected message's own
  `Origin:` line (`s2dOriginHost`).
- New localStorage key `diginaut.movedNotice` (the legacy-host "we've moved" strip). Baseline
  after this branch: **206 wallet tests**; driver set still 14 (12 `SELF_CONTAINED` + 2
  `NEEDS_STACK` in `run-drivers.sh`).

## Active: copy pass (branch `design/copy-truthful-labels`)

- Follows the #138 community report. Fixes where a label named a different security model than
  the handler implements: the guest/header CTA (three states — the **locked** case was the
  worst, offering "Connect wallet" over a wallet already on the device), the recovery card's
  destructive *Dismiss*, and the mainnet banner's unqualified "no backup". "Connect" now
  survives only on the web3 door, where it is true. Conventions: `design-system.md` § UX copy.
- Baseline at branch point: **192 wallet tests, 13/13 drivers** — unchanged by this branch.
- Deferred to a follow-up (audited but not fixed): the **post-eviction sheet** — hero says
  *Restore a wallet* while the sheet titles *Create or restore a wallet*, focuses
  `w-create-choice` and paints create as the sole `.door.primary` (fix the three together);
  the locked hero still shows the first-contact marketing pitch under an *Unlock* button
  ("autolock is silent"); the trust line hides with `#w-choice` when restore opens (partly
  covered — `#w-connect-sub` carries the claim while `vault.status === 'none'`, so the real
  gap is only the add-a-wallet path); `rederiveHint` promises re-derivation "any time" without
  `CONTEXT.md`'s convenience-door hedge; ~14 tone/glossary items (e.g. "Burning" on redeem
  confirm). Also open, unrelated to copy: the mainnet ack interstitial has **no coverage in
  the local driver gate** (`verify-mainnet-live` is deploy-only) — see `wallet-app.md`.

## Shipped since: external-audit changeset (#137, merged `5d79c61`)

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
- Merged 2026-07-27. Deploy notes: TLS/dual overlays now set TRUST_PROXY=1 + HSTS=1;
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
- `verify-wallet-switch` CI flake **fixed 2026-07-27** (see `agent-workflow.md` § CI); the
  registered driver set is now 13 (both mainnet-shaped drivers wired in by #138).
- Prod drift: as of 2026-07-26 testnet ran `7e76a4a` while mainnet was deliberately left one
  build behind (`da3fde2`) — testnet-first at user request. Check `/api/config` `version`.
- Untracked clutter in repo root: driver screenshots + brand PNGs (pending user decision).
  `deploy/digidollar-status-*` and `deploy/oracle-price-feeder.mjs` belong to a **different
  project** (api.digiscope.me) and are gitignored — leave them alone.
