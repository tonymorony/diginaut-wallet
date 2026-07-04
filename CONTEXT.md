# DigiDollar Wallet

A non-custodial, browser-based wallet for the DigiByte **DigiDollar** stablecoin, aimed at letting
new users create a wallet, get testnet DGB from a faucet, and mint DigiDollar — without running
their own node. Open-source; anyone can run or host it, but it never takes custody of user keys.

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
A fixed (lock period, collateral ratio) pairing that sets how much DGB backs a mint — from
30 days at 300% down to 10 years at 100%.
_Avoid_: term, plan, option

**Transfer**:
Sending DigiDollar from one user to another. A consensus-level spend of a DigiDollar output — not
a plain DGB payment.
_Avoid_: send (for DigiDollar specifically), payment, transaction

**Redemption**:
Converting DigiDollar back into its locked DGB collateral.
_Avoid_: burn, withdraw, cash-out, unlock

**Oracle**:
The on-chain price-feed network (15 selected signers, 8-of-15 Schnorr consensus) that supplies the
DGB/USD price the protocol uses.
_Avoid_: price feed (as a proper noun), aggregator, data source

**Faucet**:
A service that hands out free testnet DGB so a user has collateral to experiment with.
_Avoid_: dispenser, tap, drip

**Wallet**:
The user's non-custodial, browser-held key store. Keys are generated and kept client-side; the
project never holds them server-side.
_Avoid_: account (reserve for something else), custodial wallet (we are not one)
