# DD Lock & Earn — Pilot Protocol Specification

**Diginaut** · non-custodial browser wallet for DigiByte DigiDollar
Document version 0.1.0 · 2026-07-29 · Status: **testnet pilot specification**
Networks: DigiByte testnet first (dgb.ludere.space), mainnet after pilot review
Audience: engineering, integrators, community reviewers

Every consensus claim in this document is cited against DigiByte Core v9.26.x source
(file:line). The mechanism was exercised end-to-end in an interactive state-model
prototype before this specification was written. **No DigiByte consensus changes are
required or proposed.**

---

## 1. Summary

DD Lock & Earn is a commitment-tier savings product for DigiDollar holders:

- A user **locks their own DD** in a self-custodial, consensus-enforced time-lock (a
  "bond") for one epoch. The keys never leave the user's wallet. Nobody — including the
  operator — can move, freeze, or confiscate the principal.
- The operator **pre-funds a floor reward** for the epoch and pre-signs its
  distribution before the epoch starts. After a one-time key-deletion step, the floor
  payout becomes irrevocable: any staker can broadcast it, even if the operator
  disappears.
- A **variable top-up** above the floor may be paid from operator revenue at epoch
  close. It is a promise, and is labeled as one.

Design constraints, in priority order:

1. **Zero custody of user principal.** At no point does the product hold, pool, or
   have signing power over a staker's DD.
2. **Label equals mechanism.** Every UI string names the actual guarantee: what is
   consensus-enforced, what is cryptographically irrevocable, and what is a promise.
3. **Consensus-unmodified.** Everything below runs on script constructions DigiByte
   consensus already accepts today.

## 2. Roles and epoch lifecycle

Two roles: **staker** (any wallet user) and **operator** (the Diginaut team during the
pilot). One epoch:

| Phase | Blocks (testnet pilot) | What happens |
|---|---|---|
| Registration | epoch start → start + R | Stakers lock DD into bonds (unlock height = epoch end). Locks confirm in ~15–30 s. |
| Escrow | during registration | Operator escrows the floor pool, pre-signs the distribution, publishes the signed chunks, deletes the ephemeral escrow key. |
| Accrual | registration close → epoch end | Nothing to do. Bonds are immobile by consensus; the signed distribution is held by every staker. |
| Settlement | after epoch end | Any staker broadcasts the distribution (floor paid). Operator may pay the top-up. Stakers unlock bonds. |

## 3. On-chain constructions

### 3.1 The bond (staker principal — trustless)

A DD transfer moves the staker's DD to a P2TR output:

```
internal key : BIP-341 NUMS point (key-path spend is impossible)
leaf script  : <unlock_height> OP_CHECKLOCKTIMEVERIFY OP_DROP
               <staker_x_only_key> OP_CHECKSIG
```

Consensus basis: a DD token output's key may be **any** 32-byte witness-v1 program —
validation checks only version and size and never inspects witnesses
(`digidollar/validation.cpp:61-68, 2792-2817, 2626-2639`). Script-path spending of DD
outputs is ordinary BIP-341/342 validation. Unlock is a normal DD transfer via the
leaf, valid only at `height ≥ unlock_height`. There is no early exit, by design, and
no key path to bypass the timelock.

### 3.2 The floor escrow and pre-signed distribution (irrevocable after key deletion)

1. Operator computes the epoch floor pool = Σ(active stakes) × floor rate, and pays it
   to a P2TR DD output controlled by a freshly generated **ephemeral key**.
2. Operator builds and signs the **distribution transaction(s)**:
   - `nVersion` = DD transfer marker (`0x…0770`);
   - inputs: the escrow DD, signed `SIGHASH_ALL | ANYONECANPAY`;
   - outputs: pro-rata DD payouts, each ≥ $1.00, plus one DD OP_RETURN envelope;
   - `nLockTime` = epoch end height.
3. Signed chunks are published to every staker.
4. Operator **deletes the ephemeral key** and attests to it.

