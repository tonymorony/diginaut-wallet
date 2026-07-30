# DeFi & yield for DigiDollar — without touching DGB consensus

Brainstorm + feasibility research, 2026-07-29. Method: 10-agent workflow — 5 researchers
(DigiByte Core source read at `~/devel/digibyte`; DigiAssets; Bitcoin-family DeFi patterns;
stablecoin yield economics; DigiByte/DD ecosystem), a 3-lens design panel (20 proposals),
then two adversarial verifiers: every consensus claim re-checked against Core source with
file:line evidence, every yield claim attacked for payer realism. Line refs are v9.26.2-2
(≈ v9.26.4). Hard constraint honored throughout: **no DGB consensus changes**. Convention:
consensus claims are file:line-verified against Core; ecosystem- and market-status claims
rest on the Appendix sources, as of 2026-07-29.

## 0. Verdict in one paragraph

DD is far more programmable than anyone has noticed: a DD token output's key is **any**
32-byte witness-v1 program, and DD spend authorization is ordinary BIP341/342 script
validation — so multisig custody, tapscript HTLCs/PTLCs, CLTV bonds, pre-signed channels,
and single-transaction atomic DD↔DGB swaps are all consensus-legal **today**. What DD lacks
is an *internal* yield engine: no fees, no liquidations, no issuer float — so every honest
yield product must import revenue from one of four real payers (traders, DD borrowers,
impatient minters, or labeled subsidies). The winning cold-start path is supply-first:
Mint-to-Order → one swap venue → a house peg desk → a Lightning on-ramp → OTC inventory
lending — plus one genuinely novel, protocol-native venue nobody had designed before this
exercise: a **maturity buy-back market** matching the consensus-guaranteed class of forced
DD buyers (minters at unlock) against exiting holders.

## 1. The capability map (verified against Core source)

What consensus **permits** today:

| Capability | Basis |
|---|---|
| DD under multisig / MuSig2 / FROST aggregate keys | DD output key never reconstructed or constrained; `IsCanonicalP2TROutput` checks version+size only (`digidollar/validation.cpp:61-68, 2792-2817`) |
| DD under arbitrary tapscript trees (hashlocks, CLTV/CSV, CHECKSIGADD) spent via script-path | transfer validation never inspects witnesses; `ValidateScriptPathSpending` is a permissive stub (`validation.cpp:2626-2639, 1881-1893`) |
| Single-tx atomic DD↔DGB swap | valued legs of any script type mix freely with DD legs; valued outputs skipped by DD accounting (`validation.cpp:1733`) |
| Third-party mint: collateral funder ≠ ownerKey ≠ DD recipient | inputs never inspected; ownerKey only `IsFullyValid`; DD output key never compared to owner (`validation.cpp:1123-1126, 1405-1443, 1525-1530`) |
| Shared redemption control (ownerKey = aggregate, chosen at mint, forever) | both vault leaves end `<ownerKey> CHECKSIG` (`digidollar/scripts.cpp:63-115`) |
| Redeem with market-bought DD; one DD change output allowed | burn-DD from any confirmed DD UTXOs (`validation.cpp:1942-2011, 2108-2149`) |
| Reuse of the coinbase oracle bundles (7-of-35 MuSig2, median micro-USD, per-block) as a fraud-provable attestation source for off-chain layers | chain-committed, independently verifiable vs chainparams keys (`primitives/oracle.h:119-149`) — but **not** directly a DLC oracle (no pre-announced nonces, signer set varies per bundle) |

What consensus **forbids** (each kills a design class):

- **Transferable positions**: vault tree is NUMS + byte-exact reconstruction; any non-redeem
  vault spend is invalid (`bad-collateral-spend-missing-dd-burn`, `validation.cpp:2645-2673`).
  No partial redemption, one vault per redeem tx, all-or-nothing full-collateral release.
- **Price/health-conditional scripts**: `OP_CHECKPRICE` deterministically disabled;
  `OP_CHECKCOLLATERAL` compares witness-supplied numbers only. No CTV/CAT/APO → no covenants,
  no eltoo, no covenant-native Ark.

