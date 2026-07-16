// Wallet management v2 (docs/specs/wallet-management-v2.md, S7): drive the
// whole multi-wallet surface through the UI in mock mode — create with a
// PASSED quiz (badge absent) → add a second wallet with skip (badge present)
// → switch → rename (duplicate guard) → keystore-file export (re-auth) →
// remove with the type-the-name ceremony → re-import the exported file →
// v1→v2 migration (legacy record seeded via page JS) → reveal re-auth
// (wrong password rejected) → receive interception → inactivity auto-lock
// via the mock-only ?autolockSecs= test hook.
//
// Self-contained except Chrome (the wallet server runs in-process, mock node,
// no indexer). Setup:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
//     --remote-debugging-port=9224 --user-data-dir=$(mktemp -d) --no-first-run about:blank &
//   node apps/wallet/scripts/verify-wallet-mgmt.mjs   # exit 0 = all green
// A fresh user-data-dir gives a fresh IndexedDB ("no wallet" state) — required.
import { once } from 'node:events';
import { mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS } from 'digidollar-js';
import { startServer } from '../server.js';
import { connectCdp } from './lib/cdp.mjs';

const PASS = 'wallet mgmt pass';
// BIP39 test vector — the legacy v1 record the migration leg seeds via page JS
const V1_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const V1_ADDR = deriveTaprootAddress(mnemonicToSeed(V1_MNEMONIC), { ...HD_NETWORKS.testnet, index: 0 }).address;

const server = startServer({ port: 0, rpc: { user: '', pass: '' } }); // mock node (chain 'test'), no indexer
await once(server, 'listening');
const APP = `http://127.0.0.1:${server.address().port}`;

const b = await connectCdp();
const { evaluate, waitFor, shot, text, setVal, click, check } = b;
const visible = (id) => `document.getElementById('${id}').style.display !== 'none'`;
const modalOpen = (id) => `document.getElementById('${id}').classList.contains('open')`;
// the ceremony grids join words with newlines — normalize to single spaces
const grid = async (id) => (await evaluate(text(id))).trim().split(/\s+/).join(' ');

// ================= 1. Create wallet 1 → reveal → quiz PASS → badge absent =================
await b.navigate(APP);
await waitFor(visible('w-none'), 'no-wallet state');
await click('hero-connect');
await waitFor(modalOpen('w-connect-modal'), 'connect modal open');
await click('w-create-choice');
check((await evaluate(`document.getElementById('w-create-name').value`)) === 'Wallet 1',
  'create step pre-fills the name field with "Wallet 1" (untouched submit must succeed)');
await setVal('w-create-pass', PASS);
await setVal('w-create-pass2', PASS);
await click('w-create');
await waitFor(visible('w-open'), 'wallet open under the ceremony overlay');
await waitFor(visible('w-backup-view'), 'reveal step overlays the open wallet');
check(await evaluate(`document.getElementById('w-backup-reveal').classList.contains('blurred')`),
  'reveal starts blurred (decoy words, no copy button)');
const decoys = await grid('w-backup-words');
await click('w-backup-show');
const words = (await grid('w-backup-words')).split(' ');
check(words.length === 12 && words.join(' ') !== decoys,
  'tap-to-reveal swaps the decoys for the real 12 words');
await shot('90-mgmt-reveal.png');
await click('w-backup-continue');
await waitFor(visible('w-quiz-view'), 'quiz step');
// the chips are the 3 removed words + 6 decoys — never the full seed
check(await evaluate(`document.querySelectorAll('#w-quiz-chips [data-chip]').length === 9`),
  'quiz offers 9 chips (3 removed words + 6 decoys), not the full seed');
