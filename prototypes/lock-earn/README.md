# PROTOTYPE — throwaway code

Not production. No tests, no persistence, no error handling beyond "it runs". Delete it once
the question is answered; the only part worth keeping is `logic.js`.

## The question

Can a self-custodial **"lock and earn"** product for DigiDollar work with **zero DigiByte
consensus changes** — and where exactly does trust enter? The mechanism under test is "DD Lock
& Earn", commitment tier, one epoch at a time: a staker locks their own DD into a **bond** (a
DD transfer paying a taproot output whose internal key is the BIP-341 NUMS point, so there is
no key-path bypass, and whose single tapscript leaf is
`<unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <stakerXOnlyKey> OP_CHECKSIG` — only the staker
can ever spend it, and only after the epoch ends); the operator escrows a **floor reward pool**
at epoch start under an *ephemeral* key and pre-signs the pro-rata distribution with
`SIGHASH_ALL|ANYONECANPAY` and `nLockTime = epoch end`, so any staker can add a fee input and
broadcast it; and a **variable top-up** above the floor is paid from operator revenue at epoch
close. The prototype exists to find the exact places where "self-custodial" stops being true,
and to make every consensus rejection visible rather than argued about.

## Run it

```
npm run proto:lock-earn
```

Single keystrokes drive it. Piped input works too (each character is one keystroke), which is
how it was smoke-tested:

```
printf '123trrrekTTTTTTTbuq' | node prototypes/lock-earn/tui.js
```

**Happy path key sequence:** `1 2 3 t r r r e k T T T T T T T b u q` — three stakers lock,
one block confirms them, three Mint-to-Order premiums fund the operator, the floor pool is
escrowed and pre-signed, the ephemeral key is deleted (the floor goes trustless), seventy
blocks pass the epoch end, a staker broadcasts the distribution, everyone unlocks their bond.

Other keys: `g` rug the escrow, `p` variable top-up, `x` early-unlock probe, `f` volatility
freeze, `v` operator vanishes, `n` next epoch.

## Consensus rules the model encodes

All verified against DigiByte Core source by prior research (`docs/discovery/dd-defi-yield.md`,
`docs/llm-wiki/consensus-facts.md`); line refs are v9.26.2-2 ≈ v9.26.4.

| Rule | Source | How the model encodes it |
|---|---|---|
| Every DD output in a transfer must be ≥ $1 (100 cents) | `digidollar/validation.cpp:1756` | A staker whose pro-rata share is under $1 gets **no payout output at all** — the share becomes `carry` and rolls to the next epoch. Carol is seeded at $40 precisely to trigger this at a 1.5%/epoch floor. |
| The DD OP_RETURN envelope rides the 83-byte relay cap, no DD exemption | `policy.h:74` | Payouts are chunked at `MAX_PAYOUTS_PER_TX = 8`; every chunk's envelope is built for real and asserted ≤ 83 bytes. More stakers ⇒ more pre-signed chunk txs. |
| DD inputs must be **confirmed** (no DD mempool chains) | `digidollar/validation.cpp:1810-1813` | A lock tx is `pending` until the next block tick, then `active`. Only `active` stakes count toward the floor pool. |
| Volatility freeze: a ≥30%/24h oracle move freezes **all** DD transactions | `consensus/volatility.h:66` | While frozen, *every* broadcast is rejected — locks, unlocks, distribution, top-up. |
| Freeze duration is unbounded (the ~36h cooldown is a floor, not a ceiling) | `consensus/volatility.cpp:314-320` | The freeze is a manual toggle with no timer. `nLockTime` txs don't expire, so the delayed distribution still pays after unfreeze — press `f b f b` to watch it. |
| CLTV bond, NUMS internal key | BIP-341 + `digidollar/scripts.cpp` NUMS pattern | `x` always fails below `unlockHeight` with the real reason: script-path CLTV, and no key path exists. |
| `nLockTime` on the pre-signed distribution | standard finality | `b` fails while `height < nLockTime`. |

Not simulated, worth stating: **the taproot sighash commits `nVersion` under every hash type**,
so a pre-signed template pins the `0x0770` DD marker. That closes the silent-burn hazard
(`digidollar/validation.cpp:800-805`, where an unmarked tx spending a DD UTXO is valid and
destroys the DD) for every pre-signed tx in this design — the distribution chunks cannot be
mutated into a burn.

## Byte-real artifacts

The prototype refuses to hand-wave the transactions:

- `nVersion` comes from `buildDDVersion('transfer')` → `0x02000770`.
- Every OP_RETURN envelope comes from `buildTransferMetadata({ amountsCents })` in
  `packages/digidollar-js/src/envelope.js` — byte-exact vs Core's encoding. The TUI shows the
  real hex, dim and truncated (e.g. `6a024444010202770102220b` = a 2-payout chunk of $3.75 and
  $28.50).
- Bond leaf scripts are built as raw bytes: minimal-LE `CScriptNum` push of `unlockHeight`,
  `0xb1` OP_CLTV, `0x75` OP_DROP, `0x20` + 32-byte key, `0xac` OP_CHECKSIG — 39 bytes.
- The bond's taproot output key is **real** BIP-341 math, replicated in `logic.js` from
  `packages/digidollar-js/src/taproot.js`: single-leaf tree, so `merkleRoot = tapLeafHash(leaf)`,
  then `lift_x(COLLATERAL_NUMS_KEY) + H_TapTweak(NUMS ‖ root)·G`. The fixed **fake** staker keys
  never break this, because they are only pushed into the leaf as bytes — the point that gets
  lifted is the NUMS key, which is a genuine curve point. So both the leaf hex and the output
  key are real; only the staker keys are fake.

Two honesty notes:

1. This bond output is a NUMS + script-path tapscript tree, which is **not** what Core's own
   builder produces for a DD token output (that's a key-path-only owner key,
   `CreateDigiDollarP2TR`). It is nonetheless consensus-legal: DD transfer validation never
   reconstructs or constrains a DD output key — `IsCanonicalP2TROutput` checks witness version
   and size only (`digidollar/validation.cpp:61-68, 2792-2817`), and script-path spending is a
   permissive stub (`validation.cpp:2626-2639`). That permissiveness is the entire reason this
   product needs no consensus change.
2. `MAX_PAYOUTS_PER_TX = 8` is a conservative product cap, not the byte limit. Measured against
   the real envelope builder, 83 bytes actually admits **15** max-size ($100k) outputs, 25
   typical ones, 38 minimum ($1) ones. Eight leaves headroom for future envelope fields.

## What pushing the model shows

- **The bond half genuinely needs zero trust and zero consensus change.** Every path that
  should be impossible is impossible for a reason the model can name: `x` fails with
  "script-path CLTV: height H < unlockHeight U; no key path exists (NUMS)", and even a rug or a
  vanished operator leaves the bonds untouched. Nothing in the lock leg depends on the operator
  existing.
- **The escrow key deletion is the whole trust boundary, and it is binary.** Before `k`, `g`
  succeeds and the floor evaporates. After `k`, `g` fails with "the operator holds NO signature
  that spends this escrow". There is no middle state — which also means the product's honest
  claim changes the instant that key is deleted, and *only* then. The residual is
  statechain-class and unprovable ("did they really delete it"), but a rug is at least publicly
  visible on-chain forever.
- **A vanished operator is survivable by design, and the prototype proves it in one keystroke.**
  Press `v` then `b`: "floor distribution PAID $32.25 — with the operator still vanished."
  ANYONECANPAY means any staker funds the fee and broadcasts. Press `p` instead and the top-up
  is rejected as what it actually is: a promise, not a signature.
- **The $1 minimum output silently creates a class of stakers who cannot be paid on-chain, and
  the carry is an *unescrowed* liability.** Carol's $40 at 1.5% is $0.60 — no output can exist
  for it, so it is not escrowed either. The trustless floor covers only what is payable *now*;
  the carry is back to being a promise until an epoch where share + carry clears $1 (it does in
  epoch 2 — carol receives $1.29). Building this without noticing would have produced an escrow
  that under-funds its own pre-signed distribution.
- **In a freeze, every leg goes dark at once — but nothing expires.** `f` blocks locks,
  unlocks, distribution, and top-up simultaneously, including bonds that have already matured:
  a staker past `unlockHeight` is still stuck, because spending the bond is itself a DD
  transfer. Unfreeze and the same pre-signed distribution confirms unchanged, because
  `nLockTime` txs never expire. Freeze duration is unbounded, so "you can always exit at
  maturity" is not a claim this product can make.
- **The trust ladder the TUI prints at the top is the honest marketing copy, in order:**
  bond = consensus-enforced; floor = trustless *only after* key-delete; top-up = promise. Each
  rung is a different security model, and the prototype makes each one falsifiable by pressing
  a key.