Landmines every builder must engineer around (all source-verified):

1. **Silent burn**: a tx *without* the 0x0770 nVersion marker spending a DD UTXO is valid and
   destroys the DD (`validation.cpp:800-805`). Mitigation is absolute: the taproot sighash
   commits nVersion under every hash type, so pinned templates close the hazard.
2. **Freeze duration is unbounded**: 20%/1h freezes mints; **30%/24h freezes ALL DD ops**
   (`FREEZE_ALL_24H_BPS=3000`); 50%/7d emergency also freezes all; the 8,640-block (~36h)
   cooldown is a *floor* — unfreeze additionally needs volatility back under thresholds
   (`consensus/volatility.h:63-75`, `volatility.cpp:314-320`). Every refund CLTV / default
   window needs crash-regime margins, and *every venue goes dark simultaneously* in stress.
3. **No unconfirmed DD chains** (`validation.cpp:1810-1813`) — one conf per hop; tolerable at
   15s blocks, kills CPFP-style tricks for DD legs.
4. **$1 min per DD output incl. transfer change**, $100k max per output; sub-$1 only off-chain.
5. **Envelope rides the 83-byte OP_RETURN relay cap** (no DD exemption, `policy.h:74`) —
   ~8–20 DD outputs per standard transfer; caps CoinJoin/batch sizes silently.
6. **Zero-value P2TR anchors are impossible** in DD txs (every zero-value P2TR must carry a
   ≥$1 envelope amount) — pre-signed trees must embed real fee inputs.
7. **0.1 DGB "min DD fee" is NOT consensus** — wallet-side constant in Core's builder only
   (`digidollar/txbuilder.cpp:37`); DD txs pay normal feerate policy.
8. Freeze state is node-locally reconstructed — treat freeze-boundary blocks as elevated
   rejection/reorg risk; don't settle irreversibly against 1-conf DD in threshold windows.

## 2. Where yield can honestly come from

DD has no stability fee, no liquidations, no issuer, no protocol revenue (all verified — Core
comments literally say "NO early redemption, NO forced liquidation, NO exceptions"). Of the
eight known stablecoin yield sources, four are structurally unavailable (liquidation revenue,
RWA/T-bill float, basis carry — no DGB perp/borrow venues exist post-delistings — and issuer
float). The four available payers, in order of realism:

1. **Traders** — spread/LP fees on DD↔DGB (and eventually DD↔USDT) liquidity that otherwise
   doesn't exist anywhere.
2. **DD borrowers** — market makers and DGB longs for whom borrowing DD at single digits beats
   self-minting at 200–1000% term-locked collateral plus a repurchase obligation.
3. **Impatient minters** — pay premiums (Mint-to-Order) or discounts (early-liquidity deals)
   to escape the lock they bought.
4. **Subsidies** — legitimate for bootstrapping, but per this repo's copy rules must ship as
   "time-limited subsidy with published runway", never as "yield".

Structural insights worth keeping:

- **Mint/redeem already IS a stability pool**: minters are leveraged-long stability providers,
  DD holders are stability seekers — the structure Fedimint/Stablesats synthesize off-chain,
  here consensus-enforced. What's missing is only a rate flowing from holders' counterparties.
- **The lock-tier table is an interest rate paid to nobody**: cheaper leverage (200% vs 1000%)
  is bought with time-locked illiquidity — a deadweight option premium. Monetizing that
  illiquidity (premiums, discounts, term deals) is the native yield curve.
- **DD's peg floor is deferred, not instant**: every minter must buy back their exact DD at
  maturity to reclaim ≥2× collateral. Below-par DD has a consensus-guaranteed future buyer
  class — on a schedule the indexer can compute per-block. Design for a $0.97–$1.02 band, not
  a hard $1. (Tail risk: minter abandonment after a >50% DGB drawdown severs the floor for
  those positions, silently, until maturity — publish system-health metrics.)
