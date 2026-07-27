# Diginaut wallet — agent entry point

Non-custodial browser wallet for DigiByte's DigiDollar stablecoin. Monorepo:
`packages/digidollar-js` (pure protocol lib) + `apps/wallet` + `apps/indexer` + `apps/faucet`.
Live: <https://dgb.ludere.space> (testnet) and <https://diginaut.ludere.space> (mainnet).

## Context protocol — read this first

An **LLM-wiki** lives at `docs/llm-wiki/`. It exists so agents do NOT re-explore the repo or
re-derive hard-won facts every session.

1. Read `docs/llm-wiki/INDEX.md` (~1 min) and load **only** the pages the routing table says
   match your task. Do not bulk-read the whole wiki.
2. Trust wiki facts over re-exploration, but each page carries a `Verified:` stamp — if the
   stamp predates recent commits touching that area, spot-check before relying on it.
3. **Write back:** if your change invalidates a wiki fact (command, invariant, file moved,
   baseline count), update the affected page in the same branch/PR. If you learn a new
   expensive fact (a consensus behavior read from Core, a driver gotcha that cost an hour),
   add it to the matching page — one terse bullet, with source.
4. Keep pages terse: facts, paths, commands. No narrative. A page over ~150 lines should be
   split or pruned. Point to canonical docs (`CONTEXT.md`, `docs/adr/`, `docs/discovery/`)
   instead of duplicating them.

## Hard rules (full list: `docs/llm-wiki/agent-workflow.md`)

- **User merges PRs.** Workflow: branch → PR → spawn reviewer agent (verdict as PR comment) →
  stop. Never self-merge; never commit/push unasked.
- **Conventional Commits.** Every commit subject is `type(scope): summary` — types `feat`,
  `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`; scope optional
  (`wallet`, `indexer`, `faucet`, `digidollar-js`, `wiki`, `deploy`). Imperative mood, no
  trailing period, subject ≤ 72 chars; put the *why* in the body. Breaking changes take a `!`
  before the colon and a `BREAKING CHANGE:` body footer. History before 2026-07-27 predates
  this rule — don't rewrite it, and don't copy its style.
- **Model routing:** Fable 5 plans, researches, and pathfinds; coding, code review, and
  security review go to **Opus 5 subagents** (`model: "opus"` when spawning). Details:
  `docs/llm-wiki/agent-workflow.md` § Model routing.
- **Copy is reviewed like code.** A PR that adds or changes any string a user reads also gets
  a `ux-writer` pass (`.claude/agents/ux-writer.md`), alongside the code review. A label that
  names a different security model than the code implements is a **defect**, not a style note
  — "Connect wallet" over a wallet this app *generates*, "Disconnect" over a plain lock.
  Conventions and load-bearing strings: `docs/llm-wiki/design-system.md`.
- **Wiki write-back is part of every task, not optional.** Before opening a PR (or ending a
  session that produced findings), run the wiki checklist in
  `docs/llm-wiki/agent-workflow.md` and include the wiki edits in the same branch/PR.
  A PR that changes behavior but touches no wiki page must say why in its description.
- Never weaken: RPC `ALLOWED_METHODS` allow-list, `vendor.lock` boot check, `netKnown` gating,
  ADR-0002 (mint never ships without redeem+transfer).
- Use the exact domain terms from `CONTEXT.md` (glossary with per-term "avoid" lists).
- Secrets (server creds, seed phrases) never enter the repo — including this wiki.
- Root `HANDOFF.md` is **stale** (2026-07-10); current state lives in
  `docs/llm-wiki/project-status.md` + the tracker.
