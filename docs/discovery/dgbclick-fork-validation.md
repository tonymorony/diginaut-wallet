# DGBclick fork — claim validation and upstreaming map

Verified: 2026-07-31. Source: full-tree analysis of <https://github.com/usascholar/dgbclick-wallet>
(clone diffed against this repo; 14-agent review: 6 claim-cluster validators + 6 upstream-fit
mappers + completeness critic + adversarial spot-check, all verdicts code-cited). Fork code was
read, never executed.

## Provenance

- Published repo is a **squashed snapshot**: 4 commits, all "Release v0.1.0", 2026-07-28..30,
  author `usascholar`. Their SECURITY.md says the repo receives "reviewed release snapshots"
  from a private dev repo. Baked `.version-stamp` (`6533d80`) and a spec citing `main @ 83a1304`
  reference commits that don't exist in the published history.
- Content forks from Diginaut `4125fe4` (2026-07-26, main~10). It lacks everything after that:
  web3 connect (#142/#143), icon-sprite and mobile fixes, the llm-wiki, `nettimeout.js`.
- It **cherry-picked upstream content after the fork point**: ADR-0005 text from `0b75a8e`
  (without the code it documents — no s2d/connect code anywhere in the fork).
- ~12.5k insertions / 97 files over the fork point (ex-binaries).
- **Attribution/licensing is proper**: LICENSE keeps the Anton Lysakov copyright line and adds
  their own for modifications (MIT-compliant); README + in-app footer credit and link
  diginaut-wallet.

## Claim scoreboard

31 fork claims examined: **0 fabricated** — 21 verified, 10 partial (real mechanism, overstated
or mis-scoped framing); 21 + 10 = 31, no third bucket. Two of the partials are misattributions
rather than overstatements: the "outside-attacker audit" and the CI/Dependabot pair, both
inherited Diginaut work. Separately, 5 hard-invariant checks of our own: ALLOWED_METHODS,
vendor.lock, netKnown and ADR-0002 all intact; "nothing new phones home" is partial (their
GitHub backup adds an outbound destination). All 8 adversarial spot-checks of the strongest
verdicts held. The three big framing corrections:

1. **The "outside-attacker security audit, fixed every finding" is the same audit event this
   repo absorbed as #137 (`5d79c61`, 2026-07-27)** — one day after their fork point. Every
   C/H/M item in their AUDIT.md maps to work Diginaut already has. Worse for them: their
   `broadcastlog.js` `txidFromHex` hashes raw bytes and returns the **wtxid** for segwit txs;
   our `txidFromSignedHex` strips witness data correctly. Their file is strictly worse than
   main's. Only the *published findings doc* and SECURITY.md are genuinely theirs.
2. **Performance headlines are unmeasured and self-referential.** No harness anywhere measures
   445→35 or ">1 min to seconds". The 445-request baseline comes from the fork's own
   multi-chain `extraSources` feature (doesn't exist here). "Pooled sessions replaced
   per-request sessions" is false — the baseline (ours) was already one shared session; their
   change is 1→6 sockets.
3. **Most "same-day mainnet bug fixes" fix bugs in the fork's own new features** (invisible
   funds, double-counting live only in their descriptor/multi-chain code). Exception: the
   pending→confirmed precedence bug **does exist in Diginaut** (see adopt list). CI +
   Dependabot are inherited Diginaut work (#114/#115) misattributed as fork improvements —
   and their snapshot actually breaks CI (exec bits stripped from all shell scripts;
   `./scripts/run-drivers.sh` can't run; their two new drivers were never registered in
   SELF_CONTAINED/NEEDS_STACK either).

Genuinely good work, verified: the O(n²) parser fix, the gift-key construction (consensus-
enforced via NUMS + CLTV MAST leaves; "trustless" is accurate for the mint-to-order gift flow),
the treasury engine's persist-before-transition discipline with crash-resume tests, the
recovery CLI's key hygiene, the Core-recipient regtest proof (real, but not in CI).

Notable fork defects found (do not import by accident): admission-ceiling retry leak
(`return client.request` not `return await`, indexer server.js:334); treasury wizard drops its
own spec's mandatory per-treasury backup (N unbacked seeds after a split — their largest
fund-loss surface); descriptor wallets export keystores that **cannot be restored** (import
hard-requires `validateMnemonic`); DD token balance still double-countable across colliding
descriptor entries; redeem auto-gather's 4-min silent wait vs our 5-min autolock; recovery CLI
burns excess DD (declares `ddCents` from config instead of reading the coin); GitHub-backup PAT
survives their "erase all".

## Upstreaming map

Mapper cross-checked every item against main@`4e2733b` (incl. #142/#143 overlap) and the hard
invariants (ALLOWED_METHODS, vendor.lock, netKnown, ADR-0002). Full rationale per item in the
session workflow output; summary below. Every verdict was code-cited in that run, but only the
ones reproduced here with a `file:line` are reproducible from this tree — the rest are summary
verdicts whose evidence was not preserved in the repo. Re-verify an uncited verdict before
acting on it.

### Adopt — small, real Diginaut bugs/wins, low coupling

| Item | Effort | Note |
|---|---|---|
| **Flexible fee leg** (redeem/transfer `feePrivKeyHex` + p2wpkh fee coin; extend to mint gate in same PR) | M | Highest value-per-line in the fork. Fixes our real single-coin stranding (mint change is p2wpkh; txbuild.js:243/:340 hard-bind fee to owner P2TR). Consensus-proven by our own Core fixture (redeem-tx.json vin[3] = [71,33] witness). Regtest before merge; fee-estimation WU delta; ux-writer for error copy. |
| O(n²) ElectrumX frame parser → resumable byte scan | S | Bug live at indexer server.js:75/:84; single shared session makes it deployment-wide. Also fixes UTF-8 chunk-boundary corruption. Take their 12MB timing test. |
| Verbose-tx cache (promise-memoized) | S | Collapses within-poll overlap (positions/dd-utxos/enrich). TTL ~5s not their 15s (15s = one full block); scope to startServer for tests. |
| `kdf.iterations` bound in `parseKeystoreFile` | S | Our live bug; hostile keystore pins browser in PBKDF2. Floor ≤600k is backward-compatible. |
| Error-message leak fixes (indexer 502 relay, wallet catch-all 500, "indexer unreachable: host:port") | M | Keep faucet's #55 pattern. **Never genericize handleRpc's 502** — dderrors/broadcastlog match node reject tokens; that's a #137 money-safety property. |
| Bind hardening (default 127.0.0.1 + `BIND_HOST`) | S | All three services bind 0.0.0.0 today. Must land with compose env in same commit or Caddy→wallet breaks. |
| SECURITY.md | S | Only claim where the fork did work we haven't. Rewrite (their "snapshots after" caveat is false for us). **Done in #170**, which states GitHub PVR as the only private channel today; a non-GitHub contact (email + PGP) is still wanted and needs an owner-supplied address. Enabling GitHub PVR in repo settings is a merge gate for #170. |
| Static-asset cache headers (`no-cache` + 304; prefer ETag over mtime) | S | serveFrom sends content-type only; no cache-busting anywhere; fixes the "phones run days-old code" class for us too. Apply to /vendor as well (vendor bump must not pair stale crypto with new app.js). |
| Net-dot debounce (2 failed polls; truthful "inactive" answers still immediate) | S | Kills the deploy-restart red-dot flash. |
| Confirmation precedence in historyRow | S | **Real Diginaut bug** (ElectrumX index lag vs node confirmations → confirmed tx renders "pending"; we already model the lag: indexerLagBlocks). Adapt: keep `final`/`${c} conf` strings (design-system + drivers pin them), require `c >= FINAL_CONF && h.height > 0` for `final` (untrusted indexer must not stamp finality alone). Add the missing regression fixture. |
| Mid-session gap re-arm | S | If a payer funds the lookahead frontier mid-session, main never widens the window until reopen. Edge-triggered re-arm of syncReceiveIndex from `addressUse`; don't touch receiveScanBusy. |
| Warm-start receive scan | S | Start walk at `wallet.index` (vault counter) not 0. Safe **only because** our watch window is contiguous — comment that. Skip their localStorage depth cache entirely (plaintext activity residue; solves fork-only problems). |
| Erase-all completeness | S | Our `w-erase-go` leaves `diginaut.broadcasts` (signed tx hex + payees, 30 days) behind. Give broadcastlog `clearAll()`; keep the key inventory in wallet-app.md authoritative. |
| `fetchIndexer` retry ladder | S | Adapt onto #H1: retry `err.transport` only; never on rpc()/broadcast (double-send hazard); consider boot-path-only. |

### Adopt with rework — real but sharp edges

- **Rate-limit spoofing residual** (M): socket-peer trust + `net.isIP()`; also fixes the
  faucet's first-element XFF keying the 24h hot-wallet cooldown. **High risk verbatim**: their
  loopback default self-DoSes behind our Caddy (peer is a container IP) — recreates the
  pre-#H4 shared bucket. Trusted-peer config + compose overlays + container-shape test in one PR.
- **Indexer scan budget + 503 admission ceiling** (M): one unauthenticated `/positions` GET
  fans out unboundedly today. Must land **with** the complete-or-absent client contract or a
  truncated scan renders a real vault as empty. Adopt together or neither.
- **ElectrumX session pool** (M): premise wrong, pressure real (concurrent users on one
  session). Order: identity-guard socket events → per-session in-flight FIFO → pool (2–4 here,
  not 6; dual stack doubles it) → admission ceiling. Fix their `return await` bug. Benefit is
  projected, not measured — say so in the PR.
- **Bulk indexer endpoint** (L): 445→35 doesn't transfer, but the *fusion* does — our client
  makes 6 GETs/derivation/8s (~78/poll at index 10) re-fetching the same get_history/listunspent
  server-side. POST needs allow-list + rate-bucket + INDEXER_SHAPES touched in one change
  (drift = unrate-limited hole); scan budget is a prerequisite; drop their one-way 404 latch;
  dedupe addresses server-side.
- **Gift keys / mint-to-order** (M lib + M UI): strongest feature candidate. Additive
  `ownerKeyHex` on buildSignedMintTx + checksummed `ddgift1…` bech32m envelope that hard-rejects
  address HRPs (prevents the tweak(tweak(P)) stranding they shipped once). Preconditions: an
  **owner-approved ADR-0002 amendment — not settled**; mint-to-order is exactly what relaxes
  the rule (the minter can neither redeem nor transfer what they gifted), so write the
  amendment before any code and don't assume "the **owner** can redeem and transfer" is where
  it lands; regtest acceptance run as part of the merge (their e2e is `skip: !RPC_URL`);
  **stranded-gift recovery CLI ships in the same release** (fix its ddCents-burn defect first;
  export `tapTweakPrivKey` deliberately).
  Core-recipient parsing (`parseRawOwnerKey` + reworked spike as a manual-gate driver) makes it
  more than an in-app novelty (M). Treat their "mainnet confirmation" narrative as testimony,
  not evidence — reproduce before any wiki stamp.
- **Master password strength** (M): fork didn't fix it either, but the finding stands — 8-char
  floor now guards mainnet money (#142). New floor at create/change only, never unlock.

### Skip

- **Treasury Wallets as shipped** (~1,900 LOC front-end): hard conflict with the #142 sealed
  backup ceremony (every treasury born `backedUp:false` — the fund-loss path #142 closed, ×N);
  batch aggregate evades the $500 cap; derivation coupled to the open wallet. If a batch feature
  is ever scheduled, steal the *engine discipline* (persist-per-transition + crash-resume tests).
  One standalone S nugget: a **one-time transfer passphrase** for handover export (our export
  reuses the master password — wrong for handing a wallet to someone else).
- **Core descriptor import** (L): the only migration path off Core and the mechanism is good
  (dispatch inside deriveTaprootAddress, ADR-0004-pure), but it collides with the mainnet
  mandatory word-quiz ceremony and needs the differential harness. If pursued: narrowest slice
  (single wildcard tr(), testnet, primary chain) + prerequisites first — txid:vout dedupe +
  non-wildcard rejection (S, worth doing standalone), network-agreement check on pasted keys
  (S), and **close the export/restore asymmetry first** (their worst defect: unrestorable
  backups).
- **GitHub encrypted backup**: new outbound destination for (encrypted) seed material, PAT
  lifecycle they themselves leak on erase, CSP connect-src relaxation. Off-brand for our
  threat model.
- **Runtime merchant directory**: skip the remote-fetch/vote/POST surface; if "where can I
  spend DD" is wanted, bundle the JSON + existing esc()/CSP discipline, update by PR (M).
  Their seed file ships two real businesses as baked-in endorsements — copy risk, ux-writer.
- **SSE block events / batch engine as-is / their AUDIT.md text / their broadcastlog.js**:
  superseded by or inferior to what main already has.

## Watch-outs for any cherry-pick from this fork

Check `git diff --summary` for exec-bit flips (repo-wide in the fork); their `BIND_HOST`
default breaks our compose topology; their `'✓ confirmed'`/`'5 of 6 conf'` copy breaks three
drivers and the design-system pin; their UI predates the icon sprite (#138/#140) and reverts to
raw glyphs; their fake-indexer `/__auto` auto-adopt optimism. Their faucet XFF hardening
(loopback-gated, last-element, isIP) is sound and unclaimed — fold into the rate-limit item.

## Fork-side regressions (context, no action)

Deleted CONTEXT.md/ROADMAP.md/TODO.md (their README still links two of them), deleted the
mainnet node-prep/restart-window scripts + runbook (their "run your own" promise now has no
mainnet guidance), dead `.version-stamp` mechanism, AUDIT.md never covers their flagship
treasury/gift feature, parallel-agent scaffolding left in production code
(treasury-engine.js FALLBACK_ITEM_STATES).
