# Security Policy

Diginaut is a non-custodial wallet: the seed and every key derived from it are generated and used
in the browser and never leave the device. On mainnet those keys control real DGB collateral and
real DigiDollar, so a vulnerability here can put real funds at risk. Please disclose privately.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Disclosure before a fix exists puts
users' funds at risk.

Use **GitHub Private Vulnerability Reporting** instead:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected commit or deployment, and a proof of concept if you have one.

That opens a private advisory visible only to you and the maintainer, so triage and a fix can
happen before anything is public. GitHub is currently the only private reporting channel for
this project — there is no security email or PGP key yet.

If private reporting is not available to you, open a plain issue asking for a private channel —
**with no technical details in it** — and you will be pointed to one.

## What to expect

- An acknowledgement, usually within a few days. Diginaut is maintained by one person, so that is
  a good-faith aim rather than a guaranteed response time.
- Then: confirmation of the issue, a fix, and disclosure timing agreed with you before anything
  is published.
- Fixes land in this repository first. The live deployments — <https://dgb.ludere.space>
  (testnet) and <https://diginaut.ludere.space> (mainnet) — are built from this repository's
  `main`, so there is no separate private source you are waiting on.

## Scope

In scope, the code in this repository — notably:

- `apps/wallet` — the browser wallet and its server proxy
- `apps/indexer` — the indexer façade in front of ElectrumX
- `apps/faucet` — the testnet faucet
- `packages/digidollar-js` — the pure protocol library
- `deploy/` — the reference compose stack and Caddy config
- `scripts/` and the repo-root CI config — `check-pins.mjs` is the supply-chain guard (exact
  version pins, digest-pinned images, lockfile integrity hashes) and `.github/workflows/` runs
  it, so a demonstrated bypass of either is a finding

Out of scope, because they are separate upstream projects: DigiByte Core and the node it runs,
ElectrumX, and the DigiDollar consensus protocol itself — lock tiers, the oracle price feed, and
the validation rules for mint, transfer, and redemption. Report those through the DigiByte
project's own security channels (<https://digibyte.org>). A bug in how Diginaut *uses* those
rules is in scope; a bug in the rules is not ours to fix.

## Good to know

- The wallet never transmits a seed or private key to a server, and holds no user funds. A
  finding that assumes server-side custody is probably a misreading — but a demonstrated path to
  key or fund exposure is exactly what we want to hear about.
- The testnet faucet is the exception: it is backed by a project-operated hot wallet on the
  shared node, so a way to drain or abuse it — cooldown bypass, spoofed rate-limit keys — is in
  scope. Testnet value only, but we want the report.