- Liquity v2 is the proven retrofit blueprint (borrower-set rates, ~75% to holders), but every
  one of its mechanisms needs programmable state — on this chain the faithful equivalent is a
  future soft fork; off-chain replicas are custodial and must say so.

## 3. Design panel results — 20 proposals, verified

Two verifiers: **C** = consensus-feasibility vs Core source, **E** = economics/realism.
✓ sound · ~ sound-with-caveats · ✗ broken.

| # | Proposal (lens) | C | E | Bottom line |
|---|---|---|---|---|
| 1 | Swap Desk, script-native single-tx DD↔DGB (script) | ✓ | ~ | Real taker-paid spread; merge with #8/#14 into ONE desk program |
| 2 | **Mint-to-Order** atomic primary issuance (script) | ✓ | ~ | Best cold-start: creates supply; premium prices the lock the buyer avoids |
| 3 | P2P loans, pre-signed ACP repayment + CLTV default (script) | ~ | ~ | Airtight mechanism; "lender sold a covered put" — rates will be high |
| 4 | Assignable-at-mint positions, MuSig2 ownerKey (script) | ~ | ~ | Mode A (bilateral co-funded mint) viable opportunistically; not a "note" |
| 5 | DD Tab Channels, Spillman-style (script) | ~ | ~ | Cleanest construction; payer (metered APIs/agents) still speculative |
| 6 | Commerce escrow, arbiter-can't-take (script) | ✓ | ~ | Infrastructure, not yield; build when there's something to buy |
| 7 | DD CoinJoin, maker fees (script) | ~ | ✗ | No payer at this scale + envelope cap limits anonymity sets; park |
| 8 | Swap Desk, coordinator-batched (federated) | ~ | ~ | Same product as #1; SINGLE\|ACP listings leak change on partial fills — batch/whole-UTXO modes only |
| 9 | Cents Layer, DD ecash mint (federated) | ✓ | ~ | The blessed sub-$1 architecture; honestly custodial, PoR-auditable |
| 10 | **Peg Desk**, house-run band MM (federated) | ✓ | ~ | The correct first liquidity op; buy sub-par DD → redeem own vaults at par is the one real arb |
| 11 | Money market w/ fraud-provable margin arbiter (federated) | ✓ | ~ | Elegant (oracle-anchored arbitration; enforcement survives freezes) but third lending stack — sequence last |
| 12 | Term Desk, statechain position resale (federated) | ~ | ✗ | Dead: buyer must idle full DD burn until maturity + ERR invalidates exits in crisis + collusion theft |
| 13 | DD Rounds → clArk (federated) | ~ | ✗ | Ark cures a disease DigiByte doesn't have (15s blocks, sub-cent fees) |
| 14 | RFQ desk + USDT HTLC leg (cross-chain) | ✓ | ~ | Keep its two unique parts: the USDT corridor (only dollar edge) + client-side template verification |
| 15 | **DD⇄Lightning submarine swaps**, Boltz pattern (cross-chain) | ~ | ~ | The only user-acquisition product — imports capital from outside DGB |
| 16 | wDD on EVM via FROST federation (cross-chain) | ✓ | ✗ | Federation ops cost ≫ fee revenue for years; ship only its PoR watchdog page |
| 17 | Repo desk, OTC DD inventory lending (cross-chain) | ✓ | ~ | Most realistic credit product; start as admin tool for 2–3 OTC deals |
| 18 | Delta-neutral issuance desk (cross-chain) | ✓ | ~ | Valuable *no*: no DGB perp depth → carry impossible; ship its risk dashboard |
| 19 | Komodo DeFi Framework DD module (cross-chain) | ~ | ✗ | Multiplicative improbability; publish the swap-template spec instead |
| 20 | DD-quoted DigiAssets marketplace (cross-chain) | ~ | ✗ | Dead market; extract the DigiAssets burn-guard as urgent wallet safety |

## 4. DigiAssets: the honest answer

The user asked specifically — the answer is **use it for nothing load-bearing**:

