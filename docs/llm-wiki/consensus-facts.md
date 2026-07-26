# DigiDollar consensus facts (earned from Core source — not guessable)

Verified: 2026-07-26 vs DigiByte Core v9.26.4 (local checkout: `~/devel/digibyte`, v9.26.2-2 —
close enough for RPC/consensus shape questions; prefer the v9.26.4 tag for exact line numbers).
Primary docs: `docs/discovery/mainnet-consensus-facts.md`, `regtest-oracle-findings.md`,
`mainnet-oracle-findings.md`.

## Limits & tiers

- Min mint **$100**, max **$100k**, min DigiDollar output **$1** (`DD_TX_LIMITS` in digidollar-js).
- 10 lock tiers, 1 h @ 1000% → 10 y @ 200% (table in README), + 1% safety margin, + DCA
  surcharge when system collateralization degrades (`getdcamultiplier` feeds real bps into
  every `requiredCollateralSats` call — never assume 1.0×).
- Consensus reject strings surfaced to users: `minting-frozen-volatility`,
  `all-operations-frozen`, `bad-dd-*` (mapping shipped in #62).

## Validation asymmetries (read from validation.cpp, cost real effort)

- **Transfer** enforces the $1 min on EVERY canonical-P2TR output **including change**
  (`digidollar/validation.cpp:1743` „transfer-dd-amount-below-minimum").
- **Redeem does NOT** — its scan only checks ≤1 DD change output + serialization bounds.
  Sub-$1 redeem change is accepted; do not "helpfully" guard it (would strand positions —
  full redemption is all-or-nothing).
- `bad-redeem-no-dgb-output` is satisfied by ANY output with nValue>0 — the collateral
  return counts, so folding redeem DGB change into fee is safe.
- Mint validation classifies outputs by **shape, not index** — dropping the change vout is safe.
- Mint change rule is really "non-P2TR + exactly one collateral output"; mint change is
  **P2WPKH by consensus** → wallet watches the v0 twin per derivation.
- Folded shapes proven vs real Core via `testmempoolaccept` (PR #124, `verify-fold-shapes.mjs`):
  3-output mint ending in OP_RETURN, 3-output transfer, 1-output redeem. Core also accepts
  unfolded — the fold is a **standardness** improvement, not a consensus fix.

## DD addresses — two encodings

- Core/Android `senddigidollar` accepts **ONLY** base58check `DD…/TD…/RD…` (2-byte version +
  32 B x-only key; prefix check in `digidollar.cpp:571`). NOT bech32m.
- Diginaut therefore displays the DD form on receive and accepts **both** encodings on send —
  `decodeDDAddress` / unified `decodeAddress()` in `packages/digidollar-js/src/address.js`
  (zero-dep base58check, SHA256d checksum, byte-exact vs a Core golden vector).
- Version bytes (Core chainparams.cpp): mainnet 30/63/5; testnet+regtest share 126/140.

## Oracle

- Mainnet: fixed roster, **7-of-35 MuSig2/Schnorr threshold**, keys in chainparams. The
  network provides the price; **we run nothing oracle-related**. Price in micro-USD per DGB.
- Regtest: native DigiDollar support with a **mock oracle** (7 slots) — the differential
  harness is fully local.
- Mainnet activation: block **23,869,441**, 2026-07-17. At activation oracle showed price 0
  (warning) — a mint needs a non-zero price.

## Misc

- All wallet receive addresses are taproot (bech32m, witness v1); web wallet is taproot-only
  on receive. Legacy/P2SH **send** support exists (`decodeAddress` handles D…/S…/3…).
- `generatetoaddress` is useless on live nets (stale template → orphans). Regtest only.
- Witness-version decoding: v17–31 invalid, v26 = OP_RETURN = burned funds (bug fixed in #113
  — keep the decoder strict).
