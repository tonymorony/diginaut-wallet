# Deferred work

Things we consciously punted, with the reason. Revisit before the trigger listed.

## On deploy

- **Point tx history at a real block explorer.** The Activity list links txids via the
  `EXPLORER_TX_URL` prefix (e.g. `https://<explorer>/tx/`); it is unset on regtest, so links
  render as plain text. Set it in the server env once a public DigiByte-testnet explorer is
  chosen for dgb.ludere.space.

## Before mainnet

- **Force seed-phrase backup + treat key safety seriously.** v0.1 uses a frictionless,
  optional-backup flow justified *only* by testnet-only scope (stakes near zero, faucet refills).
  Before this wallet ever points at mainnet: force a backup/confirm step, encrypt properly, and get
  a security review. Losing browser storage on mainnet = catastrophic loss.
