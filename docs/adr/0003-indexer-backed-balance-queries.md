# Indexer-backed balance queries — no xpub uploads to the node

## Context

A nodeless browser wallet must answer "what are my UTXOs / balances / DigiDollar positions?" for
arbitrary user addresses. A Core node only indexes its own wallet. The alternatives were:
(a) importing users' public descriptors (xpubs) into a watch-only wallet on the shared node —
zero new infrastructure, but the server learns every user's full address set, and the node wallet
grows per user; (b) an address indexer (Electrum/Esplora-style); (c) `scantxoutset` on demand —
too slow, no mempool, no history.

## Decision

The architecture includes an **address indexer from day one**. The browser queries balances,
history, and UTXOOs through the indexer; user xpubs are never uploaded to the shared node.

## Consequences

- One more service to run alongside the shared node and faucet.
- **DigiDollar awareness is on us.** Existing Electrum-style indexers treat `OP_DIGIDOLLAR`
  outputs as unknown scripts: DGB balances would work, but DigiDollar positions (amounts, lock
  expiry) would be invisible. We must either extend/fork an existing indexer or build a thin
  DigiDollar-aware indexing layer over the shared node. Which of the two is a build-time decision,
  to be made after inspecting the existing DigiByte Electrum server landscape.
- Privacy improves over the xpub-upload path: the server never receives a user's descriptor, only
  sees individual address queries.
