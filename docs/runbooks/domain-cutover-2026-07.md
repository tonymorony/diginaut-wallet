# Domain cutover 2026-07 — diginaut.space becomes canonical

Adds `diginaut.space` (mainnet) and `testnet.diginaut.space` (testnet) to the
existing dual-stack deployment. The two `ludere.space` hosts **keep serving and
are never redirected** — see § The no-redirect rule. No compose or Caddyfile
change is needed: `deploy/Caddyfile.dual` already reads `{$TESTNET_DOMAINS}` /
`{$MAINNET_DOMAINS}`, and Caddy takes a comma-separated address list per site.

Server specifics (IP, ssh, paths) live in agent memory and server-side files —
the placeholder `<server-ip>` below is deliberate and **never** resolved in this
repo.

## 1. DNS (do this first — certs need it resolving)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `diginaut.space` (apex) | `<server-ip>` | 300 |
| A | `testnet.diginaut.space` | `<server-ip>` | 300 |

- **TTL 300** for the cutover window, so a mistake is 5 minutes and not a day.
  Raise it after the deployment is verified.
- **No `www` record.** The site is `diginaut.space`, not `www.diginaut.space`,
  and a hostname that resolves but is not in `MAINNET_DOMAINS` gets a Caddy TLS
  handshake failure, which reads as "the site is down". If `www` is wanted later,
  add the record **and** a redirect-only Caddy block for it in the same change
  (`www.diginaut.space { redir https://diginaut.space{uri} }`) — a redirect is
  fine there because no wallet ever lived at `www`.
- **No AAAA** unless the box has working IPv6 end-to-end. A published AAAA that
  black-holes makes the site intermittently unreachable for v6-first clients and
  can fail ACME's v6 attempt.
- **CAA:** check `dig CAA diginaut.space` (and the apex of any parent zone).
  Either have no CAA record at all, or make sure it includes both
  `letsencrypt.org` and `zerossl.com` — Caddy issues from Let's Encrypt and
  falls back to ZeroSSL, and a CAA naming only one turns the fallback into a
  hard failure.

Wait until both names resolve to `<server-ip>` from off-box before step 3.

## 2. Server env

Edit `/opt/dgb-support/deploy/.env` (untracked, `0600`, survives deploys):

```
TESTNET_DOMAINS=dgb.ludere.space, testnet.diginaut.space
MAINNET_DOMAINS=diginaut.ludere.space, diginaut.space
```

Keep the legacy host in each list — dropping one takes that site down and
strands the vaults at that origin. `deploy/mainnet-node-prep.sh` writes these
same two lines on a fresh box.

## 3. Deploy

Code first (the new-domain wallet build is what serves the v3/v4 messages), then
Caddy, because cert issuance needs DNS resolving and the container only picks up
the new env on recreate.

```sh
# from the repo, on your machine
git archive --format=tar HEAD | gzip > /tmp/dgb.tgz
scp /tmp/dgb.tgz <server>:/tmp/
# on the server
cd /opt/dgb-support && tar -xzf /tmp/dgb.tgz

cd /opt/dgb-support/deploy
docker compose -f docker-compose.yml -f docker-compose.dual.yml -f docker-compose.cache.yml \
  up --build -d --no-deps wallet wallet-main
docker compose -f docker-compose.yml -f docker-compose.dual.yml -f docker-compose.cache.yml \
  up -d caddy
```

- `--no-deps` on the wallet step is **load-bearing** (ops-and-server.md): without
  it compose recreates the whole closure including `electrumx-main`, whose
  restart closes port 50001 for ~10 minutes and takes mainnet balances down.
- The `caddy` step recreates one container to pick up the new env and issue two
  certificates. Existing domains see a **brief TLS blip** (seconds) while it
  restarts; the wallet containers behind it are untouched.
- Watch issuance: `docker logs -f deploy-caddy-1 | grep -i certificate`. A
  failure here is almost always DNS not yet propagated or a CAA record.

## 4. Verify

```sh
# canonical pair
node apps/wallet/scripts/verify-dual-public.mjs \
  https://testnet.diginaut.space https://diginaut.space
# legacy pair — separate Caddy sites with their own certs, never redirected,
# so a break here is invisible from the canonical pair
node apps/wallet/scripts/verify-dual-public.mjs \
  https://dgb.ludere.space https://diginaut.ludere.space
```

- Build identity on **all four** hostnames — same `version` string, and each on
  its own network:
  `for h in diginaut.space testnet.diginaut.space diginaut.ludere.space dgb.ludere.space; do curl -s https://$h/api/config; echo; done`
- **Manual ceremony spot-check on `https://diginaut.space`** (the one thing no
  driver covers on a live host): open the connect sheet → *Connect a browser
  wallet* → pick an extension → the checkbox must read **"only diginaut.space
  may ever ask for this signature"**, and the extension popup must show
  `Diginaut sign-to-derive v4` / `Origin: https://diginaut.space`. Refuse the
  signature; the point is the bytes, not a wallet. Do the same on
  `https://testnet.diginaut.space` and expect **v3** / `testnet.diginaut.space`.
- Spot-check `https://diginaut.ludere.space` still shows **v2** /
  `diginaut.ludere.space` and now carries the dismissible "Diginaut has a new
  address" line under the header.
- Raise DNS TTL once all of the above is green.

## The no-redirect rule

**Never add a redirect from a `ludere.space` host to a `diginaut.space` one.**
The wallet lives in IndexedDB, which the browser scopes to the origin. A user
funded at `diginaut.ludere.space` who is bounced to `diginaut.space` arrives at
an empty wallet with no way back through the UI, and their keys are not lost but
are unreachable from where they were sent. The legacy hosts therefore stay up
indefinitely, serving the same containers and the same v1/v2 derivation bytes
(ADR 0006). The migration signal is the in-app notice, and the migration action
is a recovery-phrase restore at the new origin — done by the user, when they
choose.

Same reason `LEGACY_S2D_HOSTS` in `apps/wallet/public/connect.js` is permanent:
removing a host from it would keep serving that origin's vaults while deriving
*different* wallets there.

## Rollback

DNS is the only irreversible-looking piece and it is not: the legacy domains
were never touched, so backing out is (a) revert `.env` to the two legacy hosts,
(b) `up -d caddy`, (c) leave or drop the A records. Nothing about a user's
existing vault depends on the new names.