// solve it: each slot names its word index ("Word #7" → words[6]); chips fill
// the next empty slot in order, so click them in slot order
await evaluate(`{
  const words = ${JSON.stringify(words)};
  const idxs = [...document.querySelectorAll('#w-quiz-slots .qn')].map((e) => Number(e.textContent.match(/\\d+/)[0]) - 1);
  for (const n of idxs) {
    [...document.querySelectorAll('#w-quiz-chips [data-chip]')]
      .find((c) => !c.disabled && c.textContent === words[n]).click();
  }
}`);
await shot('91-mgmt-quiz.png');
await click('w-quiz-verify');
await waitFor(visible('w-backup-success'), 'quiz pass → success beat');
await click('w-backup-success-done');
await waitFor(`!${modalOpen('w-connect-modal')}`, 'ceremony closed');
check(!(await evaluate(visible('w-backup-badge'))), 'quiz pass clears the "Not backed up" badge');
check((await evaluate(text('w-backup-words'))) === '', 'no seed words left in the ceremony DOM');
const addr1 = await evaluate(text('w-address'));

// ================= 2. Add a second wallet, SKIP the quiz → badge present =================
await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'wallet switcher opens from the address chip');
check(await evaluate(`document.querySelectorAll('#w-wallet-list [data-switch]').length === 1`),
  'switcher lists the single wallet');
await click('w-add-wallet');
await waitFor(modalOpen('w-connect-modal'), 'add-wallet reuses the connect modal while the app stays open');
check(await evaluate(`document.getElementById('w-pass-fields').style.display === 'none'`),
  'no master-password fields for a second wallet (vault already unlocked)');
await click('w-create-choice');
check((await evaluate(`document.getElementById('w-create-name').value`)) === 'Wallet 2', 'name pre-fills "Wallet 2"');
await click('w-create');
await waitFor(visible('w-backup-view'), 'ceremony for wallet 2');
await click('w-backup-done'); // Remind me later — the badge carries the nag
await waitFor(`!${modalOpen('w-connect-modal')}`, 'skip closes the ceremony');
check(await evaluate(visible('w-backup-badge')), 'skip leaves the "Not backed up" badge on');
await waitFor(`${text('w-address')} !== ${JSON.stringify(addr1)}`, 'wallet 2 derives its own address');
const addr2 = await evaluate(text('w-address'));
await shot('92-mgmt-skip-badge.png');

// ================= 3. Switch back to wallet 1 =================
await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'switcher open again');
check(await evaluate(`document.querySelectorAll('#w-wallet-list .wal-dot').length === 1`),
  'exactly one not-backed-up dot in the list (wallet 2)');
await evaluate(`document.querySelector('#w-wallet-list [data-switch]').click()`); // first row = Wallet 1
await waitFor(`${text('w-address')} === ${JSON.stringify(addr1)}`, 'switch re-opens wallet 1');
check(!(await evaluate(visible('w-backup-badge'))), 'badge follows the active wallet: wallet 1 is backed up');
check(!(await evaluate(modalOpen('wallet-modal'))), 'switching closes the switcher');

// ================= 4. Rename wallet 2 (duplicate-name guard) =================
await click('w-chip');
await waitFor(modalOpen('wallet-modal'), 'switcher open for manage');
await evaluate(`document.querySelectorAll('#w-wallet-list [data-manage]')[1].click()`);
await waitFor(`document.getElementById('w-rename-input') !== null`, 'manage row expanded');
await setVal('w-rename-input', 'Wallet 1');
await click('w-rename-go');
await waitFor(`${text('w-wallet-err')}.length > 0`, 'duplicate rename rejected');
check((await evaluate(text('w-wallet-err'))).includes('already exists'),
  'duplicate-name rename rejected: ' + await evaluate(text('w-wallet-err')));
await setVal('w-rename-input', 'Trading');
await click('w-rename-go');
await waitFor(`${text('w-wallet-list')}.includes('Trading')`, 'rename landed');
check(true, 'wallet 2 renamed to "Trading"');

