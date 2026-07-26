# Diginaut — DigiDollar wallet

Diginaut is a non-custodial, browser-based wallet for the DigiByte **DigiDollar** stablecoin. It
lets new users create a wallet, send and receive DGB, and mint DigiDollar — without running their
own node. On testnet, DGB comes from a built-in faucet. Open-source; anyone can run or host it,
but it never takes custody of user keys.

## Language

**DigiDollar**:
DigiByte's decentralized, USD-pegged stablecoin, created by locking DGB as collateral.
_Avoid_: stablecoin (as a proper noun), DD token, the coin

**Mint**:
To create DigiDollar by locking DGB as collateral for a chosen lock period.
_Avoid_: buy, issue, create

**Collateral**:
DGB locked to back minted DigiDollar; released back to the owner on redemption.
_Avoid_: deposit, stake, escrow

**Lock tier**:
A fixed (lock period, collateral ratio) pairing that sets how much DGB backs a mint — ten
consensus tiers from 1 hour at 1000% down to 10 years at 200% (Core v9.26.4).
_Avoid_: term, plan, option

**Transfer**:
Sending DigiDollar from one user to another. A consensus-level spend of a DigiDollar output — not
a plain DGB payment.
_Avoid_: send (for DigiDollar specifically), payment, transaction

**Redemption**:
Converting DigiDollar back into its locked DGB collateral.
_Avoid_: burn, withdraw, cash-out, unlock

**Oracle**:
The on-chain price-feed network (35 oracle slots, 7-signature Schnorr threshold in Core v9.26.4)
that supplies the DGB/USD price the protocol uses, in micro-USD per DGB.
_Avoid_: price feed (as a proper noun), aggregator, data source

**Faucet**:
A service that hands out free testnet DGB so a user has collateral to experiment with.
_Avoid_: dispenser, tap, drip

**Wallet**:
The user's non-custodial, browser-held key store. Keys are generated and kept client-side; the
project never holds them server-side.
_Avoid_: account (reserve for something else), custodial wallet (we are not one)

**Sign-to-derive**:
The ceremony that creates a Diginaut wallet from a deterministic signature made by a connected
web3 extension wallet over a frozen, per-network message.
_Avoid_: log in with wallet (it is not authentication), import (reserved for mnemonics/keystore
files), link

**Derived wallet**:
A wallet whose seed came from sign-to-derive rather than a generated or restored mnemonic.
First-class in every flow; distinct only in origin and backup story.
_Avoid_: connected wallet (that's the source), linked wallet, MetaMask wallet

**Source**:
The external web3 wallet — brand plus signing account — whose signature derived a derived
wallet. Re-signing in the source re-creates the seed, but the source is a convenience door,
not a guaranteed backup; only the seed words are that.
_Avoid_: parent wallet, owner wallet, backup (for the source specifically)