- Rules (royalties incl. oracle-pegged, KYC, vote, expiry, deflate, signers) are enforced only
  by DigiAsset Core indexer nodes — a bus-factor-1 C++ project — never by L1 consensus.
  Violations and protocol-unaware spends **burn** the assets (documented user losses exist).
- A tx can never be both a DD tx and a DigiAssets tx (one-OP_RETURN relay policy + distinct
  magics 0x4444/0x4441 + nVersion gating) → no atomic DD-for-asset settlement, ever.
  Worse: a DD-marked tx spending asset-bearing UTXOs burns those assets at the meta-layer.
- Ecosystem status 2026-07: digiassetX in account-recovery wind-down, docs domain parked for
  sale, price feed silent since 2026-07-01, DigiAsset Core v9.26.x/DD-chain compatibility
  unverified (upstream documents only v7/v8) — though mctrivia's 2026-07-22 PR shows a pulse.
- Defensible uses: cosmetic receipts/badges and vote signaling only. Claims must live in
  DD-native constructs under L1 consensus.
- **Urgent regardless**: a DigiAssets burn-guard in Diginaut's coin selection (flag ~600–1000
  sat UTXOs matching DA patterns on imported seeds, exclude from spends, warn). Every user
  importing an old seed is exposed today.

## 5. Recommended sequence

**Step 0 (before any product):** exercise real-funds mint → transfer → redeem on mainnet
(#59 — still never done); ship the **system-risk dashboard** in the indexer (live oracle
price, 1h/24h/7d move meters vs 20/30/50% thresholds, system health, DCA tier, per-tier mint
exposure, freeze flag) — every product below consumes it; land the wiki corrections
(freeze tiers, fee non-rule) in this doc's PR.

1. **Mint-to-Order** — "Sell while minting" toggle on the existing mint screen; copy-paste
   PSBT ceremony; creates supply while monetizing the topside arb. Smallest true MVP.
