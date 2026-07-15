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

### Concurrency: revision control (multi-tab safety — S1, non-negotiable)

Two unlocked tabs doing blind read-modify-write on the single vault record is last-writer-
wins — the losing tab's freshly created mnemonic would vanish from the ciphertext while its
UI reports success. Therefore:

- The vault record carries a monotonically increasing `rev` (integer). `saveVaultRecord`
  is COMPARE-AND-SET: inside ONE IndexedDB readwrite transaction, re-read the stored `rev`;
  if it differs from the base `rev` the mutation was computed from, ABORT the transaction
  and throw `VaultConflictError` — never overwrite.
- On `VaultConflictError` the vault manager reloads the record and surfaces "This wallet
  was changed in another tab — reloading" (the UI relocks or refreshes state; it must NOT
  silently retry the stale write).
- A `BroadcastChannel('diginaut-vault')` message is posted after every successful write;
  other tabs listening refresh their in-memory record (and, if unlocked, re-decrypt with
  their held key) so stale bases are rare rather than routine.
- `vault.test.js` must cover: two managers over one store, interleaved writes → second
  write throws, no mnemonic lost.

### Key↔salt invariant (S1, non-negotiable)

The held session key MUST always be `PBKDF2(password, record.kdf.salt)` for the record
actually in storage. `createVault` and `migrateV1` therefore either (a) derive the key
FIRST from a fresh salt and encrypt with `encryptJsonWithKey`, or (b) have
`encryptJson` return `{blob, key}` so the caller holds the key matching the salt it just
generated. Never keep a key derived from an old salt (e.g. the v1 salt) after writing a
record that advertises a new one — the next `encryptJsonWithKey` write would brick the
vault (GCM auth failure on every future unlock, with the correct password).
`vault.test.js` must include the chained case: migrate v1 → mutate via held key →
re-unlock from storage → decrypt succeeds.

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
- **Interrupted-migration GC**: if BOTH `vault` and `primary` exist at boot, treat it as an
  incomplete migration. On the next successful unlock, probe-decrypt the v2 record: if it
  decrypts, delete the orphan v1; if it does NOT, fall back to unlocking the v1 record and
  redo the migration (overwriting the bad v2). `loadKeystoreAny` must therefore return both
  records when both exist. Test: seed both, unlock, assert one clean v2 and no orphan.
- **Raw-string v1 semantics**: real installed v1 blobs encrypt the mnemonic as a raw UTF-8
  string, NOT JSON. `decryptMnemonic` must keep returning that raw string even if it is
  reimplemented over `decryptJson` internals. Add a FROZEN v1 fixture blob (captured from
  the current keystore.js output, hardcoded in the test) asserting
  `decryptMnemonic(fixture, pw) === mnemonic` — same-code round-trip tests cannot catch
  this regression.
- `encryptMnemonic`/`saveKeystore`-equivalent primitives must remain importable from page
  context (the migration driver seeds a legacy `primary` record via page JS).
