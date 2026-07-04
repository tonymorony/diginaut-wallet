# Indexer landscape: extend vs build (#4)

Date: 2026-07-04. Input for the HITL extend-vs-build decision deferred in ADR-0003.
Scope per #4: address → UTXOs + history for **plain DGB** now; DigiDollar positions land in M3 (#13).

## Facts that shape the decision

1. **Every wallet address is taproot** (bech32m, witness v1) — BIP86 derivation shipped in #3.
   An indexer that cannot resolve witness-v1 addresses is useless to us from day one.
2. **The node cannot answer for arbitrary addresses.** All DigiDollar read RPCs
   (`listdigidollarpositions`, `getdigidollarbalance`, `listdigidollartxs`) are **wallet-scoped**
   (verified against v9.26.4 regtest `help`) — they answer about the node's own wallet only.
   Plain-DGB address queries have no node-side index either (`scantxoutset` scans the whole UTXO
   set per query: no history, no mempool, seconds per call).
3. **No off-the-shelf indexer understands DigiDollar.** OP_DIGIDOLLAR positions (M3 #13) will be
   our code in *every* scenario. `digidollar-js` already parses all three envelopes
   (mint/transfer/redeem), so a thin JS scanner is cheap when M3 comes.
4. DD transactions use **standard serialization** (special nVersion bits + OP_RETURN metadata),
   so any bitcoin-like indexer can store/serve them without understanding them.

## Candidates

| | Blockbook (Trezor) | ElectrumX (spesmilo) | Build: thin JS indexer |
|---|---|---|---|
| DGB support | official (`configs/coins/digibyte.json`); live [testnet explorer](https://testnetexplorer.digibyteservers.io/) | `DigiByte` + `DigiByteTestnet` in `coins.py`; repo pushed 2026-07-03 | n/a (we write it) |
| **Taproot addresses** | **parser defines only P2PKH/P2SH/bech32-v0 params — witness v1 unverified, likely needs a Go fork patch** | **safe by construction**: Electrum protocol queries by scripthash = sha256(scriptPubKey); the server never decodes addresses | safe (we control it) |
| API shape | REST + WebSocket, address-level | Electrum protocol (TCP/SSL, JSON-RPC-ish), scripthash-level | whatever #5 needs |
| Ops | Go binary + RocksDB, Docker images, heavier sync | Python (pip), LevelDB/RocksDB, light on testnet | Node + sqlite, ZMQ against our shared node |
| Correctness burden on us | none | none | **reorgs, mempool, initial sync — all ours** |
| DD-awareness path (M3) | separate scanner anyway | separate scanner anyway | native |
| Risks | witness-v1 gap; fork maintenance if patching | `DigiByteTestnet` genesis/params may predate testnet4 — must probe; no regtest class (trivial local subclass) | most new code; correctness bugs hit user balances |

Rejected early: digiexplorer/Insight (legacy API, unmaintained), Esplora/electrs (BTC-only,
multi-algo DGB headers unsupported).

## Recommendation (needs sign-off)

**Extend — run stock ElectrumX behind our own thin API façade** (`apps/indexer`):

- The façade is the **indexer seam** #5 already requires: wallet asks
  `address → UTXOs/history`, the façade computes the scriptPubKey/scripthash (code that exists in
  `digidollar-js`) and queries ElectrumX. The wallet never learns which backend is behind it.
- Scripthash protocol sidesteps the witness-v1 problem entirely — the decisive advantage over
  Blockbook for an all-taproot wallet.
- No fork: stock ElectrumX + config. Regtest for tests = 10-line local coin subclass.
- M3 #13 adds the DD-positions scanner **inside the façade**, reusing `digidollar-js` parsers.
- If ElectrumX's DGB testnet params prove stale (probe below), the façade seam lets us pivot to
  "build" without touching the wallet.

First probes if approved:
1. Point ElectrumX at our regtest node (local `DigiByteRegtest` coin class), index, query a
   `dgbrt1p…` scripthash for the faucet coins from #7's e2e.
2. Same against testnet4 (verifies genesis/params in `coins.py`).

**xpub privacy (AC):** all candidates are address-level queries; the wallet sends individual
addresses (as scripthashes) only — xpubs never leave the browser regardless of choice.
