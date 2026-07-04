# Self-hosting the DigiDollar wallet stack

Run the full stack — wallet, indexer, faucet, ElectrumX — against **your own
DigiByte node** with one `docker compose up`. Nothing here custodies user
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
| testnet | `testnet` | `dgbt`    | check that your ElectrumX build knows DigiByte testnet — if not, add a coin class next to `scripts/electrumx-regtest/coins_regtest.py` (it is ~20 lines: NET name, address version bytes, genesis hash) |

A wrong `DGB_HRP` is silent but total: the indexer 400s every address and the
wallet shows no balances.

## Stablecoin flows (mint / transfer / redeem)

`FEATURE_MINT` gates all three flows **together** (ADR-0002: mint is never
exposed without transfer and redeem). Leave it empty until the release gate
(#17) signs off; set `FEATURE_MINT=1` and `docker compose up -d wallet` to
flip it.

## Updating

```sh
git pull
docker compose up --build -d    # rebuilds changed images, keeps volumes
```

Volumes: `electrumx-data` (chain index — safe to delete, re-syncs),
`faucet-data` (claim ledger — deleting resets rate limits).
