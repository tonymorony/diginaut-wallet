# PRD: Non-custodial DigiDollar browser wallet (testnet)

> Archived verbatim from tracker issue #1 on 2026-07-05, the day the project shipped.
> All 31 user stories delivered; reference deployment: <https://dgb.ludere.space>.
> Implementation history: issues #2-#17 (vertical slices), plus #32/#38/#44 found in the field.

## Problem Statement

DigiDollar — DigiByte's decentralized, USD-pegged stablecoin — is live on testnet and awaiting mainnet activation, but there is no easy way for a newcomer to try it. Today the only path is: install and sync a full DigiByte Core node, fund its built-in wallet, and drive minting through RPC or the Qt GUI. For a curious community member that is hours of setup before the first experiment. There is also no way to mint without trusting a node that holds your keys: the Core minting RPC signs internally with the node's own wallet, so any "hosted" shortcut would mean surrendering custody.

As a result, the community around DigiDollar cannot grow through hands-on play: no browser wallet exists, no faucet dispenses enough testnet DGB to actually mint, and no tooling shows oracle or softfork status in a human-readable way.

## Solution

A public, open-source, **non-custodial browser Wallet** for DigiDollar on testnet. A new user opens a web page, creates a Wallet whose keys never leave the browser, receives enough testnet DGB from a project **Faucet** to actually play, and can watch network, softfork, and **Oracle** status on a dashboard. Once the differential-test gate passes, the user can **Mint** DigiDollar by locking DGB **Collateral** at a chosen **Lock tier**, **Transfer** DigiDollar to other users, and **Redeem** it back into Collateral — all three signed client-side in JavaScript and broadcast through a project-operated shared node that never sees a private key.

The consensus-critical layer ships as a standalone pure-protocol library — effectively the first DigiDollar SDK — with the wallet as its first consumer.

## User Stories

1. As a new user, I want to create a Wallet in my browser with one click, so that I can start playing with DigiDollar without installing anything.
2. As a new user, I want my keys generated and stored only in my browser, so that the project never has custody of my funds.
3. As a new user, I want my Wallet encrypted at rest behind a password, so that someone with access to my machine cannot spend my funds.
4. As a returning user, I want my Wallet to persist between visits, so that I don't have to re-import my seed phrase every time.
5. As a user, I want the option to view and back up my seed phrase, so that I can restore my Wallet on another device.
6. As a user, I want to restore a Wallet from a seed phrase, so that I can recover access after clearing browser storage.
7. As a user, I want a permanent, unmissable "TESTNET ONLY" banner, so that I never mistake this for a mainnet wallet holding real value.
8. As a new user, I want to request testnet DGB from the Faucet directly in the wallet, so that I have Collateral to experiment with.
9. As a new user, I want the Faucet to give me enough DGB to actually Mint a meaningful amount of DigiDollar, so that my first experiment isn't blocked by the collateral floor.
10. As a Faucet operator, I want per-address and per-IP rate limits with a cooldown, so that bots cannot drain the Faucet.
11. As a Faucet operator, I want visibility into the Faucet hot wallet's remaining balance, so that I know when to top it up.
12. As a user, I want to see my DGB balance and transaction history, so that I know the Faucet payout arrived and what I've spent.
13. As a user, I want to generate receive addresses derived in my browser, so that receiving funds never depends on a server-side wallet.
14. As a user, I want to send DGB to any address, so that I can move funds between my own wallets or to friends.
15. As a user, I want to see pending (mempool) transactions, so that I'm not confused about whether my transaction went through.
16. As a user, I want a dashboard showing whether the DigiDollar softfork is active on the current chain, so that I know if minting is possible at all.
17. As a user, I want to see the live Oracle DGB/USD price and Oracle network health, so that I understand the price my Mint would use.
18. As a user, I want a Mint calculator that shows required Collateral per Lock tier before I commit, so that I can choose a tier deliberately.
19. As a user, I want to Mint DigiDollar by choosing an amount and Lock tier, with the transaction signed in my browser, so that I get DigiDollar without trusting anyone with my keys.
20. As a user, I want a clear confirmation screen before Mint showing amount, Lock tier, Collateral to be locked, and lock expiry date, so that I can't lock funds by accident.
21. As a user, I want to see my open DigiDollar positions — minted amount, locked Collateral, tier, expiry — so that I always know where my funds are.
22. As a user, I want to Transfer DigiDollar to another user's address, so that I can actually use it as money.
23. As a user, I want to Redeem DigiDollar back into my locked Collateral, so that minting is never a one-way trap.
24. As a user, I want Mint, Transfer, and Redeem to appear together as one feature, so that I'm never able to lock funds I can't get back or send.
25. As a user, I want clear error messages when a Mint/Redeem/Transfer is rejected (e.g., Oracle price stale, softfork inactive), so that I know what to do next.
26. As a community member, I want the whole project open-source, so that I can audit it, run my own instance, or contribute.
27. As a self-hoster, I want to run the wallet stack against my own node and indexer via configuration, so that I don't depend on the project's infrastructure.
28. As a wallet/exchange developer, I want the DigiDollar protocol layer published as a standalone JS library with no I/O dependencies, so that I can integrate DigiDollar without reverse-engineering consensus rules.
29. As a library consumer, I want the library's test suite to prove byte-identity against Core-built transactions, so that I can trust it with value.
30. As a project maintainer, I want the shared node's RPC surface restricted to an explicit read/broadcast allow-list, so that the server can never be tricked into fund-moving operations.
31. As a privacy-conscious user, I want my extended public keys to never leave my browser, so that the server cannot reconstruct my full wallet history.

## Implementation Decisions

All decisions below are recorded as ADRs in `docs/adr/` and take precedence in conflicts.

