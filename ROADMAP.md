# Roadmap

Derived from ADR-0001..0004. User-facing releases are M1 and M3; M0 and M2 are internal.

## M0 — Restructure (internal)

- Monorepo layout: `packages/digidollar-js` (pure protocol lib, ADR-0004), `apps/wallet`,
  `apps/faucet`; indexer layer per ADR-0003.
- Remove the custodial-by-accident address generation (`getnewdigidollaraddress` via shared
  node) — replace with client-side BIP39/BIP86 derivation. Drop it from the RPC allow-list.
- Rewrite README around the non-custodial wallet architecture.

## M1 — Nodeless onboarding (first user-facing release)

- Create/restore wallet in the browser (BIP39 mnemonic, encrypted IndexedDB, optional backup —
  testnet-only banner; see TODO.md for the mainnet bar).
- Client-side address derivation; DGB send/receive via the indexer.
- Faucet: dispenses a mint-meaningful amount (sized to ~mint 25–50 DigiDollar at the
  6-month/200% tier), rate-limited per address + per IP, 24h cooldown, manually topped-up
  testnet hot wallet.
- Status dashboard (softfork, oracle feed) + mint calculator (already built).

Nothing consensus-novel here: standard DGB transactions only.

## M2 — Differential harness (internal gate, runs in parallel with M1 feedback)

- **First task — discovery:** can regtest run the DigiDollar oracle system locally
  (`startoracle`)? Mint needs an oracle price; redeem needs 8-of-15 oracle signatures. Answer
  lives in the DigiByte Core source. If regtest can't host oracles, M2 gets significantly harder —
  find out before building anything on top.
- Extract the exact DigiDollar output script / oracle-binding structure from Core source; confirm
  which read RPCs ("node as script oracle") can emit it.
- Harness: JS-built mint, transfer, and redeem transactions byte-identical to Core-built
  equivalents on regtest. Lives in `packages/digidollar-js` as its test suite.

## M3 — Stablecoin release (user-facing)

- Mint + redeem + transfer, released together (ADR-0002) — none exposed until all three pass M2.
- Single experimental feature behind the harness gate.

## Later / parallel

- Upstream a PSBT-mint RPC to DigiByte Core (long-term unblock, ADR-0001).
- Separate repo + npm announcement for `digidollar-js` once the API stabilizes and an external
  consumer exists (ADR-0004).
- Everything in TODO.md "Before mainnet".
