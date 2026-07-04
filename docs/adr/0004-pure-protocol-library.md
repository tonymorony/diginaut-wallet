# DigiDollar protocol layer is a pure library — monorepo package, zero I/O

## Context

The consensus-critical JS (key derivation, DigiDollar output parsing/construction, tapscript,
sighash, Schnorr signing, lock tiers) is valuable beyond this wallet — it is effectively the
"DigiDollar SDK" other integrators lack. It needs a home and a boundary.

## Decision

The protocol layer lives as a **separate package in this monorepo** (`packages/digidollar-js`),
published to npm independently; the wallet is its first consumer (`apps/wallet`). A separate repo
is deferred until the API stabilizes and an external consumer exists — extracting later is cheap,
premature separation costs PR ping-pong while the harness is still reshaping the API.

The library boundary is **pure protocol, zero I/O**: deterministic functions only. No fetch, no
RPC clients, no knowledge of the indexer or shared node. Callers pass in UTXOs and oracle prices;
the library returns transaction bytes.

## Consequences

- The differential-test harness (ADR-0001) lives in the library as its test suite — inputs → bytes,
  compared against Core-built transactions.
- The library runs unchanged in browser and Node, and swapping infrastructure (indexer, node)
  never touches it.
- All network I/O concentrates in the apps, which stay thin.
