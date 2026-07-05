# Self-hosting the DigiDollar wallet stack

Run the full stack — wallet, indexer, faucet, ElectrumX — against **your own
DigiByte node** with one `docker compose up`. (The reference deployment lives at
<https://dgb.ludere.space>, stood up exactly this way.) Nothing here custodies user
funds: keys live in each visitor's browser (ADR-0001); the node only answers
reads and relays client-signed transactions through a strict RPC allow-list.

```
browser ──► wallet :8791 ──┬─► /api/rpc      ──► your DigiByte node (allow-listed RPCs)
                           ├─► /api/indexer  ──► indexer ──► ElectrumX ──► node
                           └─► /api/faucet   ──► faucet  ──► node (hot wallet)
```

Only the wallet's port is published. Indexer, faucet and ElectrumX stay on the
compose-internal network and are reached through the wallet's same-origin
proxies — nothing else to firewall.

## Prerequisites

- Docker with the compose plugin.
- A DigiByte Core **v9.26+** node (the DigiDollar preview build) on the chain
  you intend to serve, with in `digibyte.conf`:

  ```
  server=1
  txindex=1          # ElectrumX requires it
  rpcuser=...        # or rpcauth
  rpcpassword=...
  ```

## Start the stack

```sh
cd deploy
cp .env.example .env   # fill in DGB_RPC_*, DAEMON_URL, chain settings
docker compose up --build -d
```

Open `http://localhost:8791` — the badge must say **LIVE NODE** (MOCK MODE
means `DGB_RPC_USER`/`DGB_RPC_PASS` didn't reach the wallet container).

Health checks:

```sh
curl -s localhost:8791/api/config           # {"mock":false,"faucet":true,"indexer":true,...}
docker compose exec wallet wget -qO- http://indexer:8789/api/health   # {"height":N} — must track the node
docker compose logs electrumx | tail        # sync progress on first start
```

ElectrumX indexes from genesis on first start — on a fresh regtest that is
seconds; on testnet expect a while. The indexer answers 502 until ElectrumX
accepts connections.

## The faucet hot wallet

The faucet dispenses from a node wallet that **you** own and fund. It is the
only service holding real spending power — treat it as petty cash:

```sh
# once: create the wallet the faucet will draw from (name must match FAUCET_WALLET)
digibyte-cli createwallet faucet
digibyte-cli -rpcwallet=faucet getnewaddress    # top-up address
# top-up: send testnet DGB to that address from anywhere
digibyte-cli -rpcwallet=faucet getbalance       # check remaining funds
```

Sizing: one claim hands out enough to mint `FAUCET_TARGET_DD_CENTS` (default
$50) at the six-month tier at the live oracle price, +10%. At ~$0.013/DGB that
is ≈ 15,000 DGB per claim — fund accordingly. Claims are rate-limited per
address AND per IP (`FAUCET_COOLDOWN_HOURS`, default 24 h); the ledger
survives restarts in the `faucet-data` volume. The faucet deliberately
refuses to dispense while the oracle quote is stale (HTTP 503) — that is a
node/oracle condition, not a stack failure.

## Chain selection

Everything must agree on one chain:

| chain   | `DGB_NET`  | `DGB_HRP` | notes |
|---------|-----------|-----------|-------|
| regtest | `regtest` | `dgbrt`   | works out of the box (custom ElectrumX coin class ships in this repo) |
| testnet | `testnet` | `dgbt`    | works out of the box too — `scripts/electrumx-regtest/coins_regtest.py` registers a DigiByte testnet class (genesis from v9.26.4 `CTestNetParams`) |

A wrong `DGB_HRP` is silent but total: the indexer 400s every address and the
wallet shows no balances.

## Stablecoin flows (mint / transfer / redeem)

Mint, Transfer and Redeem ship **together as one unit** and are always on
(ADR-0002: mint is never exposed without transfer and redeem). The release
gate (#17) removed the former `FEATURE_MINT` flag — there is nothing to
configure.

## Public deployment (testnet, TLS)

On a fresh Linux server (root):

```sh
# 1. the node — downloads the v9.26.4 release, configures TESTNET with
#    server=1 txindex=1, installs a systemd unit, starts syncing
RPC_USER=dd RPC_PASS=$(openssl rand -hex 16) ./deploy/node-setup.sh
# keep the RPC port (14022) closed in the host firewall; only 22/80/443 open

# 2. DNS: create an A record for your hostname → this server's IP

# 3. the stack, with Caddy terminating HTTPS (Let's Encrypt, automatic)
cd deploy && cp .env.example .env
# .env: DGB_NET=testnet, DGB_HRP=dgbt, DOMAIN=<your hostname>,
#       RPC creds from step 1, DGB_RPC_URL/DAEMON_URL port 14022
docker compose -f docker-compose.yml -f docker-compose.tls.yml up --build -d
```

ElectrumX indexes the testnet chain on first start — wait until
`docker compose exec wallet wget -qO- http://indexer:8789/api/health` reports
the node's height before announcing the URL. Fund the faucet wallet first
(see above).

## Updating

```sh
git pull
docker compose up --build -d    # rebuilds changed images, keeps volumes
```

Volumes: `electrumx-data` (chain index — safe to delete, re-syncs),
`faucet-data` (claim ledger — deleting resets rate limits).