Before step 4 the operator can still double-spend the escrow (a "rug") — visibly,
on-chain, forever. After step 4, no signature exists that can spend the escrow except
the distribution; any staker attaches a fee input (`ANYONECANPAY` permits it) and
broadcasts after `nLockTime`. Operator disappearance does not affect the floor.

The BIP-341 sighash commits `nVersion` and `nLockTime` under every hash type
(`script/interpreter.cpp:1684-1685`), which pins the DD marker and the payout date
into every pre-signed template.

### 3.3 What this product never touches

No mint collateral vaults, no oracle dependency, no MuSig2/FROST, no pooled funds.
Pure DD transfers are price-independent — they keep working when oracle price bundles
stall (`src/validation.cpp:289-294`: the mempool oracle-freshness gate applies to
mint/redeem only).

## 4. Consensus constraints honored

| Constraint | Consequence in this product | Source |
|---|---|---|
| Every DD output ≥ $1.00, ≤ $100,000 | Sub-$1 pro-rata shares are not paid on-chain; they accrue as **carry** to the next epoch, shown in the UI | `validation.cpp:1756, 1761` |
| OP_RETURN relay cap 83 bytes, no DD exemption | ≤ 8 payouts per distribution transaction (conservative); larger epochs use multiple pre-signed chunks | `policy/policy.h:74` |
| DD inputs must be confirmed | A lock is `pending` for one block (~15 s) before it registers as `active` | `validation.cpp:1810-1813` |
| ≥30%/24h oracle move freezes ALL DD transactions; freeze duration is unbounded (cooldown is a floor) | During a freeze, locks, unlocks, and distribution broadcasts are all rejected. Nothing expires — CLTV and nLockTime transactions remain valid and confirm after the freeze lifts. The UI must state: *exit at maturity can be delayed by a volatility freeze* | `consensus/volatility.h:63-75`, `volatility.cpp:314-320` |
| Spending a DD UTXO from a tx without the 0x0770 marker silently destroys the DD | All transactions are produced by one audited template builder that verifies marker + envelope + own outputs before any signature | `validation.cpp:800-805` |
| Transfer conservation is exact (`inputDD == outputDD`) | The distribution pays exactly the escrowed pool; no fee can be taken from DD legs — fees come from DGB fee inputs | `validation.cpp:1874-1879` |

## 5. Where the yield comes from

**The floor rate is not a promise about the future.** The pool for epoch N is escrowed
**before epoch N starts**, out of revenue already realized. The advertised rate is:

```
floor_rate(N) = escrowed_pool(N) / total_locked(N)
```

If revenue was low, the next epoch honestly shows a lower rate. Because staker
principal is never pooled (§3.1), paying earlier participants from later participants'
deposits is *mechanically impossible* — the structure cannot be a Ponzi scheme even in
failure.

Revenue sources feeding the pool, with the payer named:

| Source | Who pays | Why they rationally pay |
|---|---|---|
| Mint-to-Order issuance premiums | DD buyers | Buying freshly minted DD at a small premium beats locking 200–1000% collateral for a term with an all-or-nothing repurchase obligation |
| Market-making spread | Traders | The desk quotes the only always-on DD↔DGB liquidity |
| Redemption arbitrage | Market structure | DD bought below $1 redeems the desk's own maturing vaults at par |
| Maturity-liquidity fees | Minters approaching unlock | Every minter must repurchase their exact DD at maturity; a known unlock calendar of locked DD is insurance against a squeeze |

**Pilot disclosure:** during the testnet pilot none of these payers exist at scale.
The floor pool is a **time-limited subsidy from the operator with a published
budget**, and the UI says exactly that. DigiDollar's protocol itself pays nothing:
consensus has no fees, no interest, and no emissions (verified: mint/transfer/redeem
carry no protocol fee of any kind).

## 6. Trust model, stated bluntly

