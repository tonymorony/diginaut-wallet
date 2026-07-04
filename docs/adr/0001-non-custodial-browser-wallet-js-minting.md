# Non-custodial browser wallet with client-side JS minting

## Context

We are building a public, open-source DigiDollar wallet aimed at easy onboarding: a new user
should be able to create a wallet, get testnet DGB from a faucet, and mint DigiDollar **without
running their own node**. Keys must stay with the user — the project never takes custody.

DigiByte Core's `mintdigidollartaproot` RPC only takes `<amount> <lockperiod>`, signs internally
with the node's own wallet keys, and depends on the node's oracle price state. There is **no
PSBT / unsigned-mint / external-signing path for minting** in the current spec.

## Decision

Keys are generated and held **in the browser** (non-custodial). The mint transaction is
**constructed and signed client-side in JavaScript** — inputs, the DigiDollar P2TR output(s) and
tapscript, and the Schnorr signature — then broadcast through a project-operated **shared read/
broadcast node** that never holds keys. A project faucet (a separate testnet hot wallet) dispenses
collateral so users can actually mint.

## Considered options

- **Custodial (shared node holds keys, mints for users).** Rejected — it makes the project a
  honeypot holding user collateral and keys.
- **Connect-your-own-node for minting.** Rejected — reintroduces the node requirement we are
  explicitly trying to remove; kills the onboarding goal.
- **Upstream a PSBT-mint RPC into DigiByte Core.** Not chosen as the primary path (depends on core
  maintainers and timeline) but remains the ideal long-term unblock and may run in parallel.
- **Client-side JS construction (chosen).** The only path that is simultaneously non-custodial,
  nodeless, and able to mint.

## Consequences

- We are reimplementing **consensus-critical** transaction construction (DigiDollar output script /
  MAST structure, oracle-price binding, Taproot key-path Schnorr signing) outside of Core. Getting
  the script structure wrong can produce invalid mints or lock collateral incorrectly.
- Mitigation is mandatory and **sequenced first**: the node acts as a "script oracle" (JS fetches
  the DigiDollar output structure + oracle attestation from read RPCs rather than hardcoding
  consensus rules), and the **first build task is a regtest differential-test harness** proving a
  JS-built mint tx is byte-identical to a Core-built one. No mint UI work begins until that gate
  passes; no JS-built tx is ever broadcast with value before matching Core.
- Testnet-only for now; hardening + security review required before mainnet (see TODO.md).
