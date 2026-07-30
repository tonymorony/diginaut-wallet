# DigiDollar consensus facts (earned from Core source — not guessable)

Verified: 2026-07-26 vs DigiByte Core v9.26.4 (local checkout: `~/devel/digibyte`, v9.26.2-2 —
close enough for RPC/consensus shape questions; prefer the v9.26.4 tag for exact line numbers).
Sections "Volatility freezes & fees" and "DD script surface" verified 2026-07-29 (twice:
reader + independent verifier agents, same checkout).
Primary docs: `docs/discovery/mainnet-consensus-facts.md`, `regtest-oracle-findings.md`,
`mainnet-oracle-findings.md`, `docs/discovery/dd-defi-yield.md` (DeFi capability map).

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

## Volatility freezes & fees (corrects the 50%/7d-only note in mainnet-consensus-facts.md)

- Tiers (`consensus/volatility.h:63-75`): ≥20%/1h → new mints frozen; **≥30%/24h → ALL DD ops
  frozen** (`FREEZE_ALL_24H_BPS=3000`); ≥50%/7d = emergency mode, also freezes all ops.
- The 8,640-block (~36 h) cooldown is a **floor, not a duration**: unfreeze also requires
  volatility back under thresholds (`volatility.cpp:314-320`). Timeout/refund windows must
  treat freeze length as unbounded.
- A mint is also rejected if its own block's candidate oracle price would cross 20%/1h
  (`WouldCandidateFreezeMinting`, `digidollar/validation.cpp:2688-2696`).
- The "0.1 DGB min DD tx fee" is **not consensus or policy** — wallet-side constant in Core's
  builder only (`digidollar/txbuilder.cpp:37`); DD txs pay ordinary feerate.
- Mempool requires a fresh oracle quote for MINT/REDEEM only (`src/validation.cpp:289-294`);
  transfers are price-independent and survive oracle stalls.

## DD script surface (drives the DeFi map — full analysis in `docs/discovery/dd-defi-yield.md`)

- A DD token output key is **any** 32-byte witness-v1 program, nValue exactly 0
  (`validation.cpp:61-68, 2792-2817`): tapscript trees, MuSig2/FROST aggregates all legal.
  Spend auth is ordinary BIP341/342 — DD validation never inspects witnesses.
- One transfer may atomically mix DD legs with valued DGB legs of any script type (valued
  outputs skipped, `validation.cpp:1733`) → single-tx DD↔DGB swaps work.
- Third-party mint is legal: collateral funder, OP_RETURN ownerKey, and DD recipient may all
  differ (`validation.cpp:1123-1126, 1405-1443`). ownerKey may be an aggregate — fixed forever.
- Vault claims are non-transferable (NUMS + byte-exact leaf reconstruction; non-redeem vault
  spends invalid, `validation.cpp:2645-2673`); one vault per redeem tx; burn-DD may be any
  confirmed DD; ≤1 DD change output allowed on redeem (`validation.cpp:2108-2149`).
- **Silent-burn hazard**: a tx *without* the 0x0770 marker spending a DD UTXO is valid and
  destroys the DD (`validation.cpp:800-805`). The taproot sighash commits nVersion under every
  hash type — pinned templates close the hazard.
- DD inputs must be **confirmed** (no DD mempool chains, `validation.cpp:1810-1813`); zero-value
  P2TR anchor outputs are impossible in DD **transfers** (every zero-value P2TR is classified as
  a DD output and must carry a ≥$1 envelope amount; redeem change is the one carve-out — see
  § Validation asymmetries).
- Transfer envelopes ride the default 83-byte OP_RETURN relay cap with no DD exemption
  (`policy.h:74`) → ~8–20 DD outputs per standard transfer.

## Misc

- All wallet receive addresses are taproot (bech32m, witness v1); web wallet is taproot-only
  on receive. Legacy/P2SH **send** support exists (`decodeAddress` handles D…/S…/3…).
- `generatetoaddress` is useless on live nets (stale template → orphans). Regtest only.
- Witness-version decoding: v17–31 invalid, v26 = OP_RETURN = burned funds (bug fixed in #113
  — keep the decoder strict).
