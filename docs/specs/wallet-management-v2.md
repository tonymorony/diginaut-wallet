# Wallet management v2 — implementation spec

Implements the destination of wayfinder map #92 using the recommended defaults from
`docs/discovery/wallet-ux-benchmark.md` (ticket #93). Design decisions here resolve map
tickets #94 (multi-wallet model), #95 (backup status), #96 (keystore file), #97 (session
security); the shipped flow supersedes the prototype ticket #98.

Everything below targets `apps/wallet/public/` (vanilla JS, no framework, styles inline in
`index.html`). Unit tests are `node --test` in `apps/wallet/test/`; end-to-end is headless
Chrome over CDP in `apps/wallet/scripts/verify-*.mjs` (mock mode via `server.js` + fake
indexer).

## 1. Keystore v2 — one vault, one master password (#94)

### Schema

IndexedDB `dd-wallet` / store `keystore` keeps a SINGLE record, id `vault`:

```js
{
  id: 'vault', v: 2,
  kdf:    { name: 'PBKDF2-SHA256', iterations: 600000, salt: b64 },
  cipher: { name: 'AES-256-GCM', iv: b64, data: b64 },   // ciphertext of SECRETS json
  meta: {                       // cleartext — readable while LOCKED
    activeId: 'w1',
    wallets: [ { id: 'w1', name: 'Wallet 1', createdAt: 1752…, backedUp: false } ],
  },
}
```

- SECRETS plaintext = `{ mnemonics: { [id]: mnemonic } }`. Names/flags are cleartext by
  design (locked screen shows wallet names + backup badges; same posture as MetaMask's
  cleartext account labels). Mnemonics are the only secrets.
- **One master password** (unanimous across the benchmark). While unlocked, the app holds
  the derived non-extractable AES `CryptoKey` + the salt in page memory — metadata/secret
  changes re-encrypt with that key (fresh IV every write), no password re-prompt. The key is
  dropped on lock.
- `meta.wallets[]` order is display order. Wallet ids are `w<epoch-ish counter>`; never reuse.

### Module layout (keep node-testable)

- `keystore.js` (crypto + IDB, stays small): generalize to `encryptJson(obj, password)` /
  `decryptJson(blob, password)` (v2 wrapper of today's mnemonic functions — keep
  `encryptMnemonic`/`decryptMnemonic` exports working for the file format and old tests);
  add `encryptJsonWithKey(obj, key, saltB64)` / `decryptJsonWithKey(blob, key)` for
  re-encryption under the held CryptoKey; persistence gains `loadKeystoreAny()` returning
  the v2 `vault` record OR the legacy v1 `primary` record (v1 wins only if no v2 exists),
  `saveVaultRecord`, `deleteAllRecords`.
- `vault.js` (NEW, pure logic + injected storage): the vault manager. State machine over
  `{record, key, secrets}`. API (all return/accept plain data, storage injected for tests):
  `unlock(password)`, `lock()`, `createVault(password, firstWallet)`, `addWallet({name,
  mnemonic, backedUp})`, `renameWallet(id, name)`, `removeWallet(id)`, `setActive(id)`,
  `setBackedUp(id)`, `getMnemonic(id)`, `verifyPassword(password)` (for re-auth),
  `migrateV1(record, password)`.
- Unit tests: `test/vault.test.js` with an in-memory store adapter — round-trips, wrong
  password, migration, remove-last-wallet deletes the record, rename duplicate guard,
  re-encrypt-with-held-key round-trip. `keystore.test.js` keeps passing unchanged.

### v1 → v2 migration

- Detection: `loadKeystoreAny()` returns `{v:1}` → locked screen behaves as today (one
  unnamed wallet). On successful password entry: decrypt v1, build v2 vault with one wallet
  `{name: 'Wallet 1', createdAt: now, backedUp: false}` under the SAME password, save
  `vault`, delete `primary`. Loss-proof order: write v2, verify decrypt, then delete v1.
