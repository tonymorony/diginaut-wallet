# Design system

Verified: 2026-07-31 @ branch `feat/diginaut-space-domain` (#138, the copy pass, the
sprite-coverage sweep, then the diginaut.space domain switch).

Visual + copy conventions shared by every surface. Behavioural facts about a specific screen
live in `wallet-app.md`; this page is only "how it should look and read".

## Two tiers, never mixed

| Tier | What | Where | Authored how |
|---|---|---|---|
| 1 · functional | line icons, `currentColor` | inside any control, row, badge, status, cell | hand-authored SVG in the sprite |
| 2 · emotional | raster illustration (the astronaut) | guest hero, empty states, success beats, eviction/locked screens | image-to-image off `hero-art.png` |

A tier-2 render must never be a button icon; a tier-1 line icon must never be a hero. Tier 2
is the only place generated imagery belongs — a diffusion model cannot produce tintable,
stroke-consistent vectors, and character identity only survives reference-conditioned edits.

**The placement column says where an icon MAY go, not where one must.** Uniform coverage is the
failure mode: the sweep that closed the sprite's gaps rejected ~3/4 of its own candidates. A
mark earns its place only by doing work the label cannot — disambiguating look-alike rows,
encoding a state (pending / not-backed-up / stale), marking an undoable commit point, anchoring
a repeating row, or closing an asymmetry where the app already draws that state with that mark.
A confirm/cancel pair in an already-titled modal does not qualify, nor does a plain, fully
labelled secondary button. If you have to argue for it, the answer is no.

`asset-dgb.png` / `asset-dd.png` are the one exception to "tier 2 is emotional beats only":
**asset-identity marks**, rendered inside `.asset` rows (tier-1 territory). Like brand marks,
they are not authorable on the sprite's contract. Not licence for any other raster in a control.

## Icon sprite — rules

- `#ic-sprite` in `index.html` `<body>` holds every `<symbol>`; markup uses
  `<svg class="ic"><use href="#ic-NAME"/></svg>`, `app.js` uses `icon(name, cls)` beside
  `esc()`. Add a symbol; never inline a path at a call site.
- 24×24 grid, stroke 1.75, round cap/join, `fill:none`, **`currentColor` only**. `.ic` 20px,
  `.ic-s` 16px, `.ic-l` 24px, `.ic-xl` 44px (success beats; carries `margin-inline:auto`,
  because `.ic` is `display:block` and the beats centre with `text-align`) — stroke
  renormalised per size so optical weight stays flat.
- **A symbol carries no presentation attributes** — no `stroke-width`, no `stroke`, no `fill`.
  Weight comes from the size class, so a value baked onto the symbol follows the shape into
  every context it renders in and cannot be overridden by the component owning the slot.
  `icon-sprite.test.js` fails the build on any of the three, on the `<symbol>` tag **and** in
  its body — the first cut scanned only the body, which is the same hole the bug came through.
  When a shape genuinely cannot follow the ladder it opts out by **class**: `ic-more` is three
  dots whose stroke *is* their diameter, so it carries `.ic.ic-dots` at both call sites.
  **The selector list is not decoration and is not complete by construction.** `.ic.ic-dots` is
  (0,2,0) and so is `.tx-icon .ic` — a tie that source order settles for the component, so the
  rule is written `.ic.ic-dots, .tx-icon .ic.ic-dots`. Without the second selector the history
  row renders its dots at 2.1, i.e. the one call site the class exists for silently keeps the
  bug. Any future component that sizes its own `.ic` **and** hosts `ic-more` must be added to
  that list; there is no cascade trick that covers them all, and no test catches the omission.
  (It shipped with `stroke-width="2.6"` baked on the path until the coverage sweep; that
  silently outranked every size class, which is the failure this rule names.)
- **A component may size its own mark; a call site may not.** `.tx-icon .ic` 15px/2.1,
  `.tx-conf .ic` and `.wal-dot .ic` 12px/2.4, `.rx-row .rx-tag .ic` 11px/2.4, `.w3-step .n .ic`
  12px/2.6 are legitimate — a component fitting a mark to a 26px circle or a 20px pip.
  Deliberately NOT consolidated into an `.ic-xs`: the rule is about call sites, not components.
