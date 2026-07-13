# Mainnet DigiDollar consensus facts

Research for [Mainnet DigiDollar consensus facts (#51)](https://github.com/tonymorony/diginaut-wallet/issues/51),
part of the [Mainnet Diginaut launch](https://github.com/tonymorony/diginaut-wallet/issues/50) map.

**Sources verified 2026-07-10** — every claim below was checked against the
DigiByte Core **v9.26.4 tag** (`src/consensus/digidollar.h`, `src/kernel/chainparams.cpp`,
`src/digidollar/validation.cpp`, `src/digidollar/txbuilder.cpp`, `src/consensus/dca.cpp`,
`src/consensus/volatility.h`) and the live mainnet node (`getdeploymentinfo`,
DigiByte 9.26.3, height 23,828,832). Not inferred from testnet behavior or docs.

## Verdict

**digidollar-js is mainnet-correct as-is.** Mint economics, limits, lock tiers,
collateral arithmetic, and address encoding are identical between mainnet and
testnet26 in Core source; the library's `mainnet` entries match Core exactly.
The wallet's mainnet delta is **configuration, not consensus** (see #53).

## Transaction limits

`DigiDollar::ConsensusParams` defaults (consensus/digidollar.h) apply to **both**
mainnet and testnet — testnet sets them explicitly to the same values
(chainparams.cpp CTestNetParams); only regtest overrides them:

| Parameter | Mainnet | Testnet26 | Regtest |
|---|---|---|---|
| Min mint | **$100** (10,000¢) | $100 | $0.01 (1¢) |
| Max mint per tx | **$100,000** (10,000,000¢) | $100,000 | $1,000 |
| Min DD output | **$1** (100¢) | $1 | $1 |

- Enforced at consensus (`bad-dd-mint-amount`), and the min-mint check is
  height-gated: mainnet `minMintAmountActivationHeight = 23,627,520` — i.e.
  **the $100 floor applies from the moment DigiDollar activates**. No grace window.
- `DD_TX_LIMITS` in digidollar-js matches all three networks exactly.

## Addresses

- bech32 HRPs (chainparams.cpp): mainnet **`dgb`**, testnet `dgbt`, regtest `dgbrt`
  — matches `HD_NETWORKS` in digidollar-js, including SLIP-44 coin type
  **20 for mainnet** (test networks use 1). Derivation paths therefore differ
  between networks by design (`m/86'/20'/…` vs `m/86'/1'/…`).
- Legacy base58 (mainnet: pubkey prefix 30 = `D…`, script 63 = `S…`) — not used
  by our wallet; listed for completeness.
- A `"dd1"` address prefix appears only in an unused helper
  (`ValidateDDAddress`, consensus/digidollar_transaction_validation.cpp) that the
  real validation path never calls. **There is no special DD address format**:
  DD token outputs are ordinary P2TR scripts identified by the embedded DD
  script envelope, on all networks.

## The "mint change is P2WPKH" rule, sharpened

The actual consensus rule (digidollar/validation.cpp, `ValidateMintTransaction`) is:

1. In a mint tx, **any valued P2TR output is treated as collateral**, and
2. **exactly one collateral output is allowed**
   (`bad-mint-multiple-collateral-outputs`, security fix T1-04c — prevents a
   NUMS-verification bypass via a fake second collateral output).
3. Valued **non-P2TR** outputs are explicitly skipped as change ("P2WPKH, P2SH, etc.").

So change must be **non-P2TR**; P2WPKH is the wallet's chosen compliant type
(the "v0 twin" we derive per address). The rule is **network-independent** —
mainnet behaves exactly like testnet here.

## Activation (live-verified)

| Fact | Value |
|---|---|
| Deployment | BIP9 bit **23** |
| Signal start | 1780272000 = 2026-06-01 |
| Timeout | 1811808000 = **2027-06-01** (docs/articles saying "May 2028" are wrong) |
| `min_activation_height` | 23,627,520 (= 586 × 40320) |
| Current period | 23,788,800 → **23,829,120** |
| Signaling (2026-07-10, height 23,828,832) | 30,380 of threshold 28,224 with 287 blocks left — **lock-in guaranteed** at 23,829,120 |
| **ACTIVE at block** | **23,869,440** (= 592 × 40320) |
| ETA at 15 s blocks | **≈ 2026-07-17** |

Mainnet-only companion heights, all equal to 23,627,520: `nDDActivationHeight`,
`nOracleActivationHeight`, `nDigiDollarMuSig2Height`, `minMintAmountActivationHeight`.
Watch progress with `getdeploymentinfo` on the mainnet node.

## Collateral arithmetic — line-by-line parity confirmed

digidollar-js `requiredCollateralSats()` reproduces Core exactly:

- **Base** (digidollar/txbuilder.cpp): `ceil(ddCents × COIN × effectiveRatio × 100 / priceMicroUsd)`, `__int128`, capped at MAX_MONEY.
- **DCA** (consensus/dca.cpp `ApplyDCA`): `effectiveRatio = ceil(baseRatio × multiplierBps / 10000)`.
- **Safety margin** (`ApplyCollateralSafetyMargin`): `floor(required × 101 / 100)`.
- **Lock tiers** (consensus/digidollar.h): identical ten-tier table, 240 blocks @ 1000% … 10 years @ 200%. Network-independent.
- `MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS = 100` in both.

DCA health tiers (dca.cpp, authoritative over the stale comment block in
digidollar.h): ≥150% system collateral → 10000 bps (1.0×); 120–149% → 12500;
110–119% → 15000; <110% → 20000. digidollar-js takes `dcaMultiplierBps` as an
input, so the **wallet must feed it the real network health multiplier** on
mainnet rather than defaulting to healthy (feeds into #53).

## Consensus behaviors new to us that the wallet can hit on mainnet

- **Volatility freezes** (consensus/volatility.h, enforced in mint validation):
  a ≥20% oracle price move within 1 h rejects new mints
  (`minting-frozen-volatility`); ≥50% within 7 d freezes all DD operations
  (`all-operations-frozen`). The wallet should map these mempool reject strings
  to friendly errors (→ #53).
- **Oracle price sanity bounds**: consensus rejects prices outside $0.01–$10.00
  per DGB.
- **Oracle price freshness**: `priceValidBlocks = 20` (~5 min) on mainnet and testnet.
- Mainnet oracle system: **7-of-35 MuSig2** with hardcoded x-only pubkeys in
  chainparams (35 active on mainnet vs 24 currently active on testnet26), epoch
  40 blocks, price update every 4 blocks — detail belongs to
  [Mainnet oracle: who feeds the price (#52)](https://github.com/tonymorony/diginaut-wallet/issues/52),
  but the headline is that **the network provides signed prices; we run no oracle on mainnet**.

## Testnet26 → mainnet differences that matter to us

Only two things differ, and neither touches mint economics:

1. **Activation parameters** (real BIP9 signaling vs testnet's height-600 floor).
2. **Oracle roster** (35 active mainnet keys vs 24 on testnet; same 7-signature threshold).

Everything else — limits, tiers, arithmetic, change rule, address rules — is identical.