- Migrated wallets get `backedUp: false` deliberately — existing users get the quiz path
  (the whole point of map #92). The badge, not a modal, carries the nag.

## 2. Onboarding: reveal ceremony + skippable quiz (#95)

Create flow (inside the existing `w-connect-modal`, keeping today's overlay structure:
wallet opens immediately, backup flow overlays it — drivers depend on this):

1. **Create step**: name (default `Wallet N`) + master password (only asked when no vault
   exists; adding a wallet to an unlocked vault skips straight to reveal).
2. **Reveal step** (`w-backup-view`, rebuilt): 12 words in a numbered 3×4 grid, blurred via
   CSS; while blurred the grid renders DECOY words (random BIP39 words, re-rolled per open)
   so the blur can't be peeked through. "Tap to reveal" swaps in the real words. Warning
   copy above; **no copy-to-clipboard button**. Buttons: `Continue` → quiz, and a
   lower-emphasis `Remind me later` → skip.
3. **Quiz step**: 3 slots labeled with 3 distinct random indices (ascending, e.g. "Word #3,
   #7, #11"); choices are all 12 seed words shuffled as chips; clicking a chip fills the
   next empty slot (click a filled slot to clear it). `Verify` checks; on fail: error, slots
   cleared, indices re-randomized, chips re-shuffled — unlimited retries. `Remind me later`
   here too. Pass → `setBackedUp(id)` + success beat → close.
4. **Skip** (`Remind me later` — keep the DOM id `w-backup-done` on it so existing drivers'
   one-click dismiss keeps working): wallet stays `backedUp:false`.

Re-entry: the "Not backed up" badge and a `Back up now` button (net-modal wallet section)
open the SAME reveal+quiz flow for the active wallet, gated by password re-auth (§5).
Restore-from-seed marks the new wallet `backedUp: true` (typing the words proves
possession). File import does NOT (§4).

**Seed handling rules (unchanged spirit):** real words exist in the DOM only while the
reveal step is open and revealed; wiped on close/lock/tab-blur (§5).

## 3. Backup-status surfacing (#95)

Per-wallet `backedUp` flag drives three surfaces (all live, re-rendered on wallet switch
and after quiz pass):

- **Badge**: persistent red `Not backed up` chip in the wallet header next to the address
  chip (id `w-backup-badge`), and per-wallet dots in the switcher list. Click → backup flow.
  Cleared ONLY by quiz pass.
- **Balance-gated banner**: when the active wallet is not backed up AND (DGB balance > 0 or
  any DD balance/position exists), show a dismissable-per-session warning strip under the
  header: "This wallet holds funds but has no backup — if this browser data is lost, the
  funds are gone. Back up now." (button opens backup flow).
- **Receive interception** (BlueWallet pattern, fires EVERY time until backed up): opening
  the receive modal on an un-backed-up wallet first shows a warning step inside the modal —
  "Back up before receiving funds" + `Back up now` / `Continue anyway`. `Continue anyway`
  proceeds to the normal receive view for that open only.

No timer-based reminder modals (rejected: no honest scheduler in a browser).

## 4. Keystore file export / import (#96)

- **Format** (versioned envelope around the existing blob crypto, PBKDF2-600k → AES-GCM):

```json
{ "format": "diginaut-keystore", "v": 1, "name": "Wallet 1",
  "network": "mainnet|testnet|null", "exportedAt": "2026-07-15T…Z",
  "kdf": {…}, "cipher": {…} }
```

  Ciphertext = the single wallet's mnemonic under the **master password** (fresh salt/IV,
  never the vault's). Filename `diginaut-<name-slug>-<yyyymmdd>.keystore.json`, download
  via Blob URL.
- **Export UX**: per-wallet action in the wallet manager. Requires typing the password
  (re-auth §5 — also proves the user can decrypt what they save). Messaged as SECONDARY:
  "An encrypted copy of this wallet. It only opens with your password — it is NOT a
  replacement for the seed phrase." Export does NOT set `backedUp`.
- **Import UX**: third option in the connect modal (`Restore from backup file`) and in the
  wallet manager's Add menu: file picker → parse+validate envelope (clear errors for wrong
  format/version) → prompt for the FILE's password → decrypt → add as new wallet (name from
  envelope, de-duplicated; `backedUp:false`) → switch to it. Importing a mnemonic already in
  the vault → friendly "already have this wallet" + switch. Network mismatch (envelope vs
  current chain) → warn, allow (mnemonics are network-agnostic; addresses differ).

## 5. Session security (#97)

- **Auto-lock**: default **5 minutes** of inactivity; ladder `1 / 5 / 15 / 30 / Never`
  (minutes) as a select in the net-modal wallet section, persisted in `localStorage`
  (`diginaut.autolock`, device-scoped, not in the vault). Activity = pointerdown/keydown
  on the document (throttled). Timer only runs while unlocked; firing calls `lockWallet()`.