- **Non-custodial, nodeless, client-side signing (ADR-0001).** Keys are generated and held in the browser (BIP39 mnemonic, BIP86/Taproot derivation, encrypted in IndexedDB behind a password). Mint transactions are constructed and Schnorr-signed client-side in JS, then broadcast via a project-operated shared read/broadcast node. Custodial minting and connect-your-own-node were considered and rejected.
- **Node as script oracle.** The JS layer must not hardcode consensus structure. Everything fetchable from node read-RPCs (DigiDollar output script structure, internal key, merkle root, script paths, oracle attestation) is fetched; JS fills in inputs, computes sighashes, signs, serializes.
- **Differential harness is a hard gate (ADR-0001).** The first build task for the stablecoin feature is a regtest harness proving JS-built transactions are byte-identical to Core-built equivalents. No Mint/Redeem/Transfer UI ships before its transaction shape passes.
- **Mint, Redeem, and Transfer ship together (ADR-0002).** Never mint-alone: a wallet that can Mint but not Redeem is a one-way trap, and a stablecoin you can't send isn't money. Internal build order is free; the constraint is user-facing.
- **Indexer from day one (ADR-0003).** Balances, history, and UTXOs are served by an address indexer; user xpubs are never uploaded to the shared node. The indexer must be DigiDollar-aware (existing Electrum-style indexers won't parse `OP_DIGIDOLLAR` outputs) — extend an existing indexer or build a thin indexing layer over the shared node; decided at build time after inspecting the DigiByte Electrum server landscape.
- **Pure-protocol library in a monorepo (ADR-0004).** `packages/digidollar-js` contains only deterministic functions (derivation, output parsing/construction, tapscript, sighash, Schnorr, Lock-tier math) — zero I/O. Apps (`apps/wallet`, `apps/faucet`) hold all networking. Published to npm independently; separate repo deferred until the API stabilizes.
- **Faucet.** Project-operated testnet hot wallet (explicitly distinct from the non-custodial user Wallet claim). Dispenses a mint-meaningful amount (sized to Mint ~25–50 DigiDollar at the 6-month/200% tier), rate-limited per address + per IP with a 24h cooldown. Bot protection is rate-limiting only — no CAPTCHA. Manual top-up initially.
- **Key-safety posture (v0.1).** Optional (not forced) seed backup, justified solely by testnet-only scope. Forced backup, hardened encryption, and a security review are required before any mainnet pointing (tracked in TODO.md).
- **Shared-node RPC proxy.** Browser-reachable RPC methods are an explicit allow-list of read/broadcast calls; the accidental-custodial `getnewdigidollaraddress` flow from the prototype is removed in favor of client-side derivation.
- **Milestones (ROADMAP.md).** M0 restructure → M1 nodeless onboarding (first user release: wallet, faucet, DGB send/receive, dashboard, calculator) → M2 differential harness (internal gate) → M3 stablecoin release (Mint+Redeem+Transfer together).

## Testing Decisions

Good tests here observe external behavior at a seam: given inputs, assert emitted bytes or HTTP responses — never internal call sequences or private state.

- **`packages/digidollar-js` — primary seam.** Two layers: (1) the differential harness — JS-built Mint/Transfer/Redeem transactions compared byte-for-byte against Core-built equivalents on regtest; this doubles as the library's trust certificate; (2) unit vectors — BIP39/BIP86 derivation against official test vectors, Lock-tier math, DigiDollar output parsing against fixtures.
- **Faucet — HTTP seam.** Request → dispenses the configured amount; repeat request within cooldown → rejected; per-address and per-IP limits enforced. Backed by regtest or a mocked node.
- **Indexer — query-API seam.** Seed regtest with known transactions; assert an address returns correct UTXOs, history, and DigiDollar positions (including `OP_DIGIDOLLAR` outputs).
- **Wallet app — thin.** The existing allow-list RPC proxy is tested over HTTP (as smoke-tested in the prototype). UI logic is pushed down into the library; browser e2e kept minimal.
- **Prior art:** none — greenfield. Test runner: `node:test`, keeping the zero-dependency spirit.

## Out of Scope

- **Mainnet.** Everything here is testnet-only; the mainnet bar (forced backup, security review, indexer hardening) is tracked separately.
- **Custodial anything.** No server-side keys for users, ever. (The Faucet hot wallet is project-owned testnet coins, not user funds.)
- **Connect-your-own-node minting.** Explicitly rejected (ADR-0001).
- **CAPTCHA-based bot protection.** Rate-limiting only.
- **Upstreaming a PSBT-mint RPC to DigiByte Core.** Valuable parallel track, not part of this PRD.
- **DigiAssets, Digi-ID, and other DigiByte features.** This wallet is DGB + DigiDollar only.
- **Fiat on-ramps, price advice, or anything mainnet-financial.**
- **Hardware wallet support.**

## Further Notes

- **Biggest open risk (first M2 task):** whether regtest can host the DigiDollar Oracle system locally (`startoracle`). Mint needs an Oracle price; Redeem needs 8-of-15 Oracle signatures. If regtest can't run oracles, the harness design changes materially — answer this from Core source before building on top.
- **Second discovery task:** extract the exact DigiDollar output-script and oracle-binding structure from the DigiByte Core C++ source, not from discussion summaries; confirm which read-RPCs can emit it.
- Redemption and Transfer are tapscript-path spends and are harder than Mint; the harness must cover all three transaction shapes.
- Domain vocabulary lives in `CONTEXT.md`; decisions in `docs/adr/`; sequencing in `ROADMAP.md`; conscious deferrals in `TODO.md`.
- The pre-pivot prototype (read-only testnet UI) is in the repo and is reworked, not discarded, in M0: the dashboard, calculator, and allow-list proxy carry forward.