2. **One desk program, staged** (merging #1/#8/#14): interactive co-signed DD↔DGB swap →
   house MM quoting → SINGLE|ACP listings (whole-UTXO fills only) → RFQ + USDT HTLC leg.
   One PSBT/envelope assembler, one indexer bulletin board, one freeze banner.
3. **Peg Desk phase 1** — house capital only, zero custody, published NAV with realized-spread
   vs subsidy split; short-tier mint inventory; sub-par buy → redeem-own-vault arb.
4. **"Top up via Lightning"** — one-direction submarine swap (Boltz pattern); the only
   proposal importing outside users/capital; timeout margins sized for unbounded freezes.
5. **Repo desk** — OTC DD lending to the market makers steps 2–3 create; admin tool first;
   deep haircuts (30%/24h is a real DGB regime); one standardized freeze-tolling convention
   (grace in unfrozen blocks, indexer-attested) shared by all future credit products.

**The two products the panel missed** (found by the verifiers — arguably better than half the
slate):

- **Maturity buy-back market**: the indexer already knows every vault's unlockHeight, size,
  and owner. A maturity-calendar order book matching minters' forced repurchase bids against
  holders' asks is the most protocol-native venue possible — the buyer class is
  consensus-guaranteed and schedulable, and it directly deepens the peg floor. Also the
  natural hedge surface for Mint-to-Order minters.
- **A fiat edge**: 19 of 20 proposals denominate every exit in DGB or sats. For a product
  marketed as a dollar, prioritize the USDT corridor to real size (named liquidity partner)
  and merchant/invoicing tooling (DD payment requests, BIP21 links, checkout snippet) — the
  cheapest lever to create the payers everything else assumes.

**Salvage from broken proposals (ship regardless):** DigiAssets burn-guard (#20); indexer
proof-of-reserves watchdog page for any custody address (#16) — positions Diginaut as the
ecosystem's reserve auditor and becomes the accountability rail for the Cents Layer; public
DD swap-template spec (#19) — HTLC leaves, envelope pinning, freeze-slack rules; ~90% shared
with the Lightning-corridor library work.

**Later, demand-gated:** commerce escrow (#6), then ONE of Tab Channels (#5) vs Cents Layer
(#9) — they compete for the same not-yet-existing sub-$1 payer; let the first real payee's
shape decide. Money market (#11) only if scale ever justifies margin machinery.

## 6. Cross-cutting engineering invariants

- **One template library**: all DD-touching constructions share a single audited
  PSBT/envelope assembler whose non-optional invariant is nVersion + envelope pinning
  (the sighash commits nVersion under every hash type — use it). Template code is the
  scarcest, highest-blast-radius engineering here; never triplicate it.
- **Correlated-freeze honesty**: every venue, loan, channel close, and bridge in this space
  halts simultaneously in the same 30%/24h event, exactly when exit demand peaks. One shared
  indexer freeze flag; stagger obligations so nothing matures inside a cooldown; stress docs
  that say plainly: *in a crash, DD is unsellable on-chain for at least 36 hours*.
- **Label = mechanism** (per CLAUDE.md, it's a defect otherwise): "arbiter can decide
  disputes, can never take the money"; "custodial beta"; "bridged wDD custodied by a 5-of-9
  federation"; "time-limited subsidy with published runway"; never "savings"/"deposits"
  (GENIUS/MiCA posture: DD sits with Liquity/RAI — no issuer, keep hosted components
  non-custodial).

## 7. Alignment with the DD authors' direction

The whitepaper (DigiByte-Core discussion #319) and Implementation Spec v5 (#324) explicitly
name on-chain lending/borrowing/trading as DD's purpose while deferring tokenized/bond-style
collateral, transferable positions, partial redemption (reserved: OP_SUCCESS203), stability
fees, and yield out of v1. So wallet-layer DeFi *aligns with* their stated direction; any
position-transfer product should be designed so a future consensus-native successor
supersedes it cleanly. Community proposals already circling this space: Paymaster fee
sponsorship (#430), x402 agent payments on testnet (#426). Flagged for the future: a
Liquity-v2-style basis-point mint surcharge routed to holders would be the single highest-value
*consensus* change if the community ever wants protocol-native yield — DigiByte has already
shipped bespoke DD opcodes once.

## Appendix: primary sources

- Core source (all claims file:line-verified twice): `src/digidollar/{validation,scripts,txbuilder}.cpp`,
  `src/consensus/{digidollar.h,err.cpp,dca.h,volatility.h+cpp}`, `src/primitives/oracle.h`,
  `src/script/interpreter.cpp`, `src/policy/policy.{h,cpp}`, `src/kernel/chainparams.cpp`.
- DD docs: whitepaper (org discussion #319), spec v5 (#324), `doc/TERRALUNA_VS_DIGIDOLLAR.md`,
  `doc/DIGIDOLLAR_OPRETURN_PQC_MINT_PLAN.md`, release-notes 9.26.5; discussions #425 ($1 floor
  permanent), #428, #430, #426.
- DigiAssets: DigiAsset_Core source (`DigiByteTransaction.cpp`, `DigiAsset.cpp`, `KYC.cpp`,
  `Database.cpp`), digiasset-encoder notes, DigiAssets-Protocol-Specifications wiki,
  digiassetx.com (wind-down page), feed-address tx history via digiexplorer.
- Patterns/prior art: dlcspecs Oracle.md; BitVM2 paper + Citrea Clementine; Ark (Arkade,
  Second/Bark); Spark; Mercury Layer; Taproot Assets v0.8 + USDT-on-LN; RGB v0.12; Cashu
  NUTs / Fedimint (incl. stability pool); Stablesats; Stable Channels; JoinMarket
  yield-generator; Boltz; Elements/Liquid; Babylon staking docs.
- Economics: Liquity v1/v2 docs + blog (user-set rates, stability pool); Sky savings rate;
  Ethena docs + 2026 basis retreat; Curve fee/emission history; Tether Q1-2026 attestation;
  Klages-Mundt & Minca arXiv:2004.01304; Stablecoins 2.0 (ACM AFT 2020); GENIUS Act analyses;
  MiCA ART/decentralization commentary.
