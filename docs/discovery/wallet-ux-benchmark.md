# Wallet UX benchmark: backup & wallet management

Date: 2026-07-14. Input for the backup/multi-wallet/session-security work already decided in
direction (multi-wallet IN, skippable verification + persistent not-backed-up badge, encrypted
keystore file export/import IN, session security IN). This doc picks the concrete pattern to copy
or reject in each area.

**Surveyed** (primary sources only — source code and first-party docs):

| Wallet | Source type | Provenance |
|---|---|---|
| MetaMask extension | code (v13.41.0, `MetaMask/metamask-extension@2e477542`) + support.metamask.io | paths relative to repo root |
| Rainbow | code (`rainbow-me/rainbow@main`, cloned 2026-07-14) + rainbow.me/support | paths relative to repo root |
| BlueWallet | code (`BlueWallet/BlueWallet@master`, cloned 2026-07-14) + bluewallet.io | paths relative to repo root |
| Phantom | closed source — help.phantom.com articles (fetched via Zendesk API, June–July 2026 revisions) | URLs |
| Trust Wallet | closed source — support.trustwallet.com (new Intercom help center; the old Freshdesk/community URLs are 404/410 Gone) + trustwallet.com/blog | URLs |
| DigiByte Android | code, local checkout `~/devel/digibytewallet-android` (Kotlin/Compose + C SPV core) | paths relative to that repo root |

Diginaut status quo, for reference (this repo): seed shown once at creation with a single
"I saved it — continue" click (`apps/wallet/public/index.html:427-429`), "Show seed phrase"
toggle with **no re-auth** while unlocked (`apps/wallet/public/app.js:642-648`), "Erase this
wallet" link that deletes the keystore with **zero confirmation** (`apps/wallet/public/app.js:607-611`).
Anything a primary source didn't establish is marked **UNVERIFIED**; where a wallet simply lacks a
feature that is stated — absence is data.

---

## 1. Seed backup at creation