- Migrated wallets get `backedUp: false` deliberately — existing users get the quiz path
  (the whole point of map #92). The badge, not a modal, carries the nag.

## 2. Onboarding: reveal ceremony + skippable quiz (#95)

Create flow (inside the existing `w-connect-modal`, keeping today's overlay structure:
wallet opens immediately, backup flow overlays it — drivers depend on this):

**Modal-mode decoupling (blocker fix):** today `show(state)` force-hides `w-none` (which
contains every create/restore form) in all states except `none`, so an "Add wallet" opened
while `open` would render an empty modal. The connect modal gets its OWN mode state
(`choice | create | restore | import | backup`) decoupled from the app's
none/locked/open machine: `show()` keeps deciding whether the modal auto-opens, but the
modal's inner step visibility is driven solely by its mode. Add-wallet from the switcher
opens the modal in `create`/`restore`/`import` mode while the app stays `open`.

1. **Create step**: name (an `<input>` PRE-FILLED with the literal value `Wallet N` — not
   placeholder text; ~16 drivers click `w-create` having set only the passwords, so an
   untouched submit must succeed) + master password (password fields only shown/required
   when no vault exists; adding a wallet to an unlocked vault skips straight to reveal).
2. **Reveal step** (`w-backup-view`, rebuilt): 12 words in a numbered 3×4 grid, blurred via
   CSS; while blurred the grid renders DECOY words (random BIP39 words, re-rolled per open)
   so the blur can't be peeked through. "Tap to reveal" swaps in the real words. Warning
   copy above; **no copy-to-clipboard button**. Buttons: `Continue` → quiz, and a
   lower-emphasis `Remind me later` → skip.
3. **Quiz step**: 3 slots labeled with 3 distinct random indices (ascending, e.g. "Word #3,
   #7, #11"); chips are ONLY the 3 removed words plus 6 random BIP39 decoys, shuffled —
   NEVER the full seed in legible plaintext (that would defeat the reveal ceremony; matches
   the MetaMask design the benchmark recommends). Clicking a chip fills the next empty slot
   (click a filled slot to clear it). `Verify` checks; on fail: error, slots cleared,
   indices re-randomized, chips (removed words + fresh decoys) re-shuffled — unlimited
   retries. `Remind me later` here too. Pass → `setBackedUp(id)` + success beat → close.
4. **Skip** (`Remind me later` — keep the DOM id `w-backup-done` on it so existing drivers'
   one-click dismiss keeps working): wallet stays `backedUp:false`.

Re-entry: the "Not backed up" badge and a `Back up now` button (net-modal wallet section)
open the SAME reveal+quiz flow for the active wallet, gated by password re-auth (§5).
Restore-from-seed marks the new wallet `backedUp: true` (typing the words proves
possession). File import does NOT (§4).

Duplicate-mnemonic contract (defined ONCE on `vault.addWallet`, applies to restore-from-
seed AND file import alike): adding a mnemonic already in the vault does not create a
second entry — it returns the existing wallet's id; the UI shows "You already have this
wallet (<name>)" and switches to it.

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
  proceeds to the normal receive view for that open only. Gate this at the SHARED
  modal-open path so BOTH entry points pass through it — `act-receive` and
  `w-no-indexer-receive` (on a no-indexer deployment the balance-gated banner can never
  fire, so the interception is the only funds-arriving guard there).

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
  The `?autolockSecs=` test hook (§8) is honored ONLY in mock mode (`appConfig.mock`) and
  never on mainnet — a URL-controlled override on a live deployment would let a crafted
  link silently disable auto-lock.
- **Lock teardown**: locking (manual or auto) must also close the wallet switcher modal and
  any open backup/reveal overlay and wipe their word nodes — an auto-lock firing
  mid-ceremony must not leave a revealed seed or the old wallet's details floating over the
  locked screen.
- **Reveal re-auth**: `Show seed phrase` and keystore export and backup-flow re-entry all
  require typing the master password (verified via `verifyPassword` — a decrypt probe, no
  state change). Reveal uses the same blur + decoy-word ceremony as onboarding; auto-hides
  after 60 s and on `visibilitychange` (tab blur wipes `w-seed-words`, `w-backup-words`
  and re-blurs).
- **Remove wallet** (per-wallet, from the wallet manager): danger dialog stating the
  wallet's balance (if known) and backup status ("this wallet is NOT backed up — removing
  it without the seed phrase means the funds are unrecoverable"), confirmed by **typing the
  wallet's name**. Removing the last wallet deletes the vault record entirely → `none`
  state. Removing the ACTIVE wallet (non-last) reassigns `meta.activeId` to the adjacent
  wallet in display order and immediately re-runs the switch path (state reset +
  `openWallet` of the new active) — the open view must never keep showing a removed wallet.
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
- **Known breakage to fix explicitly** (found by spec review — do not rediscover the hard
  way):
  - *Show-seed re-auth* (§5) breaks every driver that clicks `w-backup` and reads
    `w-seed-words` bare — verify-ui.mjs (seed capture + restore round-trip) and
    verify-walkthrough.mjs (`mnemonicA` capture + later restore). New driver sequence:
    enter master password in the re-auth prompt → click Tap-to-reveal → read words. After
    reveal, `w-seed-words` MUST contain the REAL mnemonic (decoys only while blurred) so
    capture-and-restore round-trips keep working. verify-public.mjs captures the seed too
    (word-count check only) — update its sequence, no round-trip there.
  - *Global-reset ceremony* (§5) breaks every driver that does `w-forget.click()` →
    expect `w-none`: verify-ui.mjs, verify-walkthrough.mjs (twice), verify-public.mjs,
    verify-transfer.mjs. Each needs the new steps (open ceremony → type `ERASE` → confirm).
  - *Create-step name field* must be pre-filled (§2.1) so the ~16 drivers that set only
    passwords and click `w-create` keep passing unmodified.
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