- **`.ic { pointer-events: none }` is load-bearing, not polish.** An icon is `aria-hidden`
  decoration and must never be able to become `e.target`. Without it, a click on the glyph
  inside `#w-erase-go` / `#w-remove-go` makes `busy(e.target, …)` set `.disabled` on the SVG —
  a no-op expando — and the re-entrancy guard in front of `keystore.deleteAllRecords()` /
  `vault.removeWallet()` silently disappears. **CI cannot see this:** `scripts/lib/cdp.mjs`
  clicks with `getElementById(id).click()`, so `e.target` is always the button and every driver
  stays green. Both handlers now pass the element explicitly as a second belt.
- `icon()` strips both args to `[a-z0-9- ]`, so it cannot become an injection sink even if a
  future caller threads a brand name or indexer field through it. Multi-class is fine
  (`icon('more', 'ic-s ic-dots')`) — the strip permits spaces.
- **No text glyphs.** `↑ ↓ ◆ ✓ ✕ ⋯ · ⇄` are gone — the last two fell in the coverage sweep
  (`⇄ USD` on `#w-send-ccy`, and the `·` that stood in for an empty backup-quiz slot). They
  shifted the baseline, changed shape with the platform font, and could not be tinted apart
  from their label. **A glyph is not always replaced by an icon:** the quiz placeholder became a
  CSS rule (`.quiz-slot:not(.filled) .mono::after`), because emptiness was already stated by the
  slot's dashed border and the `·` was really only holding the line height — which
  `.quiz-slot .mono { min-height }` now does. Delete, substitute, or restyle; pick per case.
- **`apps/wallet/test/icon-sprite.test.js` is the guard.** Nothing else greps for `ic-`: a
  missing symbol renders an empty box, no console error, green through every driver (an `<svg>`
  is not in `textContent`). It asserts references ⊆ symbols, the 24×24 grid, the
  no-presentation-attribute rule, and pins the unused-symbol inventory (15). Scans
  comment-stripped sources — the call-shape examples in the markup would otherwise fail it.
- **An icon is an `<svg>`, so it is NOT in `textContent`.** The confirmation badge reads
  `final`, not `✓ final` (`verify-balance`, `verify-send` match the bare word). A driver
  asserting a glyph fails by *timing out*, not by asserting.
- **Inline `style.display` beats the stylesheet.** `#w-backup-badge` is `inline-flex` in CSS,
  but `renderBackupCta()` writes `style.display` — so that write says `'inline-flex'`. Same
  trap for anything else JS shows that now holds an icon.
- `#w-modal-close` keeps its id **and** its `style.display` toggle (`''` resets to `.xbtn`'s
  `display:grid`): `renderBackupSkipGate()` hides it to seal a mandatory ceremony, and
  `verify-beta-posture` / `verify-mainnet-live` / `verify-mainnet-bringup` assert exactly that.
- Brand marks are **not** in the sprite, first-party ones included. Third-party marks
  (MetaMask/Phantom/OKX) arrive as `data:` URIs on the extension's own EIP-6963 announcement,
  admitted only if `/^data:image\//`; the footer's GitHub octocat is inlined at its call site
  because a fixed filled logo cannot be authored on the 24×24 / stroke-1.75 / `fill:none`
  contract without ceasing to be that logo. Both are marks of an *identity*, not of an action —
  that is the line. A **monogram** stand-in for an unnamed extension is fine for the same
  reason; the literal `?` that used to fill that slot when even the brand string was missing was
  not, and is now `ic-puzzle`, matching the no-extensions row beside it.
- Raster illustration (`hero-art.png`) is a **separate tier**: emotional beats only. Never a 3D
  render inside a control, never a line icon as a hero. `asset-*.png` is the carve-out — see
  § Two tiers.

## Mobile header (≤600px)

The topbar is the tightest row in the app: at 430px it has **398px** and the guest corner wants
**498**. Three rules buy the single row, and they are a set — read the reasons before touching one.

- `.corner { flex: 1 1 auto }`. Without it the corner box is only as wide as its contents, so
  `justify-content: flex-end` does nothing once `.topbar` wraps and the controls jump to the
  **left** edge of their own line. This one is a plain bug fix and applies at every width.
- `#net-btn` drops `.nb-label` and becomes globe + status dot (117px → 52px). Legal because it
  carries `aria-label` **and** `title` — the icon-only contract. The dot always did the work.
- `.net-pill { display: none }`. **This one is a risk-surface decision, not layout polish.**
  It is only defensible because `.net-banner` states the same network, full width, at the same
  colour level, and is `position: sticky` — so it survives the scroll that the pill's
  `.floating` class exists to survive. On mainnet that banner is the red *MAINNET BETA — real
  funds at risk* line, louder than the pill it stands in for. **If the banner is ever made
  dismissible or non-sticky, this rule must go with it.**
