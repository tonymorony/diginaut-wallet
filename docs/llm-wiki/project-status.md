# Project status

Verified: 2026-07-27, branch `design/copy-truthful-labels`, main @ `67004d8`
(#134 connect-wallet, #135 llm-wiki, #137 external audit, #138 icons + connect modal merged).
Lock & Earn map section verified 2026-07-30, branch `discovery/dd-defi-yield`, main @ `4e2733b`.
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

## Active: DD Lock & Earn pilot — wayfinder map #144

- **Map:** <https://github.com/tonymorony/diginaut-wallet/issues/144> — self-custodial DD lock
  + trustless floor, M0 on **testnet only**. One ticket per session via `/wayfinder`; frontier
  = the map's open, unblocked, unclaimed child issues (native sub-issues + blocked-by wired).
- **Owner decision 2026-07-30: the whole effort accumulates on feature branch
  `prototype/lock-earn`** — per-ticket work branches off it and PRs back into it; one
  reviewed feature→main merge when the pilot is ready. `main`'s docs and wiki stay quiet
  about Lock & Earn until then (deliberate — that includes the freeze-tier correction).
- Basis docs (landed by ticket #145 via PR #159): spec `docs/specs/dd-lock-and-earn-pilot.md`
  (v0.1.0), research `docs/discovery/dd-defi-yield.md`, state-model prototype in
  `prototypes/lock-earn/` on this branch (reference-only code; it validated the mechanism).
- Standing rules live in the map body's Notes (execution in scope, branching, the
  one-template-library invariant, label = mechanism, baselines).

## Copy pass (shipped as #139; the deferrals below are still open)

- Follows the #138 community report. Fixes where a label named a different security model than
  the handler implements: the guest/header CTA (three states — the **locked** case was the
  worst, offering "Connect wallet" over a wallet already on the device), the recovery card's
  destructive *Dismiss*, and the mainnet banner's unqualified "no backup". "Connect" now
  survives only on the web3 door, where it is true. Conventions: `design-system.md` § UX copy.
- Baseline at branch point: **192 wallet tests, 13/13 drivers** — unchanged by #139.
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

- `dderrors.js`'s `all-operations-frozen` copy names only the 50%/7d tier; the ≥30%/24h
  tier (consensus-facts.md § Volatility freezes & fees) also raises it, and
  `dderrors.test.js` pins the literal "50%" → #160.
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
