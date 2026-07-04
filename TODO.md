# Deferred work

Things we consciously punted, with the reason. Revisit before the trigger listed.

## Before mainnet

- **Force seed-phrase backup + treat key safety seriously.** v0.1 uses a frictionless,
  optional-backup flow justified *only* by testnet-only scope (stakes near zero, faucet refills).
  Before this wallet ever points at mainnet: force a backup/confirm step, encrypt properly, and get
  a security review. Losing browser storage on mainnet = catastrophic loss.