- `body.has-backup-strip #w-backup-badge { display: none !important }`. The unlocked
  not-backed-up corner wants **450**. The strip's condition is a strict **subset** of the
  badge's (both need `!backedUp`; the strip also needs funds-or-evictable and not-dismissed), so
  while the strip is up the badge is *duplication*, not signal — same fact, stated in full with
  a CTA directly below. `renderBackupStrip()` mirrors its rendered `nag` onto `<body>`, and it
  must stay the **rendered** state: dismissing the strip brings the badge back, because then it
  is the only surface left saying it. `!important` because `renderBackupCta()` writes
  `style.display` inline. Dismissed → the header is 2 rows again, and that is correct.
- `#modeBadge.real { display: none }` (83px) — **LIVE NODE only.** The first cut of this rule
  hid the badge in every state on the reasoning that "MOCK MODE is dev-only, it cannot reach a
  deployment". That is false, and the correction is the load-bearing fact here: `server.js`
  decides `mockMode = !config.rpc.user || !config.rpc.pass`, so **one unset env var on a
  redeploy** serves synthetic balances and fabricated txids, with no boot refusal (contrast
  `vendor.lock`, which `bootStuck`s). Mock also skips `startChainGuard()`, so `chainMismatch`
  stays false forever and **CROSS-WIRED can never fire in mock** — the partner that would have
  covered it is structurally unreachable in exactly the state that needs it. Mock reports chain
  `test`, painting the ordinary amber TESTNET banner, and `#net-modal` has no row naming the
  data source. So `#modeBadge` is the *only* surface separating synthetic data from a live node,
  and it stays. `applyConfigChrome` writes `badge real` for LIVE NODE alone; MOCK MODE,
  CROSS-WIRED and the static `loading…` all carry `badge mock`, which makes `.real` an exact
  split. `textContent` is untouched either way, so the two strict-equality driver assertions on
  it are unaffected.
- **Known limit, measured:** the header is one row from **~494px** *on a deployment* (LIVE NODE,
  badge hidden). Under MOCK MODE or CROSS-WIRED the badge is back and costs that row — correct
  by construction: the warning outranks the layout, and the clean header is what production
  gets. Below ~494 — 390/414/430 —
  the unlocked corner still wraps, because the address chip alone is 258px and logo + chip +
  globe + gaps is 447 against 398. Getting iPhone widths to one row means cutting the address
  *tail* (the only part that distinguishes wallets — every testnet taproot address starts
  `dgbt1p`) or the Disconnect label (**the app's only manual lock** — `lockWallet()` has no
  other caller but the autolock timer). Both were rejected; two right-aligned rows is the
  correct answer down there.
- The legacy-host "we've moved" strip (`#w-move-note`, ADR-0006) costs the header **nothing**:
  it is in normal flow below `.backup-strip`, so it cannot overlap the sticky `.net-banner` or
  crowd the topbar. It reuses the backup strip's geometry with an **informational** tone
  (`--accent-5`) — deliberately neither amber nor red, since both warning levels are already
  spoken for (amber = testnet/backup, red = mainnet beta) and a domain change is news, not risk.
- **Nothing here is guarded by CI, twice over:** `verify-beta-posture` reads the `.hidden`
  *property* (`!net-pill.hidden`), which a CSS `display:none` never sets, and the drivers run at
  desktop width where these rules do not apply. Check mobile by hand.

## UX copy

Reviewed by the `ux-writer` agent (`.claude/agents/ux-writer.md`) on any PR that touches a
string a user reads — see `agent-workflow.md` § PR workflow step 2b.