// ================= 5. Export the keystore file (re-auth gated) =================
// capture the Blob download in-page: keep the object URL machinery but swallow
// the anchor click so headless Chrome never writes a file
await evaluate(`{
  window.__downloads = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { blob.text().then((t) => window.__downloads.push(t)); return orig(blob); };
  HTMLAnchorElement.prototype.click = function () {};
}`);
await evaluate(`document.querySelectorAll('#w-wallet-list [data-manage]')[1].click()`);
await waitFor(`document.getElementById('w-export-go') !== null`, 'manage row expanded for export');
await click('w-export-go');
await waitFor(modalOpen('reauth-modal'), 'export demands the password');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(`window.__downloads && window.__downloads.length === 1`, 'keystore file produced');
const envelope = JSON.parse(await evaluate(`window.__downloads[0]`));
check(envelope.format === 'diginaut-keystore' && envelope.v === 1 && envelope.name === 'Trading',
  `export envelope is a v1 diginaut-keystore for "Trading" (network ${envelope.network})`);
check((await evaluate(text('w-wallet-note'))).includes('only opens with your password'),
  'export messaging stays secondary: file opens only with the password');

// ================= 6. Remove "Trading" — type-the-name ceremony =================
await evaluate(`document.querySelectorAll('#w-wallet-list [data-manage]')[1].click()`);
await waitFor(`document.getElementById('w-remove-open') !== null`, 'manage row expanded for remove');
await click('w-remove-open');
await waitFor(visible('w-remove-view'), 'remove ceremony shown');
check((await evaluate(text('w-remove-warnings'))).includes('NOT backed up'),
  'remove ceremony warns: this wallet is NOT backed up');
await setVal('w-remove-name', 'Traidng'); // typo must not arm the button
check(await evaluate(`document.getElementById('w-remove-go').disabled`),
  'remove button armed only by the exact wallet name');
await setVal('w-remove-name', 'Trading');
await shot('93-mgmt-remove.png');
await click('w-remove-go');
await waitFor(`document.querySelectorAll('#w-wallet-list [data-switch]').length === 1`, 'wallet removed from the list');
check((await evaluate(text('w-address'))) === addr1, 'the open view still shows wallet 1 (removed a non-active wallet)');

// ================= 7. Re-import the exported file =================
await click('w-add-wallet');
await waitFor(modalOpen('w-connect-modal'), 'connect modal for import');
await click('w-show-import');
await waitFor(visible('w-import'), 'import step');
await evaluate(`{
  const input = document.getElementById('w-import-file');
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(JSON.stringify(envelope))}], 'trading.keystore.json', { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}`);
await waitFor(`${text('w-import-info')}.includes('Trading')`, 'envelope parsed: name shown');
await setVal('w-import-pass', PASS);
await click('w-import-go');
await waitFor(`${text('w-address')} === ${JSON.stringify(addr2)}`, 're-import re-derives the exported wallet');
check(await evaluate(visible('w-backup-badge')),
  'file import does NOT count as a backup — badge is back (spec §4)');

// ================= 8. v1 → v2 migration (legacy record seeded via page JS) =================
await evaluate(`(async () => {
  const ks = await import('/keystore.js');
  await ks.deleteAllRecords();
  await ks.saveKeystore(await ks.encryptMnemonic(${JSON.stringify(V1_MNEMONIC)}, ${JSON.stringify(PASS)}));
})()`);
await b.navigate(APP);
await waitFor(visible('w-locked'), 'legacy v1 record boots into the locked state');
check(await evaluate(`document.getElementById('w-locked-names').style.display === 'none'`),
  'no wallet names on the locked screen for a not-yet-migrated v1 record');
