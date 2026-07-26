# Architecture

Verified: 2026-07-26 @ `7247899`.

## System map

```
browser (keys live HERE) ──► wallet server :8787/:8791 ──┬─► /api/rpc     ─► DigiByte node (read allow-list only)
  vault.js / app.js / digidollar-js                      ├─► /api/indexer ─► indexer ─► ElectrumX ─► node
                                                         └─► /api/faucet  ─► faucet ─► node hot wallet (testnet)
```

- Keys: BIP39 seed, BIP86 taproot derivation, encrypted in IndexedDB (vault v2, one master
  password). Server never sees a key; broadcast-only path for signed txs.
- One build serves every network: banner/title/address format decided at runtime from the
  chain the node reports (`netchrome.js`); **netKnown gating** = never show guessed-network
  addresses or balances before the node answered.
- Mock mode: without RPC creds `server.js` serves realistic fake data (`mockResponse()`),
  shaped like real RPC — most UI work and drivers run against it.

## Invariants (do not weaken)

1. `ALLOWED_METHODS` in `apps/wallet/server.js` — read-only RPC allow-list; fund-moving RPCs
   unreachable from the browser. Any new method: extend allow-list + mock together.
2. `apps/wallet/vendor.lock` — sha256 of every vendored file, verified in `startServer()`,
   **throws before listen** on drift (also rejects unrecorded extras). Regen: `npm run vendor:lock`.
3. Mint never ships without redeem + transfer (ADR-0002).
4. Fund-moving code passes the differential harness first: JS-built txs byte-identical to
   Core-built on regtest (ADR-0001/0002).
5. `digidollar-js` stays pure — deterministic functions, zero I/O (ADR-0004).
6. Derived (sign-to-derive) seeds never span networks — per-network frozen messages (ADR-0005).

## ADR digest

| ADR | Decision |
|---|---|
| 0001 | Non-custodial browser wallet; client-side JS minting; shared read/broadcast node |
| 0002 | Mint + redeem + transfer ship together — no one-way traps |
| 0003 | Balance queries via own indexer (ElectrumX façade); xpubs never leave the browser |
| 0004 | Protocol layer = pure library (`packages/digidollar-js`), monorepo package, zero I/O |
| 0005 | Sign-to-derive messages are per-network → derived seeds don't span networks |

## Workspaces

| Path | Role | Detail page |
|---|---|---|
| `packages/digidollar-js` | Pure DigiDollar protocol lib, mirrors Core v9.26.4 arithmetic | protocol-lib.md |
| `apps/wallet` | Web app + RPC allow-list proxy server | wallet-app.md |
| `apps/indexer` | Address-level façade over stock ElectrumX | backend-and-deploy.md |
| `apps/faucet` | Testnet DGB dispenser (rate-limited hot wallet) | backend-and-deploy.md |