- **A label must describe what its handler does.** This outranks tone, length and jargon.
  Copy that names a different security model than the code implements is a defect.
  Precedent (#138 feedback): the guest CTA read **"Connect wallet"**, the EVM phrase for
  *grant this site access to a wallet that already holds your funds* — while Diginaut's
  default path grants nothing and generates a keypair in the browser. A DGB holder read it as
  the EVM gesture, left the site, and read the source before returning. **Fixed:** the CTA is
  now a three-state tuple (*Create or restore a wallet* / *Restore a wallet* / *Unlock*) —
  `wallet-app.md` § Connect modal. Mirror defect, still open: `Disconnect` calls
  `lockWallet()`, making a safe reversible lock sound like a severing.
- **A destructive button is labelled by its consequence, even next to identical-looking
  siblings.** The recovery card's *Dismiss* deleted the signed hex of a possibly-in-flight
  transaction; it now says *Delete saved transaction* on a live row and keeps *Dismiss* only
  on a resolved one, where nothing is destroyed.
- **Borrowed chain jargon must mean here what it means out there.** `#w-recovery`'s heading
  was *Unconfirmed broadcast*; to a BTC/LTC/DGB holder "unconfirmed" means broadcast and
  waiting for a block — routine — while the card exists because we don't know it was
  broadcast at all. Now *Broadcast not acknowledged*. `app.js`'s ambiguous-broadcast error
  names that panel in prose: **retitle both together.**
- **A qualifier can be the whole truth.** The mainnet banner said "no backup" while the app
  ships a mandatory seed ceremony *and* an encrypted file export — on the only chain with real
  funds, that read as *backups do not exist*. It says "no backup on our servers" (testnet
  already qualified it). Say what is absent, not that nothing exists.
- **Keep an accurate jargon term in the one place it is accurate.** "Connect" is correct on
  the web3 sign-to-derive door and nowhere else; using it only there teaches the distinction.
- **A string that quotes a load-bearing value must be GENERATED from that value.** The
  sign-to-derive checkbox — *"I understand: only **{host}** may ever ask for this signature.
  Any other site asking for it is stealing my funds."* — hardcoded `dgb.ludere.space`, so the
  **mainnet** ceremony named the **testnet** domain, next to a signing popup whose own last
  line said the opposite. The host is now `#w-web3-origin`, written by `armWeb3Disclosure()`
  from `s2dOriginHost()` of the exact frozen message being signed, and it changes per network
  **and** per origin era (ADR-0006: v1/v2 on the `ludere.space` hosts, v3/v4 elsewhere).
  **What the drivers pin is the HOST, not the sentence:** `verify-connect-derive` and
  `verify-web3-mainnet` both compare `#w-web3-origin`'s `textContent` against
  `s2dOriginHost()`, so re-wording *"I understand: only … may ever ask for this signature"*
  turns nothing red. Keeping the sentence in step is convention, enforced by review — and
  never put a literal host back, because that half *is* enforced.
- **Load-bearing strings** (never reword alone; full table in `.claude/agents/ux-writer.md`):
  the four `S2D_MESSAGE*` bodies in `connect.js` (**consensus-grade** — a diff re-derives every
  user's wallet), the proxy refusals `broadcastlog.js` string-matches, a node's raw reject text,
  and the driver-asserted picker strings. The ux-writer table still lists only v1 — read it as
  covering all four.
- **A word that already means something here cannot be reused loosely.** The legacy-host move
  notice opened *"Diginaut has a new address"* — in a UI where **address** is a DGB receiving
  address ("Copy address", "Sender can't pay this address?"), rendered a row above the header's
  address chip. It says *new home* / *new site* now. Same fix for *recovery phrase* → **seed
  phrase**: every other string in the app says seed phrase, so the notice named an artifact the
  user cannot find, and the restore paths are *seed phrase **or** encrypted backup file* (the
  `hero-recovery` line is the phrasing to copy).
- **A surface outside `show()` must read true in every vault state.** `#w-move-note` renders on
  boot from the hostname alone — no wallet check — so it is seen by first-time visitors too. Copy
  it in the *"a wallet created here stays here"* impersonal form; "your wallet" over an empty
  browser is the same class of bug as a state-inaccurate modal title.
- **Name the consequence, not the mechanism** — "New 24-word seed phrase, you'll write it down
  next" over "Create new wallet". Exception: when the mechanism is the *reason* a limit is not
  ours to lift, give it — the move notice says wallets stay put "because your browser stores
  wallets per site", or the user reads origin scoping as a policy we could waive.
- **Never soften a risk to reduce friction.** The backup ceremony, mainnet interstitial,
  $500 cap and eviction warning are allowed to be blunt.
- **A settlement word needs every source it claims to summarise.** The Activity badge says
  `final` only when the node's confirmation count is ≥ `FINAL_CONF` **and** the address index
  also carries a height for that tx. The two are separate subsystems and the index is
  untrusted (#55), so finality on one signal alone would let a lying index name a settled
  state the chain has not reached — a defect, not a rounding. Below that the count itself
  (`N conf`) is the honest answer, and a count of 0 is `pending` whatever the index says.
  Mechanism: `wallet-app.md` § Client state.
- **Say where the keys live before the click,** not only after it.
- Sentence case, no exclamation marks, no apologies in errors. `CONTEXT.md` glossary terms are
  binding, including their banned synonyms.