await setVal('w-unlock-pass', PASS);
await click('w-unlock');
await waitFor(visible('w-open'), 'unlock migrates and opens');
check((await evaluate(text('w-address'))) === V1_ADDR, 'migrated wallet derives the v1 mnemonic\'s address');
const stored = await evaluate(`(async () => {
  const ks = await import('/keystore.js');
  const { vault, primary } = await ks.loadKeystoreAny();
  return { v: vault?.v, name: vault?.meta?.wallets?.[0]?.name, backedUp: vault?.meta?.wallets?.[0]?.backedUp, orphan: !!primary };
})()`);
check(stored.v === 2 && stored.name === 'Wallet 1' && !stored.orphan,
  `v1 record migrated to a v2 vault ("${stored.name}") and the v1 orphan is gone`);
check(stored.backedUp === false && await evaluate(visible('w-backup-badge')),
  'migrated wallet is backedUp:false — existing users get the badge/quiz path');
await shot('94-mgmt-migrated.png');

// ================= 9. Reveal re-auth: wrong password rejected =================
await click('w-backup');
await waitFor(modalOpen('reauth-modal'), 'reveal demands the password');
await setVal('reauth-pass', 'not the password');
await click('reauth-go');
await waitFor(`${text('reauth-err')}.length > 0`, 'wrong password rejected');
check((await evaluate(text('reauth-err'))) === 'wrong password' && !(await evaluate(visible('w-seed'))),
  'wrong re-auth password → "wrong password", seed stays hidden');
await click('reauth-cancel');
// and the right password reveals the ORIGINAL v1 words (decoys until tapped)
await click('w-backup');
await waitFor(modalOpen('reauth-modal'), 're-auth again');
await setVal('reauth-pass', PASS);
await click('reauth-go');
await waitFor(visible('w-seed'), 'seed view after re-auth');
check((await grid('w-seed-words')) !== V1_MNEMONIC, 'blurred grid holds decoys, not the seed');
await click('w-seed-show');
check((await grid('w-seed-words')) === V1_MNEMONIC, 'tap reveals the original v1 mnemonic (migration kept the secret)');
await click('w-backup');
check((await evaluate(text('w-seed-words'))) === '', 'hide wipes the words from the DOM');

// ================= 10. Receive interception (no-indexer entry point) =================
await click('w-no-indexer-receive');
await waitFor(modalOpen('receive-modal'), 'receive modal open');
check(await evaluate(visible('w-receive-guard')) && !(await evaluate(visible('w-receive-body'))),
  'receive intercepted: back-up warning before the address');
await click('w-receive-anyway');
await waitFor(visible('w-receive-body'), 'Continue anyway shows the address for this open');
await shot('95-mgmt-receive-guard.png');
await evaluate(`document.getElementById('receive-modal').classList.remove('open')`);
await click('w-no-indexer-receive');
await waitFor(visible('w-receive-guard'), 'guard is back on the NEXT open (until the quiz passes)');
check(true, 'receive interception fires on every open until backed up');
await evaluate(`document.getElementById('receive-modal').classList.remove('open')`);

// ================= 11. Inactivity auto-lock (mock-only ?autolockSecs= hook) =================
await evaluate(`{ const s = document.getElementById('w-autolock'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); }`);
check(await evaluate(`localStorage.getItem('diginaut.autolock') === '1'`),
  'auto-lock ladder choice persisted in localStorage (device-scoped)');
await b.navigate(`${APP}/?autolockSecs=2`);
await waitFor(visible('w-locked'), 'locked after reload');
await setVal('w-unlock-pass', PASS);
await click('w-unlock');
await waitFor(visible('w-open'), 'unlocked (auto-lock armed at 2s)');
await waitFor(visible('w-locked'), 'auto-lock fires after 2s idle', 15000);
check(true, 'inactivity auto-lock locked the wallet without any click');
check((await evaluate(text('w-seed-words'))) === '' && !(await evaluate(modalOpen('wallet-modal'))),
  'lock teardown: no seed words, no floating switcher');
await shot('96-mgmt-autolocked.png');

console.log('\nDone.');
b.close();
server.close();
process.exit(process.exitCode || 0);
