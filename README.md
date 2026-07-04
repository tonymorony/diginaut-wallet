# DigiDollar Testnet UI

A simple, dependency-free web interface for **DigiByte DigiDollar** — the decentralized USD
stablecoin (DigiByte Core v9.26+). Built for the testnet phase while DigiDollar awaits mainnet
activation.

Three things it does:

1. **Mint calculator** — pick an amount + lock period, see required DGB collateral. Uses the real
   lock tiers from the DigiDollar Implementation Spec v5.0. Works with no node at all.
2. **Network & oracle status** — reads `getblockchaininfo`, `getdeploymentinfo`, `getoraclestatus`,
   `listoracles` to show whether the DigiDollar softfork is active and whether the oracle price feed
   is healthy.
3. **Address generation** — `getnewdigidollaraddress` to get a P2TR (`dgbt1p…`) receive address.

## Run

```bash
npm start          # → http://localhost:8787
```

No `npm install` needed — it uses only the Node standard library (Node 18+).

### Mock mode vs real node

- **Mock mode (default):** with no RPC credentials set, all data is realistic fake data shaped like
  the real RPC responses. Good for building/demoing the UI before you have a node.
- **Real node:** copy `.env.example` → `.env`, set `DGB_RPC_USER` / `DGB_RPC_PASS` and
  `DGB_RPC_URL` (use the `rpcport` from your `digibyte.conf`), then load it and `npm start`.

  ```bash
  set -a && source .env && set +a && npm start
  ```

  Your `digibyte.conf` needs `server=1`, `rpcuser=`, `rpcpassword=`, and the node run with
  `-testnet`. Check the testnet `rpcport` in your config — it differs from mainnet.

## Lock tiers (DigiDollar Spec v5.0)

| Lock period | Collateral ratio |
|---|---|
| 30 days  | 300% |
| 3 months | 250% |
| 6 months | 200% |
| 1 year   | 175% |
| 3 years  | 150% |
| 5 years  | 125% |
| 10 years | 100% |

## Safety

The RPC proxy exposes only a small allow-list of **read / address** methods. Fund-moving calls
(`mintdigidollartaproot`, `redeemdigidollar`) are deliberately **not** reachable from the browser —
add them only behind proper auth and a confirmation step.

## Status

Testnet-ready today. When miners activate DigiDollar on mainnet, just point `DGB_RPC_URL` at a
mainnet node — the same UI works unchanged.
