# Agent workflow & process lessons

Verified: 2026-07-26. Repo: <https://github.com/tonymorony/diginaut-wallet>
(old `digidollar-wallet` URL redirects; a remote pointing at the old URL pushes fine, but an
already-open PR may silently not pick up new commits — check the PR actually updated).

## PR workflow

1. Branch (`build/…`, `fix/…`, `ops/…`, `discovery/…`) → implement → **wiki write-back**
   (checklist below, edits committed on the same branch) → push → `gh pr create`.
2. Spawn a Code Reviewer agent for a genuine review; post the verdict (FIX-FIRST / SHIP) as a
   PR comment. Reviewers: treat a behavior-changing PR with no wiki delta and no stated
   reason as a FIX-FIRST item.
2b. **Touched a user-facing string? Also spawn `ux-writer`** (`.claude/agents/ux-writer.md`,
   Opus) — in parallel with the code review, they answer different questions. Its first test
   is not tone but truth: does the label describe what the handler does? Load-bearing strings
   that must never be reworded alone (`S2D_MESSAGE`, the proxy refusals `broadcastlog.js`
   string-matches, a node's raw reject text) are tabulated in the agent definition.
3. **Stop. The user merges.** Agent self-merge is classifier-blocked in auto mode (direct and
   via spawned reviewer).
4. Never `--delete-branch` on a stacked PR's base (dependents get closed unrecoverably).
   `gh pr edit --base` fails silently → use `gh api repos/…/pulls/N -X PATCH -f base=…`.

## Model routing (Fable 5 vs Opus 5)

Split work by phase: **Fable 5 thinks, Opus 5 agents execute.**

- **Fable 5** (the main session) keeps: initial planning, pathfinding/wayfinder maps, deep
  research & discovery docs, grillings/design stress-tests, architecture decisions (ADRs),
  and synthesis/verdicts over subagent results.
- **Opus 5 subagents** for execution: implementation/coding, code review, security review,
  test/driver authoring, mechanical migrations, doc formatting. Mechanics: pass
  `model: "opus"` when spawning via the Agent tool, or `opts.model: 'opus'` per `agent()`
  call in Workflow scripts. (The main-loop model itself is user-controlled via `/model` —
  don't try to switch it; route through subagents.)
- Don't downgrade the judgment steps: the reviewer verdict a Fable session posts should be
  based on an Opus review it has **read and synthesized**, not rubber-stamped.

## Wiki write-back checklist (run before every PR / end of a findings session)

- [ ] **Invalidated facts** — did the change move a file, rename a symbol, alter a command,
      endpoint, port, env var, invariant, or baseline that a wiki page states? Fix the page.
- [ ] **New expensive facts** — anything learned that a future agent would otherwise
      re-derive (consensus behavior read from Core, a gotcha that cost >15 min, a proven
      recipe)? One terse bullet on the matching page, with source.
- [ ] **New test/driver** — added a `verify-*` driver or suite? Add it to the catalog in
      `testing-and-drivers.md` (name + what it guards).
- [ ] **Decision made** — architecture-level → new ADR + one line in `architecture.md`'s
      digest; process-level → `agent-workflow.md`.
- [ ] **Status** — update `project-status.md` (frontier, loose ends) and refresh the
      `Verified:` stamp of every page you touched. Don't restamp pages you didn't verify.
- [ ] **Nothing to update?** Legitimate for pure-mechanical changes — but say so explicitly
      in the PR description ("wiki: no facts changed").
- Scope guard: wiki edits stay terse (facts, paths, commands); never paste secrets, seeds,
  server credentials, or large code blocks.

## CI (`.github/workflows/ci.yml`, since #115)

- Runs unit suites + the registered browser drivers (both the SELF_CONTAINED and
  NEEDS_STACK sets) via `scripts/run-drivers.sh`; `check-pins.mjs`
  enforces exact dep pins; a committed-vendor.lock-vs-tree test catches dep bumps that skip
  the regen.
- `verify-wallet-switch` was the CI flake; **fixed 2026-07-27** (it asserted `w-address ===`
  the funded wallet's address after switching back, racing the receive-index rotation — see
  `testing-and-drivers.md` gotchas). Full gate green 11/11 locally since.
- **Registered ≠ existing.** `verify-beta-posture` and `verify-mainnet-bringup` were
  self-contained but absent from `SELF_CONTAINED`, so no CI run ever drove a mainnet-shaped
  node. #138 killed the blocking mainnet interstitial and the gate still went 11/11 green.
  Both registered since (13/13). Writing a driver is not the same as wiring it in — check the
  arrays in `run-drivers.sh` when a whole posture appears untested.
- CI does **not** build Docker images — `.nvmrc` is the only runtime CI tests. A Dockerfile
  Node line ahead of `.nvmrc` means prod runs an untested Node (how Dependabot's node:26 got
  under a signing wallet; policy since #123: Active LTS, ignore docker majors).

## Lessons that cost real time (don't relearn)

- **Assert intent, never exact UI copy.** Drivers pinning literal strings rot silently as
  copy improves — 5 of 8 regtest drivers failed on stale assertions, zero wallet defects (#132).
- Drivers print "Done." even when a check is red — read full output or grep `❌`, never the tail.
- A driver without explicit `process.exit(process.exitCode || 0)` hangs forever after "all
  green" (spawned servers hold handles) → CI times out instead of failing.
- Never pipe a driver run into grep — backgrounded Chrome holds the pipe open and the shell
  hangs. Redirect to a file, then grep the file.
- Prefer updating this wiki + tracker over new HANDOFF files; root `HANDOFF.md` is stale.
- Screenshots from driver runs: keep them in /tmp (run drivers from /tmp), not the repo root —
  the root clutter predates this rule.

## Language & docs

- Use `CONTEXT.md` glossary terms exactly (each entry lists banned synonyms). E.g. it's
  "sign-to-derive" not "log in with wallet"; "redemption" not "burn".
- Discovery docs cite primary sources only and mark UNVERIFIED claims — keep that standard.
- New architecture decisions → `docs/adr/NNNN-*.md`; new expensive facts → this wiki.
