# DigiDollar Wallet

A **non-custodial, browser-based wallet** for [DigiByte](https://digibyte.org)'s **DigiDollar**
stablecoin — built so a newcomer can create a wallet, get testnet DGB from a faucet, and mint
DigiDollar **without running their own node**, and without anyone else ever holding their keys.

> **TESTNET ONLY.** DigiDollar awaits mainnet activation; this project targets testnet while the
> stablecoin feature matures. Do not use with real funds.

## How it works

- **Keys live in your browser** (BIP39/BIP86), never on a server (ADR-0001).
- Consensus-critical transactions (mint / transfer / redeem) are **built and signed client-side**
  by the pure-protocol library, then broadcast through a shared read/broadcast node that never
  sees a private key.
- Before any fund-moving code ships, it must pass a **differential harness**: JS-built
  transactions byte-identical to DigiByte Core-built ones on regtest (ADR-0001, ADR-0002).

## Monorepo layout

| Path | What it is |
|---|---|
| `packages/digidollar-js` | Pure-protocol DigiDollar library — deterministic functions, zero I/O (ADR-0004). Mirrors DigiByte Core v9.26.4 arithmetic exactly. |
| `apps/wallet` | Wallet web app — dashboard, mint calculator, RPC allow-list proxy. First consumer of the library. |
| `docs/adr/` | Architecture decisions. `CONTEXT.md` is the domain glossary, `ROADMAP.md` the milestone plan. |

## Run

```bash
npm install   # links workspaces (only audited @noble/@scure crypto deps)
npm start     # → http://localhost:8787
npm test      # node:test across all workspaces
```

**Mock mode (default):** without RPC credentials the app serves realistic fake data shaped like
real RPC responses — usable before you have a node.

**Real node:** copy `apps/wallet/.env.example` → `.env`, set `DGB_RPC_USER` / `DGB_RPC_PASS` /
`DGB_RPC_URL` (the `rpcport` from your `digibyte.conf`), load it and `npm start`.

## Consensus lock tiers (DigiByte Core v9.26.4)

Collateral required to mint, by lock period — from `src/consensus/digidollar.h`:

| Lock period | Collateral | | Lock period | Collateral |
|---|---|---|---|---|
| 1 hour | 1000% | | 2 years | 275% |
| 30 days | 500% | | 3 years | 250% |
| 3 months | 400% | | 5 years | 225% |
| 6 months | 350% | | 7 years | 212% |
| 1 year | 300% | | 10 years | 200% |

Plus a 1% safety margin, and a Dynamic Collateral Adjustment (DCA) surcharge when system-wide
collateralization degrades. `digidollar-js` reproduces this arithmetic exactly (integer/BigInt,
ceiling division — see its tests).

## Safety posture

- The RPC proxy exposes an explicit **allow-list of read methods only**; fund-moving RPCs are not
  reachable from the browser.
- Mint is **never shipped without redeem and transfer** (ADR-0002) — no one-way traps.
- Known deferrals and their triggers live in `TODO.md`.

## Status

Issue tracker: [PRD (#1)](../../issues/1), work sliced into #2–#17. Currently at **M0**
(restructure) of the [roadmap](ROADMAP.md): M0 → M1 nodeless onboarding → M2 differential
harness → M3 stablecoin release.
