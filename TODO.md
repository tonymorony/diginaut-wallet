# Deferred work

Things we consciously punted, with the reason. Revisit before the trigger listed.

## On deploy

- **Point tx history at a real block explorer.** The Activity list links txids via the
  `EXPLORER_TX_URL` prefix (e.g. `https://<explorer>/tx/`); it is unset on regtest, so links
  render as plain text. Set it in the server env once a public DigiByte-testnet explorer is
  chosen for dgb.ludere.space.

## Branding & legal (before public launch)

Tracked as tickets (`ready-for-agent`):

- **[#77](https://github.com/tonymorony/digidollar-wallet/issues/77)** — rename everything
  to the `diginaut-wallet` brand (repo, package names, README/docs).
- **[#78](https://github.com/tonymorony/digidollar-wallet/issues/78)** — add license files
  across the monorepo, referenced from the READMEs.
- **[#79](https://github.com/tonymorony/digidollar-wallet/issues/79)** — add demo/educational
  disclaimers (no warranty, user bears all risk) in the UI footer + README.

## Before mainnet

- **Force seed-phrase backup + treat key safety seriously.** v0.1 uses a frictionless,
  optional-backup flow justified *only* by testnet-only scope (stakes near zero, faucet refills).
  Before this wallet ever points at mainnet: force a backup/confirm step, encrypt properly, and get
  a security review. Losing browser storage on mainnet = catastrophic loss.
