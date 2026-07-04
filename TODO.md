# Deferred work

Things we consciously punted, with the reason. Revisit before the trigger listed.

## Rework required by the pivot to a non-custodial wallet (ADR-0001)

- **Current UI's address generation is custodial-by-accident.** The "Generate testnet address"
  button calls `getnewdigidollaraddress` on the shared node — the private key lands in the *node's*
  wallet, contradicting ADR-0001. Replace with client-side BIP39/BIP86 derivation in the browser;
  drop `getnewdigidollaraddress` from the RPC allow-list.
- **README.md describes the pre-pivot project** (read-only testnet UI). Rewrite around the
  non-custodial wallet architecture once the rework lands.

## Before mainnet

- **Force seed-phrase backup + treat key safety seriously.** v0.1 uses a frictionless,
  optional-backup flow justified *only* by testnet-only scope (stakes near zero, faucet refills).
  Before this wallet ever points at mainnet: force a backup/confirm step, encrypt properly, and get
  a security review. Losing browser storage on mainnet = catastrophic loss.
