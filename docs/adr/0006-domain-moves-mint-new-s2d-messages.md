# A domain move mints new sign-to-derive messages; it never rewrites the frozen ones

Buying `diginaut.space` created a problem the frozen sign-to-derive bytes do not allow us to
solve the easy way. Each message pins its origin — `Origin: https://dgb.ludere.space` and a
final line telling the reader to refuse the same request anywhere else — and the signature over
those exact bytes *is* the derived wallet's entropy. Re-pointing the origin line to the new
domain would therefore silently re-derive a different wallet for every user who has ever used
the web3 door, at the same address that still holds their old vault. That is data loss dressed
as a copy edit.

So a domain move mints **new versions** instead. v3 (testnet, 333 bytes, SHA-256 `be8ffbacb1…`)
names `Origin: https://testnet.diginaut.space`; v4 (mainnet, 317 bytes, SHA-256 `51b9fe9bce…`)
names `Origin: https://diginaut.space`. v1 and v2 keep their bytes forever, and their pins in
`apps/wallet/test/connect.test.js` are the proof — a diff there is an incident, never a re-pin.
The two risk sentences are byte-identical across all four, so a reader who has seen one message
recognises the next; only the network and origin lines move.

Which pair is live is decided by the **serving hostname**, not by config: `LEGACY_S2D_HOSTS`
(`dgb.ludere.space`, `diginaut.ludere.space`) selects v1/v2, and every other hostname — the new
domains, `localhost`, any self-host — selects v3/v4. Both axes are allow-lists. The legacy set
is **permanent**: removing a host from it would start deriving different wallets at an address
that still serves the old vaults, with nothing to notice it. The unknown-hostname case must fall
to the *new* era, not to v1, because a self-host serving v1 would be asking for a signature under
an origin line naming a site it is not.

The legacy domains keep serving and are **never redirected**. The vault is IndexedDB, which is
origin-scoped; a redirect would drop a funded user onto an empty wallet at a domain their keys
are not in. Legacy visitors get a dismissible "we've moved" notice instead, and nothing else
changes for them.

Consequences:

- ADR 0005's property widens: one source wallet's derived Diginaut wallet is per **(network,
  origin era)**, not just per network. The same extension account on `diginaut.space` and on
  `diginaut.ludere.space` derives two unrelated mainnet wallets.
- The only migration path is the ordinary one — **restore by recovery phrase** at the new
  origin. For mainnet derived wallets those 24 words always exist: since
  [#142](https://github.com/tonymorony/diginaut-wallet/pull/142) the mainnet save path runs the
  sealed, mandatory backup ceremony. On testnet a user may have skipped it, and the honest answer
  there is to keep using the legacy origin, which is why it stays up.
- **Moving an era assignment exposed a latent bug in reconnect, now fixed.** ADR 0005 always said
  reconnect selects by `source.msgVersion`; `app.js` in fact selected by the current chain, which
  was indistinguishable while every host's era was permanent. It is not permanent for the hosts
  this ADR re-assigns — `localhost`, `127.0.0.1`, every self-host — so a pre-move v1 source would
  have been re-derived against v3 and shown the drift hard stop, blaming the extension for a
  change the app made. Reconnect now reads the record. Any future era move inherits the fix.
- The ceremony's "only *host* may ever ask for this signature" checkbox is now rendered from the
  selected message's own `Origin:` line (`s2dOriginHost`). It was a hardcoded
  `dgb.ludere.space`, so the mainnet ceremony named the testnet domain beside a message saying
  the opposite. A second copy of the origin can drift; a derived one cannot.
- **The next move must pin the hosts it leaves behind, in the same commit.** `s2dForChain` is
  `legacy set → its pinned era, everything else → the newest era`, so minting v5/v6 without
  adding `diginaut.space` and `testnet.diginaut.space` to `LEGACY_S2D_HOSTS` (and
  `LEGACY_HOST_MOVED_TO`) would drop them into "everything else" and silently re-derive every
  v3/v4 wallet — this ADR's own catastrophe, executed by following it. The rule in one line:
  **the host→era map only ever grows; a host joins it with its era frozen as-is on the day it
  stops being canonical; "everything else" always means the newest era.** Every era ever served
  stays selectable by its host, forever.

Cutover procedure: `docs/runbooks/domain-cutover-2026-07.md`. The current bytes and the selection
rules live in `apps/wallet/public/connect.js` with their pins in `apps/wallet/test/connect.test.js`
— read those, not prose. Protocol background (v1/v2 era, mechanics unchanged since):
`docs/discovery/sign-to-derive.md`.