| Wallet | Reveal ceremony | Verification quiz | Skip path | Source |
|---|---|---|---|---|
| MetaMask | SRP hidden behind blur, "Tap to reveal" / "Make sure no one is watching your screen"; the blurred words are **fake decoys** to defeat blur-reversal attacks; Continue disabled until revealed | 3 words of 12 at **random positions**, click candidate words into blanked slots ("Select the missing words in the correct order"); unlimited retries, positions **re-randomized each attempt**; pass sets `seedPhraseBackedUp: true` | "Remind me later" button → `setSeedPhraseBackedUp(false)`, wallet fully usable | `ui/pages/onboarding-flow/recovery-phrase/recovery-phrase-chips.tsx:39-53,150-156,250-291`; `confirm-recovery-phrase.tsx:51,53-76,131,161`; `review-recovery-phrase.tsx:136,270,275-284` |
| Phantom | Extension-only for SRP wallets; phrase shown after password set; "A private moment… make sure no one can see your screen" | **None documented** — only "Click I saved my Recovery Phrase and confirm" | n/a (attestation only) | [Create with SRP](https://help.phantom.com/hc/en-us/articles/45135465489555) |
| Rainbow | **No ceremony at creation** — wallet created instantly, seed never shown; backup prompted later per session. Reveal (when user initiates): 4-bullet warning page → plain word grid **with a "Copy to Clipboard" button**; no blur, no capture protection | **None** (repo-wide grep) — self-attestation button "I've saved these words" | Whole backup skippable; dismissal recorded, re-prompts on escalating cooldown `1 week × (times prompted + 1)` | `src/screens/AddWalletSheet.tsx:43-55`; `SecretWarning.tsx:50-83`; `SecretDisplaySection.tsx:119-127`; `SessionEntryPromptSync.tsx:57-84`; `backupsStore.ts:35-40` |
| Trust Wallet | Backup **deliberately deferred out of onboarding** ("you won't immediately be asked to back up… during setup"); reveal later blocks screenshots/recordings; checkbox gate before reveal (count/copy UNVERIFIED) | When user initiates backup: re-select words in correct order (extension); older documented flow: 4 random words in shown order | Entire backup skipped by design at creation | [Create multi-coin wallet](https://support.trustwallet.com/en/articles/717103-how-to-create-a-multi-coin-wallet-a-step-by-step-guide); [Backup recovery phrase](https://support.trustwallet.com/en/articles/717171-how-to-backup-your-recovery-phrase-in-trust-wallet); [blog backup guide](https://trustwallet.com/blog/guides/how-to-backup-your-recovery-phrase-and-export-private-keys-in-trust-wallet) |
| BlueWallet | Seed shown immediately post-creation; screenshots/recording **actively blocked** (`react-native-capture-protection`, default-on); mnemonic **copy-to-clipboard deliberately disabled** | **None** — single button "OK, I wrote it down." (which does *not* even set the backed-up flag) | Backup screen is unavoidable but attestation-free | `screen/wallets/PleaseBackup.tsx:37-40,50-57,67-75`; `hooks/useScreenProtect.ts`; `WalletExport.tsx:201` |
| DigiByte Android | FLAG_SECURE blocks screenshots for the screen's lifetime; notice "Screenshots are blocked. Write these words down…"; warning card ("Write it on paper — not digitally", …); "I have written these down" | **Mandatory**: 3 multiple-choice questions ("What is word #N?"), 4 options each, decoys drawn from full BIP39 list **excluding the user's phrase** (no adjacent-word leakage); positions spread evenly (3/7/11 for 12-word); must get all 3; unlimited retries | **No skip** — quiz gates PIN setup and wallet creation | `app/src/main/java/io/digibyte/ui/onboarding/SeedDisplayScreen.kt:41-50,119,157-194`; `SeedVerifyScreen.kt:33-35,307-342` |

**Consensus:** there is no consensus on the quiz — MetaMask, Trust and DigiByte quiz;
Phantom, Rainbow and BlueWallet self-attest. But among the quizzers the shape converges: **3–4
words, selection (never typing), unlimited retries**. On the reveal itself the converging
pattern is hide-until-deliberate-action plus an anti-capture measure (mobile: OS-level blocking;
extension: MetaMask's blur with decoy words), and the strictest wallets refuse to offer
copy-to-clipboard for the mnemonic.

**Recommended default for Diginaut.** Copy MetaMask's reveal: words blurred until an explicit
"Tap to reveal" click, with decoy words rendered under the blur (a browser can't block
screenshots, so the decoy trick is the only defense that actually works there — cheap and
verbatim-copyable). Reject Rainbow's copy-to-clipboard button; follow BlueWallet's no-copy
stance. Quiz: MetaMask's 3-random-positions click-into-slot design (candidates = the 3 removed
words, re-randomized on retry, unlimited retries) — it is the lightest quiz that still proves
the words left the screen; reject DigiByte's mandatory gate since skippability is already
decided, and reject typing-based verification entirely (nobody surveyed types). Skip = one
"Remind me later" text link that sets `backedUp: false` (§2).

---

## 2. Backup-status surfacing

| Wallet | Surfacing | What clears it | Source |
|---|---|---|---|
| MetaMask | Four surfaces: (1) home banner "Back up your Secret Recovery Phrase to keep your wallet and funds secure" — shown **only when balance is nonzero** and not dismissed; (2) recurring "Protect your wallet" modal — first after **2 days, then every 90 days**; (3) Settings row red tag **"Back up incomplete"**; (4) per-SRP list red "Backup" vs gray "Reveal" | Re-entering the reveal + 3-word quiz and **passing** (`isFromReminder=true` route); banner alone dismissible without backing up | `seed-phrase-backup-notification-container.tsx:41-48`; `ui/selectors/multi-srp/multi-srp.ts:60-110`; `ui/selectors/selectors.js:2415-2424`; `manage-wallet-recovery-item.tsx:51-69`; `srp-card.tsx:141-160` |
| Phantom | **None documented** — no badge/banner/reminder in any official article | n/a | [View recovery phrase](https://help.phantom.com/hc/en-us/articles/25334064171795) (posture is purely instructional) |
| Rainbow | Per-wallet `backedUp`/`backupType` flags; red **"Not backed up"** label in Settings → Wallets & Backup; per-wallet header "This Secret Phrase isn't backed up. Back up now…"; cloud pills Up to Date / Out of Date; session prompt with escalating cooldown (§1) | Manual: tapping "I've saved these words" (pure attestation, no quiz). Cloud: successful encrypted upload | `WalletsAndBackup.tsx:348,493,611`; `ViewWalletBackup.tsx:330-343`; `useWalletManualBackup.ts:8-10`; `backup.ts:218-221`; [rainbow.me/support — importance of backups](https://rainbow.me/support/app/the-importance-of-backups) |
| Trust Wallet | Per-wallet "Back up your Secret Phrase" CTA next to un-backed-up wallets in Manage Wallets; no persistent badge/cadence documented (UNVERIFIED beyond this) | UNVERIFIED | [Backup recovery phrase](https://support.trustwallet.com/en/articles/717171-how-to-backup-your-recovery-phrase-in-trust-wallet) |
| BlueWallet | **No badge at all** — instead a hard interception: opening Receive/addresses (or Lightning invoices) with `userHasSavedExport == false` throws a blocking alert "Have you saved your wallet's backup phrase? … Without the backup phrase, your funds will be permanently lost." with "Yes, I have." / "No, I have not." (→ seed screen) | "Yes, I have." attestation, or wallet import (auto-marked saved) | `class/wallets/abstract-wallet.ts:47,65,92,96`; `hooks/useExtendedNavigation.ts:12-13,117-128`; `helpers/presentWalletExportReminder.ts`; `StorageProvider.tsx:469` |
| DigiByte Android | None needed — backup verification is mandatory at creation, so a not-backed-up state cannot exist | n/a | `SeedVerifyScreen.kt` (no skip path); repo-wide grep for backed-up flags is empty |

**Consensus:** wallets that allow skipping all track a per-wallet boolean and surface it
persistently where wallets are listed (Rainbow, Trust, MetaMask's SRP list). The two
escalation ideas worth stealing: MetaMask gates its loudest surface on **nonzero balance**
(don't nag empty wallets), and BlueWallet **intercepts the receive flow** — the exact moment
funds are about to become real. Attestation-only clearing (Rainbow, BlueWallet) is the weak
end; MetaMask is alone in requiring a quiz pass to clear.

**Recommended default for Diginaut.** Per-wallet `backedUp` flag; persistent badge ("Not backed
up", red) on the wallet header and next to each wallet in the switcher (Rainbow/Trust pattern).
Escalate MetaMask-style: once the wallet's balance is nonzero, add a dismissible banner with a
"Back up now" button; re-show on unlock rather than on a timer (a browser wallet has no
background scheduler — reject MetaMask's 2d/90d modal cadence as machinery we can't honestly
run). Copy BlueWallet's interception at the receive screen: first "Receive" click on an
un-backed-up wallet interposes the backup prompt. Clear the badge **only on quiz pass**
(MetaMask), never on mere re-view or attestation — we already ship the quiz, so attestation-only
clearing (Rainbow) buys nothing. Keystore export does not clear it (§4).

---

## 3. Multi-wallet management

| Wallet | Model & switcher | Naming | Password | Removal guards | Source |
|---|---|---|---|---|---|
| MetaMask | One vault, one password, multiple SRPs ("wallets") each with N accounts; imported SRPs auto-named "Secret Recovery Phrase N" and **assumed backed up** (reminder applies to primary SRP only) | Free-form per-account rename with duplicate guard ("This name is already in use.") | **One master password** for the whole vault | SRP-derived accounts and whole SRPs **not removable** — only full wallet reset; removable account types get a danger modal "Make sure you have the Secret Recovery Phrase or private key… before removing", no type-to-confirm | `multi-srp.ts:79`; `multichain-account-edit-modal.tsx:82-90`; `multichain-account-details-page.tsx:83`; `account-remove-modal.tsx` |
| Phantom | Wallet → accounts → addresses; multiple seeds via "Import Recovery Phrase" (kept separate, **not restored after reset** — must re-import); switcher via profile avatar; drag-to-reorder | Per-account rename + avatar ("private and not visible to anyone else") | One extension password / device auth | Remove Account → Confirm; **cannot remove the last account**; derived accounts re-creatable deterministically; whole-seed removal is a separate Settings action with "Only remove a recovery phrase if you have it backed up securely offline." | [Wallets/accounts/addresses](https://help.phantom.com/hc/en-us/articles/45465816962579); [Add wallets](https://help.phantom.com/hc/en-us/articles/28355310978067); [Manage accounts](https://help.phantom.com/hc/en-us/articles/28355057809299); [Remove a recovery phrase](https://help.phantom.com/hc/en-us/articles/48839683247763) |
| Rainbow | Switcher sheet from profile avatar; per-address context menu Edit/Notifications/Remove | Per-address label + color/avatar | OS keychain; no wallet password; one global cloud-backup password | Action sheet "Are you sure you want to remove this wallet?" — **no balance check, no forced seed view**; removal mostly sets `visible: false`; last wallet → keys wiped, back to Welcome | `ChangeWalletSheet.tsx:361-378,460-500`; `useDeleteWallet.ts:18-44` |
| Trust Wallet | Up to **15 wallets**, each its own seed ("back up each one individually"); switcher = wallet name at top | Rename via wallet → ⋯ → Name | One app-level passcode | Trash-can "Delete Wallet" → confirm; "Deletion is final once confirmed"; PIN re-auth before delete UNVERIFIED | [Multi-coin wallet](https://support.trustwallet.com/en/articles/717103-how-to-create-a-multi-coin-wallet-a-step-by-step-guide); [Safely delete a wallet](https://support.trustwallet.com/en/articles/717158-how-to-safely-delete-a-wallet-in-trust-wallet) |
| BlueWallet | Home screen **is** the wallet list (cards in a carousel; drawer on large screens) | Label edit in ManageWallets/WalletDetails | One optional storage-encryption password (whole app), never per-wallet | Strongest surveyed: (1) "Are you sure?" destructive alert; (2) biometric unlock if enabled; (3) **if balance > 0, type the exact balance in satoshis** ("In order to avoid accidental removal, please enter your wallet's balance of {n} satoshis."); does not offer seed view first | `WalletsList.tsx`; `WalletsCarousel.tsx`; `ManageWallets.tsx:506`; `WalletDetails.tsx:158-227`; [bluewallet.io/features](https://bluewallet.io/features/) |
| DigiByte Android | **Single-wallet by design** — no switcher, no wallet list | n/a | 6-digit PIN + optional biometric | n/a (whole-app wipe only, §5) | `ui/navigation/` (no multi-wallet routes); `SecuritySettingsScreen.kt` |

**Consensus:** unanimous on the password model — **every surveyed wallet uses one app-level
secret; none uses per-wallet passwords.** Switcher lives where identity lives (avatar/wallet
name in the header). Naming is free-form with a duplicate guard at best. Removal guards range
from a bare confirm (Rainbow, Trust) to BlueWallet's biometric + type-the-balance; MetaMask
dodges the problem by not allowing SRP removal at all.

**Recommended default for Diginaut.** One master password unlocking all wallets (unanimous
pattern; migrating the current single PBKDF2-encrypted mnemonic into a multi-entry vault under
the same password). Switcher as a header dropdown listing name + truncated fingerprint + backup
badge (§2) per wallet — Rainbow's per-wallet backup state in the list is the part to copy.
Default names "Wallet 1/2/…", rename inline with MetaMask's duplicate guard. Removal: reject
Rainbow/Trust's bare confirm and MetaMask's "can't remove" cop-out; adopt BlueWallet's
balance-aware ceremony adapted for a browser (no biometrics): confirm dialog stating the
wallet's balance and backup state, a "View seed phrase first" link, and — when balance > 0 or
`backedUp == false` — a type-to-confirm field (the wallet's name; typing a satoshi balance is
hostile for a fiat-denominated DigiDollar wallet). Removing the last wallet routes to the
create/restore screen, Rainbow-style.

---

## 4. Encrypted keystore / file export

| Wallet | Offering | Format & crypto | Messaging vs seed | Counts as backed up? | Source |
|---|---|---|---|---|---|
| MetaMask | **None user-facing.** Vault (password-encrypted, in extension local storage) is extractable only via a manual last-resort ritual + official Vault Decryptor tool; "Backup and sync" explicitly "doesn't back up your Secret Recovery Phrase" | browser `.ldb` files; not a product surface | n/a | n/a | `app/_locales/en/messages.json` (`backupAndSyncEnableDescription`); [support.metamask.io — recover SRP](https://support.metamask.io/) (vault-decryptor ritual) |
| Phantom | **None — explicitly unsupported**: "Phantom does not support restoring a wallet from an iCloud or Google Drive backup"; Google/Apple wallets use Phantom KMS enclaves instead | n/a | Export = phrase or per-network private key only | n/a | [Restore from iCloud/Drive?](https://help.phantom.com/hc/en-us/articles/48398730321811); [View recovery phrase](https://help.phantom.com/hc/en-us/articles/25334064171795) |
| Rainbow | First-class encrypted **cloud** backup (iCloud Documents / Google Drive, hidden scope), promoted as "Recommended for beginners." | All secrets JSON-serialized → AES with PBKDF2-derived key, **5,000 iterations** (Android; iOS native default UNVERIFIED), random 16-byte salt + 32-byte IV → `{cipher, iv, salt}` JSON, `backup_<timestamp>.json`; password **min 8 chars only**; "This password is not recoverable." | Cloud is the default path; manual seed is the alternative | **Yes** — upload flips wallets to `backedUp` (`'cloud'`) | `src/handlers/aesEncryption.ts:15-16`; `cloudBackup.ts:85-140,216-220`; `backup.ts:166-192,218-221,596-598`; `BackupCloudStep.tsx:123-130` |
| Trust Wallet | Optional encrypted cloud backup (Google Drive/iCloud) with a **separate encryption password** ("Never reuse your Google/iCloud password") | Encrypted copy of the 12-word phrase in the user's own cloud; algorithm/password rules UNVERIFIED (the detailed FAQ is 410 Gone) | Optional add-on to manual backup | UNVERIFIED | [Best practices for recovery phrase storage](https://support.trustwallet.com/en/articles/717106-best-practices-for-recovery-phrase-storage) |
| BlueWallet | **No cloud/file backup, deliberately.** Instead: whole-app storage encryption behind a password, plus **plausible deniability** (second password unlocks a decoy storage) | Local storage encryption toggle; export surface is QR + seed words + xpub/multisig files | Paper seed is the backup; encryption is framed as device security, "entirely separate" | Viewing export does **not** flip `userHasSavedExport` | `EncryptStorage.tsx:102-134,190-198`; `WalletExport.tsx`; `loc/en.json` (`plausibledeniability.*`) |
| DigiByte Android | None — seed encrypted via Android Keystore into SharedPreferences; no export beyond viewing the phrase | n/a | n/a | n/a | `SeedViewScreen.kt:52-66` |

**Consensus:** thin. Only Rainbow and Trust ship an encrypted secondary backup, both
cloud-based, both messaged as a convenience layered on (or ahead of) the paper seed, both
requiring a dedicated password that is explicitly non-recoverable. Rainbow's crypto is the
cautionary tale — **PBKDF2 at 5,000 iterations is ~120× weaker than Diginaut's existing 600k**.
Nobody surveyed offers a plain downloadable keystore file; Diginaut would be filling a real gap
(a browser wallet's IndexedDB is far more fragile than a phone keychain, so the feature is
better justified here than anywhere surveyed).

**Recommended default for Diginaut.** Ship the decided keystore file as a **download** (no cloud
account coupling): versioned JSON envelope `{version, createdAt, walletName, kdf: {PBKDF2,
iterations: 600000, salt}, cipher: {AES-256-GCM, iv}, ciphertext}` — i.e. the existing vault
crypto, serialized; import = the existing unlock path. Reuse the wallet password rather than a
second one (Rainbow/Trust need a separate password because they upload to third-party clouds; a
user-held file doesn't, and a second non-recoverable password doubles the ways to lose funds).
Copy Rainbow's copy line "This password is not recoverable" verbatim into the export dialog.
Message it as *secondary*: "a convenience copy — your seed phrase is still the only backup that
survives a forgotten password." Reject Rainbow's rule that an encrypted backup flips the wallet
to backed-up: the file dies with the password, so the not-backed-up badge (§2) clears only on
seed-quiz pass; show keystore export as a separate checkmark line in backup status instead.

---

## 5. Session security

| Wallet | Auto-lock | Re-auth before seed reveal | Erase/reset ceremony | Source |
|---|---|---|---|---|
| MetaMask | Default `0` = **Never**; options After 15 s / 30 s / 1 min / 5 min / Never | Three gates: 2-question security quiz ("If you lose your SRP, MetaMask… **Can't help you**"; "If anyone… asks for your SRP… **You're being scammed**") → password re-entry → decoy-blur "Tap to reveal" (+ phishing scan of active tab); hold-to-reveal long-press gates private-key export | "Forgot password?" → "We can't recover your password for you." → "Resetting will **permanently** delete all wallet data…" → red "Yes, reset wallet". Two modal steps, danger styling, **no type-to-confirm** | `shared/constants/preferences.ts:13`; `auto-lock-utils.ts`; `app-state-controller.ts:832-842`; `ui/pages/keychains/reveal-seed.tsx:96-150,306-324`; `quiz-question.tsx`; `hold-to-reveal-button.js`; `reset-password-modal.tsx:326` |
| Phantom | Immediately → 1 day (extension "Auto-Lock Timer", mobile "Require authentication"); default UNVERIFIED; security tips recommend Immediately | Extension: password re-entry → warning → Continue; mobile password step UNVERIFIED | "Reset App → Continue" — single confirmation; 7 wrong PIN attempts **wipes the device's encrypted backup** | [Turn on auto-lock](https://help.phantom.com/hc/en-us/articles/28951350406803); [Security tips](https://help.phantom.com/hc/en-us/articles/13515761228051); [View recovery phrase](https://help.phantom.com/hc/en-us/articles/25334064171795); [Reset app](https://help.phantom.com/hc/en-us/articles/18827673580563); [Google/Apple wallets](https://help.phantom.com/hc/en-us/articles/32775281256851) |
| Rainbow | **No app-wide auto-lock exists** | Enforced at OS keychain layer — Face ID/passcode fires on *every* seed read (`USER_PRESENCE` / `BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE`); Android sans biometrics falls back to a Rainbow PIN | Remove-wallet action sheet only (§3); no type-to-confirm | `src/features/local-auth/keychain.ts:399-414`; `pinAuthentication.ts`; `PrivacySection.tsx` (no lock settings) |
| Trust Wallet | App Lock: immediate → 5 h; default UNVERIFIED; app locks after **5 wrong passcode attempts**; no passcode recovery | PIN/password or biometric before reveal, always; private-key export buried in Developer Mode requiring auth **twice** | Delete Wallet → confirm ("final once confirmed") | [Security PIN](https://support.trustwallet.com/en/articles/717163-setting-up-or-resetting-a-security-pin-on-trust-wallet); [passcode blog](https://trustwallet.com/blog/security/how-to-enable-passcode-security-on-trust-wallet-ios-and-android); [Backup](https://support.trustwallet.com/en/articles/717171-how-to-backup-your-recovery-phrase-in-trust-wallet); [Export private keys](https://support.trustwallet.com/en/articles/717168-how-to-export-your-private-keys) |
| BlueWallet | Lock at launch (biometrics and/or storage password); no idle timer found (background-relock UNVERIFIED) | Biometric required before navigating to WalletExport/xpub/multisig screens; seed screen **auto-dismisses ~500 ms after app leaves foreground** | Per-wallet delete = biometric + type-the-balance (§3); decrypt-storage warning is the only global guard | `screen/UnlockWith.tsx:279`; `useExtendedNavigation.ts:10`; `WalletExport.tsx:99-108` |
| DigiByte Android | Default **60 s** (`autoLockTimeoutMs = 60_000L`); options 1 / 5 / 15 / 30 min | Warning dialog ("I Understand — Continue") → 6-digit PIN → **biometric** → FLAG_SECURE reveal screen | Wipe Wallet: PIN re-entry → red dialog "This cannot be undone… Make sure you have your recovery phrase backed up" → "Wipe Everything". No type-to-confirm, no balance check | `core/src/main/java/io/digibyte/core/db/entity/WalletConfigEntity.kt:13`; `SecuritySettingsScreen.kt:69-76,297-384,386-445` |
| Diginaut today | lock button only | **None** — toggle prints the in-memory mnemonic | **None** — link deletes keystore instantly | `apps/wallet/public/app.js:607-611,642-648` |

**Consensus:** every wallet except Diginaut re-authenticates before revealing the seed —
password/PIN at minimum, warning interstitial almost universal, and the stricter half adds a
second factor (MetaMask's quiz, DigiByte's biometric, Trust's double-auth for keys). Auto-lock:
mobile wallets default locked-ish (DigiByte 60 s; Phantom/Trust configurable down to
Immediately); MetaMask's Never default is the outlier the community routinely criticizes and
its own option list (15 s–5 min) contradicts. Erase ceremonies are surprisingly weak everywhere
— two-step danger dialogs; only BlueWallet types anything.

**Recommended default for Diginaut.** Auto-lock **default 5 minutes**, options 1 / 5 / 15 / 30
min / Never (DigiByte's ladder plus an explicit opt-out; reject MetaMask's Never-by-default —
an unlocked browser tab is the single most exposed surface we have). Lock on timer reset by
activity, and also wipe the decrypted key from memory on lock. Seed reveal: warning
interstitial ("Anyone with these words can take your DGB" — reuse DigiByte's copy) → **password
re-entry** → decoy-blur reveal (§1); auto-hide the revealed seed when the tab loses visibility
(BlueWallet's foreground-loss dismissal, translated to `visibilitychange`). Skip MetaMask's
2-question quiz at reveal time — right instinct, but two ceremonies deep it mostly teaches
users to click through. Erase: replace the bare link with (1) a danger dialog stating backup
status and last-known balance, (2) "View seed phrase first" link (requires password, so it only
appears on the unlocked path), (3) **type-to-confirm the wallet name** — stricter than anything
surveyed except BlueWallet, justified because our erase is reachable from the *locked* screen
where no password can gate it.

---

## Summary of recommendations

| # | Area | Copy | Reject |
|---|---|---|---|
| 1 | Seed backup at creation | MetaMask decoy-blur "Tap to reveal"; 3-random-word click-into-slot quiz, re-randomized, unlimited retries; "Remind me later" skip; BlueWallet's no-copy-button stance | Rainbow's Copy-to-Clipboard on the seed screen; typing-based verification; DigiByte's mandatory (unskippable) quiz |
| 2 | Backup-status surfacing | Per-wallet `backedUp` flag + persistent red badge (Rainbow/Trust); balance-gated escalation banner (MetaMask); receive-flow interception (BlueWallet); clears **only on quiz pass** (MetaMask) | Attestation-only clearing (Rainbow/BlueWallet); timer-based reminder modals (MetaMask 2d/90d — no honest scheduler in a browser) |
| 3 | Multi-wallet | One master password (unanimous); switcher in header with per-wallet backup badge; rename with duplicate guard (MetaMask); balance-aware removal ceremony (BlueWallet, adapted: type wallet name) | Per-wallet passwords (nobody does it); bare-confirm removal (Rainbow/Trust); forbidding removal (MetaMask) |
| 4 | Keystore file export | Versioned JSON envelope reusing existing PBKDF2-600k → AES-256-GCM; wallet password, not a second one; "not recoverable" warning copy (Rainbow); messaged as secondary to the seed (BlueWallet's framing) | Rainbow's 5k PBKDF2 iterations; cloud coupling; counting the file as "backed up" (Rainbow) |
| 5 | Session security | Auto-lock default 5 min with DigiByte's option ladder; password re-entry + warning before seed reveal (universal); auto-hide seed on tab blur (BlueWallet); erase = danger dialog + balance/backup statement + type wallet name | MetaMask's Never-default auto-lock; Diginaut's current zero-re-auth reveal and one-click erase; quiz-before-reveal (ceremony fatigue) |

Open items for the implementing issues: exact badge/banner copy; whether the receive-flow
interception fires once or every time until backed up (BlueWallet: every time); keystore file
extension/MIME (`.diginaut-keystore.json`?); where "Erase" lives once multi-wallet lands
(per-wallet remove vs global reset — recommend both, MetaMask-style reset only from the locked
screen).
