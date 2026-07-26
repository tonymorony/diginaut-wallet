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

Decided in the custody grilling
([#129](https://github.com/tonymorony/diginaut-wallet/issues/129)) of the web3-wallet connect
map ([#126](https://github.com/tonymorony/diginaut-wallet/issues/126)); protocol details in
`docs/discovery/sign-to-derive.md`.
