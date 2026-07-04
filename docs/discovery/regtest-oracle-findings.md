# Discovery: DigiDollar on regtest — oracles, scripts, RPCs (issue #9)

Sourced from DigiByte Core **v9.26.4** source (not discussion summaries), 2026-07-04.
Files cited: `src/kernel/chainparams.cpp` (via `DIGIDOLLAR_ORACLE_SETUP.md`, verified against it),
`src/oracle/mock_oracle.{h,cpp}`, `src/digidollar/scripts.h`, `src/digidollar/txbuilder.cpp`,
`src/consensus/digidollar.{h,cpp}`, `src/consensus/dca.cpp`, `src/rpc/digidollar.cpp`.

## Verdict: the harness is UNBLOCKED — regtest fully supports DigiDollar, with a mock oracle

The biggest project risk resolves in our favor, better than hoped:

1. **Regtest runs DigiDollar natively.** Consensus params for regtest: **7 oracle slots,
   4-of-7 threshold**, DigiDollar activation height **650** (just mine 650 blocks), MuSig2 active
   from height 0, price update every block, 40-block epochs.
2. **A dedicated mock oracle exists, regtest-only** (`src/oracle/mock_oracle.*`): RPCs
   `enablemockoracle`, `setmockoracleprice <micro_usd>`, `getmockoracleprice`,
   `simulatepricevolatility`. The harness sets a deterministic price and mints — no live oracle
   network needed.
3. **Mock oracle keys are deterministic**: derived from `SHA256("digibyte_regtest_oracle_N")` —
   even oracle signatures are reproducible in a harness.
4. **Core's own functional tests prove the whole flow on regtest** (`test/functional/`):
   `digidollar_mint.py`, `digidollar_basic.py`, `digidollar_activation.py`,
   `digidollar_lock_tier_canonical.py`, `digidollar_collateral_spend_guards.py`, and ~dozens more.
   These are the harness's prior art and reference fixtures.

## Redemption is easier than ADR-0002 assumed

The redeem witness does **not** carry oracle signatures. Tapscript paths from
`src/digidollar/scripts.h`:

- **Normal redemption** (after timelock):
  `<lockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DIGIDOLLAR <amount> OP_DDVERIFY <ownerKey> OP_CHECKSIG`
  — the spender needs only **their own signature** plus an expired lock.
- **ERR path** (emergency, system <100% collateralized; also requires timelock expiry):
  `<lockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <100> OP_CHECKCOLLATERAL OP_NOT OP_VERIFY OP_DIGIDOLLAR <amount> OP_DDVERIFY <ownerKey> OP_CHECKSIG`,
  initial witness `<signature> <collateralRatio>`.

Oracle prices reach consensus via **MuSig2-aggregated oracle bundles** (`src/oracle/bundle_manager`,
`musig2_*`) that oracles broadcast and validation reads — the *user's* transactions never assemble
oracle signatures. Client-side signing is therefore user-key-only for mint, transfer, AND redeem.

## Output script structure (for the JS layer)

- Collateral outputs use a **BIP-341 NUMS point** as the Taproot internal key — provably
  unspendable key path; all spends are script-path.
- New opcodes beyond `OP_DIGIDOLLAR` (0xbb): **`OP_DDVERIFY`**, **`OP_CHECKCOLLATERAL`**.
- DigiDollar transactions are marked in `nVersion`: lower 16 bits `0x0770`
  (full marker `0x0D1D0770`), tx type in bits 24–31 (1=mint, 2=transfer, 3=redeem — only 4 types,
  no partial redemption).
- Mint commits to an **absolute unlock height** with a 100-block confirmation buffer
  (`MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS`).
- `CreateDigiDollarP2TR(ownerKey, ddAmount)` builds the DD token output (`src/digidollar/scripts.h`).

## Real RPC surface (v9.26.4) — spec-discussion names are stale

Fund-moving (node-wallet-signed; confirms ADR-0001's premise — no PSBT/unsigned path, wallet must
be unlocked, private keys required):

| RPC | Signature |
|---|---|
| `mintdigidollar` | `(dd_amount_cents, lock_tier 0-9, [fee_rate])` — tier is an **index**: 0=1h … 9=10y |
| `senddigidollar` / `sendmanydigidollar` | transfer |
| `redeemdigidollar` | redeem |

Read RPCs — the "node as script oracle" surface for the JS layer:

`calculatecollateralrequirement`, `estimatecollateral`, `getredemptioninfo`,
`getdigidollarstats` (system health → DCA input), `getdcamultiplier`, `getoracleprice`,
`getalloracleprices`, `getoraclesigners`, `getoracles`, `getdigidollardeploymentinfo`,
`getdigidollaraddress`, `validateddaddress`, `listdigidollaraddresses`, `getdigidollarbalance`,
`listdigidollarpositions`, `listdigidollartxs`, `getprotectionstatus`.

**Stale names used in our wallet app / earlier docs** (from spec discussion #324) → real names:
`mintdigidollartaproot` → `mintdigidollar`; `getnewdigidollaraddress` → `getdigidollaraddress`;
`getoraclestatus` → `getoracleprice`/`getoracles`; `listoracles` → `getoracles`;
`listredemptionpaths`/`getdigidollarspendinfo` → `getredemptioninfo`. Our allow-list and mocks
need renaming (follow-up in #4/#5 wiring).

## Fees

- DD transactions have a **fee floor**: `MIN_DD_TX_FEE = 0.1 DGB`; `mintdigidollar` floors
  `fee_rate` below 35,000,000 sat/kB (0.35 DGB/kB) up to that value.

## Attention points for the harness

1. **Unit inconsistency in Core**: `ValidateCollateralRatio` (`digidollar_transaction_validation.cpp`)
   comments say oracle price is "cents per DGB" with $-bounds that don't match, while
   `txbuilder.cpp` and the mock oracle use **micro-USD**. The harness must pin actual on-wire
   units per call site; do not trust comments.
2. `lock_tier` is an index (0–9) at the RPC layer; `digidollar-js` uses string ids — keep an
   explicit index↔id mapping in one place.
3. Tier table, DCA bps math, ceiling division, and the +1% margin are already mirrored and tested
   in `digidollar-js` (see #2 / PR #18).

## Remaining to complete #9's acceptance criteria

- [ ] Scripted, reproducible regtest stand: build/obtain `digibyted` v9.26.4, script
      `-regtest` node + mine 650 blocks + `enablemockoracle true` + `setmockoracleprice` +
      smoke `mintdigidollar`. (Requires building Core locally — decision on build vs release
      binaries pending.)
- [x] Can oracles run on regtest / how mint & redeem get price data — **answered above**
- [x] DigiDollar output-script + oracle-binding structure from Core C++ — **documented above**
- [x] Read-RPC list for the "script oracle" — **documented above**
- [ ] Human review of these findings (HITL gate for M2 design)
