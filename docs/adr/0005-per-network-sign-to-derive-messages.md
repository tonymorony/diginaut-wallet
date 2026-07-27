# Sign-to-derive messages are per-network, so derived seeds do not span networks

A restored mnemonic spans networks (one seed, coinType 20/1 split), so the obvious path was to
let a signature-derived seed do the same. We decided the opposite: the frozen sign-to-derive
message names its network (`Network: DigiByte testnet` in v1), and a future mainnet rollout
mints a new message version — different bytes, therefore a different seed and a different
wallet. Rationale: the derivation signature is phishable by construction (any site can present
the same bytes), and the connect experiment runs on testnet first — with per-network messages,
nothing a user signs during the experiment can ever be replayed against mainnet funds. The
cost, accepted deliberately, is the asymmetry with restored mnemonics: a user who later joins
mainnet derives a second, unrelated wallet from the same source.

**Mainnet rollout executed (2026-07-27).** The anticipated "future mainnet rollout" happened:
`S2D_MESSAGE_MAIN` (v2, 331 bytes, SHA-256 `efd2377378…`) names `Network: DigiByte mainnet` and
`Origin: https://diginaut.ludere.space`, including its refuse-elsewhere line. Both messages are
pinned by `apps/wallet/test/connect.test.js`; a test also asserts the pair share no network
wording, which is the replay property stated above rather than an assumption about it.
Selection is explicit at both moments that matter: `s2dForChain()` on first derive (which
network the wallet is *born* on) and `s2dForVersion()` on reconnect (which bytes *made* the
wallet, read from `source.msgVersion`). Both take `main` and `mainnet`, and both are
allow-lists — an unrecognised chain falls to v1, which cannot touch mainnet funds. Consequence
worth restating for support: one extension account now yields two unrelated Diginaut wallets,
and re-deriving a testnet wallet while on mainnet correctly finds nothing.

Decided in the custody grilling
([#129](https://github.com/tonymorony/diginaut-wallet/issues/129)) of the web3-wallet connect
map ([#126](https://github.com/tonymorony/diginaut-wallet/issues/126)); protocol details in
`docs/discovery/sign-to-derive.md`.