| Leg | Guarantee | Enforced by |
|---|---|---|
| Bond principal | Cannot be stolen, moved, or withheld by anyone; unlocks at height H (possibly delayed by a network-wide freeze) | DigiByte consensus: CLTV + NUMS internal key |
| Floor payout | Irrevocable once the escrow key is deleted; broadcastable by any staker without operator cooperation | Pre-signed transaction + ephemeral-key deletion. Residual trust: key deletion is unprovable (statechain-class). A rug before deletion is possible and permanently visible on-chain |
| Variable top-up | Operator promise | Reputation + published per-epoch revenue accounting on the indexer |

What the operator **can never do**: touch staker principal; redirect the distribution
after key deletion; extend anyone's lock.
What the operator **can do**: rug the escrow *before* key deletion (public, provable);
decline to pay the top-up; set next epoch's floor rate.

## 7. Pilot scope (M0)

Components:

1. **Lock screen** in the Diginaut wallet — build, verify, and broadcast the bond
   transfer; show the trust ladder before signing (*where the keys live, before the
   click*).
2. **Operator tooling** (team-side script) — per epoch: escrow, pre-sign, publish,
   delete key, attest.
3. **Epoch page on the indexer** — bonds, unlock heights, escrow status
   (`signed` → `key deleted` → `paid` | `rugged`), per-source revenue accounting,
   volatility-freeze banner.
4. **Unlock flow** — script-path spend after maturity (the codebase's first
   script-path spend; deliberately exercised here before Lightning-corridor and loan
   products need it).
5. **Shared transaction template library** — envelope construction, positional amount
   pairing, marker pinning, client-side verification before every signature. This
   library is the pilot's main reusable asset.

Out of scope for M0: pooled/custodial tier, MuSig2/FROST, variable-rate markets,
mainnet deployment, any "APY" marketing.

Success criteria: N external testers complete lock → payout → unlock on testnet with
zero funds lost; zero consensus-rejected transactions produced by the template
library; one epoch survives an operator-disappearance drill (payout broadcast by a
staker); one simulated freeze window handled with correct UI state; UX review confirms
users can restate the trust ladder in their own words.

## 8. Known limitations

- **No early exit.** Consensus-enforced. If you need your DD mid-epoch, do not lock it.
- **Freeze can delay settlement and unlock.** A ≥30%/24h volatility event halts all DD
  transactions for an unbounded window; funds are delayed, never lost.
- **Small stakes accrue instead of paying.** Shares under $1.00 carry to the next
  epoch (consensus minimum output).
- **The carry is an unescrowed liability** until it crosses $1 — it sits outside the
  trustless floor and is disclosed as such. (This distinction was discovered by the
  prototype: an early design escrowed the headline pool while owing floor + carry,
  silently under-funding its own distribution.)
- **Floor requires diligence at epoch start:** stakers (or the wallet on their behalf)
  verify the escrow UTXO and their payout in the signed chunks *before* locking.

## 9. Relationship to the DigiDollar roadmap

The DigiDollar whitepaper and Implementation Spec v5 (DigiByte-Core discussions #319,
#324) name yield and lending as intended directions while explicitly deferring them
out of protocol v1. This product adds yield **above** the protocol without touching
consensus, and is designed to be superseded cleanly if a future soft fork ships
protocol-native distribution.

## 10. References

- DigiByte Core v9.26.x source: `src/digidollar/validation.cpp`,
  `src/digidollar/scripts.cpp`, `src/consensus/volatility.h`,
  `src/policy/policy.h`, `src/script/interpreter.cpp`, `src/primitives/oracle.h`.
- Diginaut research: *DeFi & yield for DigiDollar without touching DGB consensus*
  (`docs/discovery/dd-defi-yield.md`) — 20 verified designs, consensus + economics
  verdicts.
- Interactive state-model prototype: `prototypes/lock-earn/` (pure reducer +
  terminal UI; the mechanism in this paper is the prototype's validated model).

---

*Diginaut · dgb.ludere.space (testnet) · diginaut.ludere.space (mainnet) — this
document describes a pilot; nothing in it is investment advice or an offer of a
financial product.*
