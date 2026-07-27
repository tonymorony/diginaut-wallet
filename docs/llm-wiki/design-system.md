# Design system

Verified: 2026-07-27 @ branch `design/icon-system-and-connect-modal` (#138).

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

## Icon sprite

## Rules

- `#ic-sprite` in `index.html` `<body>` holds every `<symbol>`; markup uses
  `<svg class="ic"><use href="#ic-NAME"/></svg>`, `app.js` uses `icon(name, cls)` beside
  `esc()`. Add a symbol; never inline a path at a call site.
- 24×24 grid, stroke 1.75, round cap/join, `fill:none`, **`currentColor` only**. `.ic` 20px,
  `.ic-s` 16px, `.ic-l` 24px — stroke renormalised per size so optical weight stays flat.
- `icon()` strips both args to `[a-z0-9- ]`, so it cannot become an injection sink even if a
  future caller threads a brand name or indexer field through it.
- **No text glyphs.** `↑ ↓ ◆ ✓ ✕ ⋯ ·` are gone. They shifted the baseline, changed shape with
  the platform font, and could not be tinted apart from their label.
- **An icon is an `<svg>`, so it is NOT in `textContent`.** The confirmation badge reads
  `final`, not `✓ final` (`verify-balance`, `verify-send` match the bare word). A driver
  asserting a glyph fails by *timing out*, not by asserting.
- **Inline `style.display` beats the stylesheet.** `#w-backup-badge` is `inline-flex` in CSS,
  but `renderBackupCta()` writes `style.display` — so that write says `'inline-flex'`. Same
  trap for anything else JS shows that now holds an icon.
- `#w-modal-close` keeps its id **and** its `style.display` toggle (`''` resets to `.xbtn`'s
  `display:grid`): `renderBackupSkipGate()` hides it to seal a mandatory ceremony, and
  `verify-beta-posture` / `verify-mainnet-live` / `verify-mainnet-bringup` assert exactly that.
- Brand marks (MetaMask/Phantom/OKX) are **not** in the sprite — they arrive as `data:` URIs on
  the extension's own EIP-6963 announcement, admitted only if `/^data:image\//`.
- Raster illustration (`hero-art.png`, `asset-*.png`) is a **separate tier**: emotional beats
  only. Never a 3D render inside a control, never a line icon as a hero.

## UX copy

Reviewed by the `ux-writer` agent (`.claude/agents/ux-writer.md`) on any PR that touches a
string a user reads — see `agent-workflow.md` § PR workflow step 2b.

- **A label must describe what its handler does.** This outranks tone, length and jargon.
  Copy that names a different security model than the code implements is a defect.
  Precedent (#138 feedback): the guest CTA read **"Connect wallet"**, the EVM phrase for
  *grant this site access to a wallet that already holds your funds* — while Diginaut's
  default path grants nothing and generates a keypair in the browser. A DGB holder read it as
  the EVM gesture, left the site, and read the source before returning. Mirror defect:
  `Disconnect` calls `lockWallet()`, making a safe reversible lock sound like a severing.
- **Keep an accurate jargon term in the one place it is accurate.** "Connect" is correct on
  the web3 sign-to-derive door and nowhere else; using it only there teaches the distinction.
- **Name the consequence, not the mechanism** — "New 24-word seed phrase, you'll write it down
  next" over "Create new wallet".
- **Never soften a risk to reduce friction.** The backup ceremony, mainnet interstitial,
  $500 cap and eviction warning are allowed to be blunt.
- **Say where the keys live before the click,** not only after it.
- Sentence case, no exclamation marks, no apologies in errors. `CONTEXT.md` glossary terms are
  binding, including their banned synonyms.
