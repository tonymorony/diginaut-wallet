<p align="center">
  <img src="docs/diginaut-mascot.png" alt="Diginaut" width="180" />
</p>

<h1 align="center">Diginaut Wallet</h1>

A **non-custodial, browser-based wallet** for [DigiByte](https://digibyte.org)'s **DigiDollar**
stablecoin. Diginaut lets a newcomer create a wallet, send and receive DGB, and mint, transfer,
and redeem DigiDollar — **without running their own node, and without anyone else ever holding
their keys.**

DigiDollar is DigiByte's decentralized, USD-pegged stablecoin: you mint it by locking DGB as
collateral for a chosen lock period, and redeem it to release that collateral. Diginaut builds and
signs every consensus transaction in your browser.

**Try it: <https://diginaut.ludere.space>** — create a wallet in seconds and explore the full
dashboard, mint calculator, and send/receive flows. A permanent **testnet instance at
<https://dgb.ludere.space>** lets you exercise the complete mint / transfer / redeem cycle with
valueless coins: create a wallet, claim testnet DGB from the built-in faucet, and mint DigiDollar
end-to-end. Both run the full stack in this repo against a DigiByte Core **v9.26.4** node with a
real oracle price feed. Want to host your own? See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

> DigiDollar minting is a DigiByte softfork. On testnet it is already active; on mainnet it
> activates network-wide at the softfork block. Diginaut enables the mint flow automatically once
> the node it talks to reports DigiDollar active — the same build serves every network.

## How it works

- **Keys live in your browser** (BIP39 seed, BIP86 taproot derivation), never on a server
  (ADR-0001). Diginaut is taproot-native.
- Consensus-critical transactions (mint / transfer / redeem) are **built and signed client-side**
  by the pure-protocol library, then broadcast through a shared read/broadcast node that never
  sees a private key.
- Before any fund-moving code ships, it must pass a **differential harness**: JS-built
  transactions byte-identical to DigiByte Core-built ones on regtest (ADR-0001, ADR-0002).
- **One build serves every network.** The banner, title, and address format are decided at
  runtime from the chain the node reports — nothing about the network is baked into the HTML.

## Monorepo layout

| Path | What it is |
|---|---|
| `packages/digidollar-js` | Pure-protocol DigiDollar library — deterministic functions, zero I/O (ADR-0004). Mirrors DigiByte Core v9.26.4 arithmetic exactly. |
| `apps/wallet` | The Diginaut web app — dashboard, mint calculator, send/receive, and an RPC allow-list proxy. First consumer of the library. |
| `apps/indexer` | Address-level query façade (ADR-0003) over a stock ElectrumX — UTXOs and history by address only; xpubs never reach it. |
| `apps/faucet` | Testnet faucet — hands out valueless testnet DGB so new users have collateral to experiment with. |
| `docs/adr/` | Architecture decisions. `CONTEXT.md` is the domain glossary; `ROADMAP.md` traces how the project got here. |

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
- Keys are held only in the browser. **There is no server-side backup** — if you lose your device
  storage without having backed up your seed phrase, the funds are gone. Back up your seed.
- Known deferrals and their triggers live in [TODO.md](TODO.md).

## Status

All PRD stories are shipped and the wallet runs the full mint / transfer / redeem cycle. The
[roadmap](ROADMAP.md) records the path from the initial restructure (M0) through nodeless
onboarding (M1), the differential harness (M2), and the stablecoin release (M3). Work is tracked
in the repo's issue tracker; architecture decisions live in [docs/adr/](docs/adr/).

## License

[MIT](LICENSE) © Anton Lysakov. All packages in this monorepo are MIT-licensed; the
publishable `digidollar-js` library carries its own copy of the license. Third-party
dependencies (`@noble/*`, `@scure/*`, `qrcode-generator`) are MIT.

This software is provided for demonstration and educational purposes, **as is** and without
warranty of any kind (see the license). You are solely responsible for any funds or keys you
use with it.
