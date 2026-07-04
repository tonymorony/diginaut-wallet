# Mint, redeem, and transfer ship together — never mint-alone

## Context

Minting locks DGB collateral to create DigiDollar. Redemption returns the locked collateral.
Transfer sends DigiDollar to another user. A wallet that can mint but not redeem is a one-way
trap; a stablecoin you cannot send to anyone is not usable as money — and the onboarding goal is
letting people actually *play* with DigiDollar, which includes paying each other.

All three are consensus-critical operations of differing difficulty: mint key-path-signs the
user's own collateral inputs (easiest); transfer spends a DigiDollar output carrying
`OP_DIGIDOLLAR` and its tapscript structure (not a plain payment); redemption spends via the
tapscript MAST path and must satisfy the oracle-threshold condition (7-of-35 Schnorr via
`OP_CHECKSIGADD` in Core v9.26.4) (hardest).

## Decision

Mint, redemption, and transfer are all in scope from the start, all under the same "node as
script oracle + differential-test harness" discipline (ADR-0001), and are released **together as
a single experimental feature**. The user-facing rule: no one can mint in the UI until they can
also redeem and transfer. Internal build order is free (mint first behind the harness is fine) —
the constraint is on what users can touch.

## Consequences

- "Done" for the wallet's stablecoin feature means all three operations work, not just mint.
- The first user-facing stablecoin release is a bigger slice; the nodeless onboarding surface
  (wallet + faucet + send/receive DGB + explorer + mint calculator) ships to users first,
  independent of the mint/redeem/transfer trio.
- The differential harness must cover three transaction shapes, including two tapscript spend
  paths (transfer, redeem), before any of them is exposed.
