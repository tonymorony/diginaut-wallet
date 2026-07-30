# LLM-wiki index

Agent-facing knowledge base. Protocol: see root `CLAUDE.md`. Load only what the task needs.

| Page | Read when the task involves… |
|---|---|
| [project-status.md](project-status.md) | "where are we", picking up work, branch/PR/frontier state. **Rots fastest — check stamp.** |
| [architecture.md](architecture.md) | any code change; system map, data flow, invariants, ADR digest |
| [wallet-app.md](wallet-app.md) | `apps/wallet` — UI, server proxy, vault, sign-to-derive |
| [design-system.md](design-system.md) | icons, the two visual tiers, UX copy — anything a user sees or reads |
| [protocol-lib.md](protocol-lib.md) | `packages/digidollar-js` — tx building, addresses, consensus arithmetic |
| [backend-and-deploy.md](backend-and-deploy.md) | indexer, faucet, `deploy/`, `scripts/`, self-hosting |
| [consensus-facts.md](consensus-facts.md) | mint/transfer/redeem rules, DD addresses, oracle — facts earned from Core source |
| [testing-and-drivers.md](testing-and-drivers.md) | running tests, CDP verify-* drivers, regtest stand, driver gotchas |
| [ops-and-server.md](ops-and-server.md) | deploying to prod, dgb-server, ssh, live-site debugging |
| [agent-workflow.md](agent-workflow.md) | opening PRs, reviews, CI, classifier constraints, process lessons |

## Canonical prose docs (don't duplicate — point)

- `CONTEXT.md` — domain glossary (DigiDollar, mint, sign-to-derive, derived wallet…). Use its terms.
- `docs/adr/0001–0005` — architecture decisions (digested in architecture.md).
- `docs/discovery/*` — research with primary-source citations (sign-to-derive, consensus facts, oracles, indexer, UX benchmark).
- `docs/specs/wallet-management-v2.md` — vault/backup/multi-wallet spec (shipped).
- `docs/specs/dd-lock-and-earn-pilot.md` — DD Lock & Earn testnet pilot protocol spec (v0.1.0).
- `docs/runbooks/*` — mainnet node prep (tracked); the 2026-07 server-migration runbook
  exists locally but is untracked (see project-status.md).
- `docs/PRD.md` (archived), `ROADMAP.md` (M0–M3 history), `TODO.md` (conscious deferrals).
- `docs/SELF-HOSTING.md` — full-stack compose walkthrough (the reference deploy follows it).