- **Reveal re-auth**: `Show seed phrase` and keystore export and backup-flow re-entry all
  require typing the master password (verified via `verifyPassword` — a decrypt probe, no
  state change). Reveal uses the same blur + decoy-word ceremony as onboarding; auto-hides
  after 60 s and on `visibilitychange` (tab blur wipes `w-seed-words`, `w-backup-words`
  and re-blurs).
- **Remove wallet** (per-wallet, from the wallet manager): danger dialog stating the
  wallet's balance (if known) and backup status ("this wallet is NOT backed up — removing
  it without the seed phrase means the funds are unrecoverable"), confirmed by **typing the
  wallet's name**. Removing the last wallet deletes the vault record entirely → `none` state.
- **Global reset** (locked screen only, MetaMask pattern): today's `w-forget` link becomes
  "Erase all wallets on this device" → danger dialog listing wallet names + type `ERASE`
  to confirm → `deleteAllRecords()` → `none`.

## 6. Copy pass (#95/#63)

- Disclaimer modal bullet "Keys live only in this browser; no backup — clear browser data /
  lose device = funds gone." becomes: "Keys live only in this browser. Back up each wallet's
  seed phrase (Settings → Back up) — clearing browser data or losing this device without a
  backup means the funds are gone."
- All new warning copy is plain, non-jargon, and consistent in tone with the beta posture UI.

## 7. Multi-wallet UI (#94)

- **Switcher**: clicking the header address chip (`w-chip`) opens a wallet menu (new small
  modal `wallet-modal`): list of wallets — name, truncated address (derived lazily only for
  the active/unlocked vault: show name + backup dot only, address for active), active check,
  `Not backed up` dot. Row click switches active wallet (`setActive` + `openWallet` with the
  new mnemonic — full re-render, history/positions reset exactly like today's lock/unlock
  path, reusing `lockWallet()`'s state-reset guts WITHOUT dropping the vault key). Footer
  actions: `Add wallet` (→ connect modal in create/restore/import mode), `Manage` per-row:
  rename inline (duplicate-name guard), `Export backup file`, `Remove…`.
- **Locked screen**: shows wallet names ("3 wallets · Wallet 1, Trading, …") and ONE
  password field. Unlock decrypts the vault and opens `meta.activeId`.
- **Lock semantics**: lock is global (drops vault key + all mnemonics + per-UTXO key state
  via the existing reset* calls). Switching wallets never leaves the previous wallet's send
  drafts alive (`resetSend/Mint/Transfer/Redeem` on every switch).
- The single-wallet UX must not regress: with one wallet the switcher still works but
  nothing requires it; no new mandatory steps in the happy path.

## 8. Driver / test impact (S7)

- `verify-ui.mjs`: update the create flow for the reveal step (click `w-backup-done` =
  Remind-me-later fast path), keep all 18 checks green; add checks for badge presence after
  skip.
- Other verify-* drivers that create/unlock wallets: audit `scripts/lib` + each driver's
  prologue; the skip path must remain ONE extra click at most (id kept stable on purpose).
- NEW `verify-wallet-mgmt.mjs` (mock mode): create w/ quiz pass (badge absent) → create 2nd
  wallet w/ skip (badge present) → switch → rename → export file → remove w/ type-name →
  re-import exported file → migration check (seed a v1 record via page JS, unlock, assert
  v2 + wallet present) → reveal re-auth (wrong password rejected) → receive interception →
  auto-lock (set 1-minute ladder step with a shortened test hook `?autolockSecs=2` query
  override, assert lock fires).
- Unit suites stay green: `node --test` in `apps/wallet` (all existing files) +
  new `vault.test.js`. digidollar-js suite untouched.

## Stage plan (sequential, each stage commits, unit tests green before commit)

- **S1** keystore.js v2 + vault.js + vault.test.js + migration (no UI).
- **S2** onboarding reveal/quiz/skip + backedUp wiring + restore-marks-backed-up +
  re-entry flow + reveal re-auth ceremony (touches connect modal, net modal).
- **S3** multi-wallet: switcher modal, add/rename/remove ceremonies, locked-screen names,
  v1 migration wiring in unlock path, switch semantics.
- **S4** keystore file export/import.
- **S5** session security: auto-lock ladder + visibilitychange hide + global reset ceremony.
- **S6** badges, balance-gated banner, receive interception, copy pass.
- **S7** drivers: verify-ui update + verify-wallet-mgmt.mjs + audit other drivers; full
  suite + drivers run.

Rules for every stage: match existing code style (vanilla JS, no deps, comment density as
in app.js); never leave a mnemonic in the DOM outside an open reveal view; keep existing
element ids stable unless the spec renames them; `node --test` green before each commit.
