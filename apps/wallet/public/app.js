// DigiDollar wallet — frontend logic.
// Consensus math comes from the digidollar-js protocol library (served at /lib/),
// which mirrors DigiByte Core v9.26.4 exactly — the same code the differential
// harness (M2) will verify against Core.
import {
  LOCK_TIERS, requiredCollateralSats, effectiveRatioPercent,
  generateMnemonic, validateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS,
  planSpend, planMaxSpend, buildSignedSpendTx, scriptPubKeyFromAddress,
  decodeDDAddress, encodeDDAddress, decodeAddress, encodeBip21, parseBip21, satsToDgbString,
  buildSignedMintTx, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
  buildSignedTransferTx, buildSignedRedeemTx, DD_TX_LIMITS,
} from '/lib/index.js';
import * as keystore from '/keystore.js';
import { createVaultManager } from '/vault.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { networkChrome, betaCapError } from '/netchrome.js';
import { dcaBpsFromMultiplier, describeDca } from '/dca.js';
import { friendlyDDError, MINT_FREEZE_EXPLANATION } from '/dderrors.js';
import qrcode from 'qrcode-generator';

const $ = (id) => document.getElementById(id);

// Consensus oracle price bounds, mirrored from Core primitives/oracle.h
// (ORACLE_MIN/MAX_PRICE_MICRO_USD). Sub-cent DGB prices are consensus-valid.
const ORACLE_MIN_PRICE_MICRO_USD = 100n; // $0.0001 / DGB
const ORACLE_MAX_PRICE_MICRO_USD = 100_000_000n; // $100 / DGB

// Escape untrusted strings before they reach an innerHTML sink. The node,
// indexer, and oracle responses are semi-trusted JSON, and txids/addresses can
// be peer-supplied — a malicious value must never break out into markup or an
// inline event handler (#55). Covers both text and double-quoted attribute
// contexts. Prefer textContent where possible; use this for template strings.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function rpc(method, params = []) {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json.result;
}

const fmtDGB = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtUSD = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// sendrawtransaction with Core's consensus reject strings translated (#62) —
// "minting-frozen-volatility" is not an error a human can act on.
async function broadcastTx(hex) {
  try {
    return await rpc('sendrawtransaction', [hex]);
  } catch (err) {
    throw new Error(friendlyDDError(err.message) ?? err.message);
  }
}

// ---- DCA network-health multiplier (#62) ----
// Core scales required collateral by system health (dca.cpp): quoting without
// it under-quotes on a degraded system and the node rejects every mint.
let lastDcaBps = null; // basis points (10000 = healthy 1.0×); null until fetched
let lastDcaInfo = null; // raw getdcamultiplier result — tier_status feeds quote notes

// note like "1.5× collateral — network health: critical", or null when healthy.
// If DD is live but the node wouldn't say its health, say the quote is an
// assumption rather than silently pretending to know.
const dcaNote = () => {
  if (lastDcaInfo) return describeDca(lastDcaInfo);
  return chainState.ddActive ? 'assumes a healthy network — health multiplier unavailable' : null;
};

async function loadDca() {
  try {
    const dca = await rpc('getdcamultiplier');
    lastDcaBps = dcaBpsFromMultiplier(dca.multiplier);
    lastDcaInfo = dca;
  } catch {
    // Pre-activation the RPC throws, and a down node can't answer: previews
    // fall back to healthy 1.0×; the review step re-fetches and fails honestly.
    lastDcaBps = null;
    lastDcaInfo = null;
  }
  recalc();
  updateMintEstimate();
  refreshTierReadout();
}

// rebound by initMintTiers so a late DCA answer updates the tier pill too
let refreshTierReadout = () => {};

// ---- Mint calculator (pure client-side, exact Core arithmetic via digidollar-js) ----
function tierFor() {
  return LOCK_TIERS.find((t) => t.id === $('c-tier').value) || LOCK_TIERS[0];
}
function recalc() {
  const amount = Math.max(0, Number($('c-amount').value) || 0);
  const price = Math.max(0, Number($('c-price').value) || 0);
  const tier = tierFor();
  // the quote is honest about network health: ratio and USD reflect the DCA
  // multiplier the node reports, not the healthy-system base (#62)
  const bps = lastDcaBps ?? 10_000n;
  const effRatio = effectiveRatioPercent(tier.ratioPercent, bps);
  $('r-ratio').textContent = effRatio + '%' + (dcaNote() ? ` (${tier.ratioPercent}% base, ${dcaNote()})` : '');
  $('r-usd').textContent = fmtUSD((amount * effRatio) / 100);
  try {
    const sats = requiredCollateralSats({
      ddCents: BigInt(Math.round(amount * 100)),
      tierId: tier.id,
      oraclePriceMicroUsd: BigInt(Math.round(price * 1_000_000)),
      dcaMultiplierBps: bps,
    });
    $('r-dgb').textContent = fmtDGB(Number(sats) / 1e8);
  } catch {
    $('r-dgb').textContent = '—'; // zero/invalid input
  }
}

function initCalculator() {
  const sel = $('c-tier');
  sel.innerHTML = LOCK_TIERS.map((t) => `<option value="${t.id}">${t.label} — ${t.ratioPercent}% collateral</option>`).join('');
  ['c-amount', 'c-tier', 'c-price'].forEach((id) => $(id).addEventListener('input', recalc));
  enhanceSelect('c-tier');
  recalc();
}

// Kit Dropdown component over a hidden native <select> (the select stays the
// source of truth, so scripts that set .value directly keep working).
function enhanceSelect(id) {
  const sel = $(id);
  if (sel.parentNode.classList?.contains('dd')) return;
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const trig = document.createElement('button');
  trig.type = 'button';
  trig.className = 'dd-trigger';
  trig.innerHTML = '<span class="dd-label"></span><svg class="dd-caret" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const list = document.createElement('div');
  list.className = 'dd-list';
  wrap.append(trig, list);
  const label = trig.querySelector('.dd-label');
  const sync = () => { label.textContent = sel.selectedOptions[0]?.textContent ?? ''; };
  const rebuild = () => {
    list.innerHTML = '';
    for (const o of sel.options) {
      const el = document.createElement('div');
      el.className = 'dd-option' + (o.value === sel.value ? ' selected' : '');
      el.textContent = o.textContent;
      el.addEventListener('click', () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        wrap.classList.remove('open');
      });
      list.appendChild(el);
    }
  };
  trig.setAttribute('aria-haspopup', 'listbox');
  trig.setAttribute('aria-expanded', 'false');
  // Inside a modal the absolutely-positioned list would be clipped by the
  // modal's own scroll box (double scrollbars) — escape it with position:fixed
  // anchored to the trigger. Viewport coordinates, so the modal never scrolls.
  const positionList = () => {
    if (!wrap.closest('.modal')) return;
    const r = trig.getBoundingClientRect();
    Object.assign(list.style, {
      position: 'fixed', left: r.left + 'px', right: 'auto',
      top: r.bottom + 6 + 'px', width: r.width + 'px', zIndex: 70,
    });
  };
  trig.addEventListener('click', () => {
    const opening = !wrap.classList.contains('open');
    document.querySelectorAll('.dd.open').forEach((d) => { d.classList.remove('open'); d.querySelector('.dd-trigger')?.setAttribute('aria-expanded', 'false'); });
    if (opening) { sync(); rebuild(); wrap.classList.add('open'); positionList(); }
    trig.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) { wrap.classList.remove('open'); trig.setAttribute('aria-expanded', 'false'); } });
  sel.addEventListener('change', sync); // keyboard changes on the native select stay in sync
  sync();
}

// ---- Status ----
function statusLine(active, textActive, textInactive) {
  const cls = active ? 'good' : 'warn';
  return `<span class="dot ${cls}"></span>${esc(active ? textActive : textInactive)}`;
}

// header dot = aggregate of softfork state + oracle freshness
const netHealth = { dd: null, oracle: null };
function renderNetDot() {
  const bad = netHealth.dd === false || netHealth.oracle === false;
  const ok = netHealth.dd === true && netHealth.oracle === true;
  $('net-dot').className = 'dot ' + (bad ? 'bad' : ok ? 'good' : 'warn');
}

// ---- Mainnet beta interstitial (#54/#63) ----
// One-time BLOCKING ack on first mainnet use, persisted in localStorage.
// Continue is the only way through; Cancel keeps the modal (and the wallet)
// blocked. A storage failure (private mode) just means it shows every load.
const MAINNET_ACK_KEY = 'diginaut-mainnet-ack';
let mainnetAckShown = false; // don't re-open over a Cancel'd modal on a later poll
function maybeShowMainnetAck(chain) {
  if (chain !== 'main' || mainnetAckShown) return;
  let acked = false;
  try { acked = localStorage.getItem(MAINNET_ACK_KEY) === '1'; } catch { /* show it */ }
  if (acked) return;
  mainnetAckShown = true;
  $('mainnet-ack-modal').classList.add('open');
  $('mainnet-ack-continue').focus(); // pull focus in so the trap below can hold it
}
$('mainnet-ack-continue').addEventListener('click', () => {
  try { localStorage.setItem(MAINNET_ACK_KEY, '1'); } catch { /* re-shows next load */ }
  $('mainnet-ack-modal').classList.remove('open');
});
$('mainnet-ack-cancel').addEventListener('click', () => {
  $('mainnet-ack-note').style.display = 'block';
});
// Keep the interstitial genuinely BLOCKING for the keyboard too, not just the
// pointer (#54, decision 3). The backdrop only occluds clicks; without this a
// user could Tab into the wallet behind it (the modal sits late in the DOM) and
// transact unacknowledged. Snap any focus that escapes back onto Continue, and
// swallow Escape so there is no keyboard route past it.
document.addEventListener('focusin', (e) => {
  const modal = $('mainnet-ack-modal');
  if (modal.classList.contains('open') && !modal.contains(e.target)) {
    $('mainnet-ack-continue').focus();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('mainnet-ack-modal').classList.contains('open')) e.preventDefault();
}, true);

// The network pill must survive scroll (#54): once the topbar scrolls away it
// floats to a fixed corner just below the sticky banner. Two subtleties, both
// mobile-borne: the threshold is the header's real bottom edge (a fixed 64px
// fired while the topbar was still on screen), and it has hysteresis — the
// float removes the pill from the header flow, which can shrink the header by
// a wrapped row, and a single shared threshold then oscillates every frame.
window.addEventListener('scroll', () => {
  const pill = $('net-pill');
  const hdr = document.querySelector('header');
  const hdrBottom = hdr.offsetTop + hdr.offsetHeight;
  const floating = pill.classList.contains('floating');
  const on = floating ? window.scrollY > Math.max(hdrBottom - 80, 8) : window.scrollY > hdrBottom;
  if (on) {
    const banner = $('net-banner'); // sits below the sticky banner, whatever its wrapped height right now
    pill.style.top = (banner.hidden ? 8 : banner.offsetHeight + 8) + 'px';
  } else {
    pill.style.top = '';
  }
  pill.classList.toggle('floating', on);
}, { passive: true });

async function loadStatus() {
  try {
    const info = await rpc('getblockchaininfo');
    $('s-chain').textContent = info.chain;
    $('s-height').textContent = Number(info.blocks).toLocaleString('en-US');
    // derive receive addresses for the chain the node is actually on
    const net = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain];
    if (net) {
      chainState.netName = net; // consensus DD limits are per-network
      chainState.netKnown = true; // safe to render addresses now
      wallet.network = HD_NETWORKS[net];
      if (wallet.seed) renderAddress();
    }
    // banner + tab title follow the node's chain — same build on every network
    const { title, banner, level, pill } = networkChrome(info.chain);
    document.title = title;
    const bannerEl = $('net-banner');
    bannerEl.textContent = banner ?? '';
    bannerEl.hidden = banner === null;
    bannerEl.classList.toggle('danger', level === 'danger'); // mainnet is RED, not amber (#54)
    const pillEl = $('net-pill');
    pillEl.textContent = pill ?? '';
    pillEl.hidden = pill == null;
    pillEl.classList.toggle('danger', level === 'danger');
    pillEl.classList.toggle('warn', level === 'warn');
    maybeShowMainnetAck(info.chain);
  } catch (e) {
    $('s-err').textContent = 'blockchain: ' + e.message;
  }
  try {
    const dep = await rpc('getdeploymentinfo');
    const dd = dep?.deployments?.digidollar;
    const tr = dep?.deployments?.taproot;
    const ddActive = dd?.active === true || dd?.bip9?.status === 'active';
    chainState.ddActive = ddActive; // the mint flow refuses to start when inactive
    netHealth.dd = ddActive;
    $('s-dd').innerHTML = statusLine(ddActive, 'active', dd?.bip9?.status || 'not active');
    $('s-tr').innerHTML = statusLine(tr?.active === true, 'active', tr?.bip9?.status || 'not active');
  } catch (e) {
    netHealth.dd = false;
    $('s-err').textContent += (e ? ' · deployment: ' + e.message : '');
  }
  renderNetDot();
}

let lastPriceUsd = null; // feeds the fiat equivalents in the hero and asset rows
let lastPriceMicroUsd = null; // feeds the live mint collateral estimate

async function loadOracle() {
  try {
    const price = await rpc('getoracleprice');
    if (price?.price_usd) {
      // sub-cent DGB prices need more than fmtUSD's 2 decimals
      $('o-price').textContent = '$' + price.price_usd.toLocaleString('en-US', { maximumFractionDigits: 5 }) + (price.is_stale ? ' (stale)' : '');
      lastPriceUsd = price.price_usd;
      if (price.price_micro_usd) lastPriceMicroUsd = BigInt(price.price_micro_usd);
      netHealth.oracle = !price.is_stale;
      renderFiat();
      updateMintEstimate();
      // seed the calculator price with the live oracle price
      const priceInput = $('c-price');
      if (priceInput && !priceInput.dataset.touched) {
        priceInput.value = price.price_usd;
        $('c-pricesrc').textContent = '(from oracle)';
        recalc();
      }
    }
  } catch (e) {
    netHealth.oracle = false;
    $('o-hint').innerHTML = `<span class="err">oracle: ${esc(e.message)}</span>`;
  }
  renderNetDot();
  syncSendPriceGate(); // USD send entry follows oracle freshness (#70)
  try {
    const list = await rpc('getoracles');
    if (Array.isArray(list) && list.length) {
      const { active_oracle_count: active, total_oracle_slots: slots, consensus_threshold: need } = list[0];
      const ok = active >= need;
      $('o-consensus').innerHTML = `<span class="dot ${ok ? 'good' : 'bad'}"></span>${esc(active)}/${esc(slots)} · need ${esc(need)}`;
      $('o-active').textContent = `${active} of ${slots}`;
      $('o-grid').innerHTML = list
        .map((o, i) => {
          const on = o.is_active !== false;
          const bg = on ? 'var(--good-bg)' : 'var(--bad-bg)';
          const col = on ? 'var(--good)' : 'var(--bad)';
          return `<div class="oracle" style="background:${bg};color:${col}" title="${esc(`${o.name ?? ''} ${o.pubkey ?? ''}`)}">${esc(o.oracle_id ?? i)}</div>`;
        })
        .join('');
    }
  } catch { /* grid is optional */ }
}

// mark price as user-touched so the oracle doesn't overwrite it
$('c-price').addEventListener('input', () => { $('c-price').dataset.touched = '1'; $('c-pricesrc').textContent = ''; });

// ---- Wallet (non-custodial: mnemonic + keys never leave this page) ----
let appConfig = { mock: true, faucet: false, indexer: false };
// netName is a provisional default until the node names its chain (netKnown);
// addresses are never rendered from the guess — see renderAddress.
const chainState = { ddActive: null, netName: 'testnet', netKnown: false };
const wallet = {
  id: null, // active wallet id in the vault (meta.activeId)
  mnemonic: null, // set only while unlocked
  seed: null,
  index: 0,
  network: HD_NETWORKS.testnet, // refined from the node's `chain` once known
};

// The vault manager owns metadata + mnemonics (vault.js); keystore.js is its
// browser storage. One master password for every wallet on this device.
const vault = createVaultManager(keystore);

let shownState = 'loading'; // what the app currently renders — cross-tab sync diffs against it
function show(state) {
  shownState = state;
  $('w-loading').style.display = state === 'loading' ? 'block' : 'none';
  $('w-open').style.display = state === 'open' ? 'grid' : 'none';
  // EVM-style corner control: Connect when idle, address chip when connected
  const open = state === 'open';
  $('hero-guest').style.display = state === 'none' || state === 'locked' ? 'block' : 'none';
  $('w-connect').style.display = open || state === 'loading' ? 'none' : 'inline-block';
  $('w-chip').style.display = open ? 'inline-flex' : 'none';
  // backup-status surfaces belong to an OPEN wallet; renderBackupCta shows
  // them again (or not) once openWallet knows the active wallet's flag
  if (!open) { $('w-backup-badge').style.display = 'none'; $('w-backup-strip').style.display = 'none'; }
  $('wallet-open-card').style.display = open ? 'grid' : 'none';
  $('net-wallet-sec').style.display = open ? 'block' : 'none'; // seed/lock need an unlocked wallet
  // no indexer on this deployment: the money grid never loads, so say why (#61).
  // Gated on a LOADED config — a failed /api/config fetch must not produce a
  // confident false "no indexer here" claim on an indexer-equipped deployment.
  $('w-no-indexer').style.display = open && appConfig.loaded && !appConfig.indexer ? 'block' : 'none';
  if (open) {
    // the backup ceremony OVERLAYS the already-open wallet (drivers depend on
    // the wallet opening immediately); any other modal content closes
    if (!['backup', 'quiz', 'backup-done'].includes(connectMode)) closeConnectModal();
  } else {
    // the modal's inner mode follows the app state while no wallet is open;
    // while open it is driven solely by the ceremony/add-wallet flows (§2)
    setConnectMode(state === 'locked' ? 'unlock' : 'choice');
    // action modals must not survive a lock/disconnect
    for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'wallet-modal', 'consolidate-modal']) $(id).classList.remove('open');
  }
  dockPriceBlock(open);
  // loading veil covers the gap between unlock and the first indexer answer
  // (only once the chain is known — before that "syncing" would be a lie)
  $('loading-veil').style.display =
    open && appConfig.indexer && chainState.netKnown && $('w-money').style.display === 'none' ? 'block' : 'none';
}

// The price block lives inside the hero card while connected (chart right
// under the balance, like the reference wallets) and as its own card
// otherwise. Same node, one set of ids — just re-parented.
function dockPriceBlock(open) {
  const docked = open && appConfig.indexer;
  const slot = $(docked ? 'price-slot-hero' : 'price-slot-guest');
  const block = $('price-block');
  if (block.parentNode !== slot) {
    slot.appendChild(block);
    renderSparkline(lastPriceSeries); // the new slot has a different width
  }
  // guests never see the market chart; the standalone card only serves the
  // connected-but-no-indexer edge case
  $('price-card').style.display = open && !appConfig.indexer ? 'block' : 'none';
}

// swap a modal's form for the success view once the tx is broadcast
function showTxSuccess(modalId, txid, title, note) {
  const modal = $(modalId);
  const box = modal.querySelector('.tx-success');
  box.querySelector('.tx-title').textContent = title;
  box.querySelector('.tx-note').textContent = note;
  const link = box.querySelector('.tx-link');
  link.textContent = txid.slice(0, 18) + '…' + txid.slice(-10);
  if (appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)) {
    link.href = appConfig.explorerTxUrl + txid;
  } else {
    link.removeAttribute('href'); // no explorer on this network (e.g. regtest)
  }
  modal.classList.add('success');
}

// ---- Connect modal mode machine (spec §2) ----
// The modal's inner step visibility is driven SOLELY by this mode, decoupled
// from the app's none/locked/open state — so add-wallet/backup flows can run
// while the wallet stays open. show() only decides whether the modal closes.
// Modes: 'choice' | 'create' | 'restore' | 'import' | 'unlock' | 'erase' |
// 'backup' | 'quiz' | 'backup-done'.
let connectMode = 'choice';
let pendingImport = null; // parsed keystore-file envelope while the import step is open (§4)

function setConnectMode(mode) {
  connectMode = mode;
  $('w-none').style.display = ['choice', 'create', 'restore', 'import'].includes(mode) ? 'block' : 'none';
  $('w-choice').style.display = mode === 'choice' ? 'block' : 'none';
  $('w-form').style.display = ['create', 'restore', 'import'].includes(mode) ? 'block' : 'none';
  $('w-restore').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-import').style.display = mode === 'import' ? 'block' : 'none';
  $('w-name-field').style.display = mode === 'import' ? 'none' : 'block'; // import names the wallet from the file
  $('w-create').style.display = mode === 'create' ? 'block' : 'none';
  $('w-restore-go').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-import-go').style.display = mode === 'import' ? 'block' : 'none';
  // a parsed envelope (and the file password) never outlives the import step
  if (mode !== 'import') {
    pendingImport = null;
    $('w-import-file').value = '';
    $('w-import-pass').value = '';
    $('w-import-info').style.display = 'none';
    $('w-import-warn').style.display = 'none';
  }
  // master password fields only exist while no vault does (§2.1)
  $('w-pass-fields').style.display = vault.status === 'none' ? 'block' : 'none';
  $('w-locked').style.display = mode === 'unlock' ? 'block' : 'none';
  if (mode === 'unlock') renderLockedNames();
  $('w-erase-view').style.display = mode === 'erase' ? 'block' : 'none';
  // the typed ERASE never survives leaving the ceremony — re-entry re-arms
  if (mode !== 'erase') { $('w-erase-input').value = ''; $('w-erase-go').disabled = true; $('w-erase-err').textContent = ''; }
  $('w-backup-view').style.display = mode === 'backup' ? 'block' : 'none';
  $('w-quiz-view').style.display = mode === 'quiz' ? 'block' : 'none';
  $('w-backup-success').style.display = mode === 'backup-done' ? 'block' : 'none';
  // Remind-me-later is shared by both ceremony steps (id kept stable — drivers
  // dismiss the whole flow with one click on it)
  $('w-backup-done').style.display = mode === 'backup' || mode === 'quiz' ? 'block' : 'none';
  document.querySelector('#w-connect-modal .modal-head h3').textContent =
    ['backup', 'quiz', 'backup-done'].includes(mode) ? 'Back up your seed phrase'
      : mode === 'erase' ? 'Erase all wallets' : 'Connect wallet';
  // real words live in the ceremony DOM only while its steps are open
  if (mode !== 'backup') $('w-backup-words').innerHTML = '';
  if (mode !== 'quiz') { $('w-quiz-slots').innerHTML = ''; $('w-quiz-chips').innerHTML = ''; $('w-quiz-err').textContent = ''; }
  $('w-none-err').textContent = '';
}
function openConnectModal() {
  setConnectMode(vault.status === 'locked' ? 'unlock' : 'choice');
  $('w-connect-modal').classList.add('open');
}
function closeConnectModal() {
  $('w-connect-modal').classList.remove('open');
  ceremony = null; // drop the plaintext words held for the reveal/quiz steps
  // resetting the mode wipes the ceremony word nodes and restores the title
  setConnectMode(vault.status === 'locked' ? 'unlock' : 'choice');
}

// ---- v3 action modals: Send / Receive / Mint / Network ----
const openModal = (id) => $(id).classList.add('open');
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const modal = b.closest('.modal-backdrop');
    modal.classList.remove('open');
    if (modal.id === 'net-modal') hideSeed(); // a revealed seed must not outlive the modal (§5)
  }));
for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'net-modal', 'disclaimer-modal', 'wallet-modal', 'consolidate-modal']) {
  $(id).addEventListener('click', (e) => {
    if (e.target !== $(id)) return;
    $(id).classList.remove('open');
    if (id === 'net-modal') hideSeed(); // same rule on backdrop-click close
  });
}
$('footer-disclaimer').addEventListener('click', () => openModal('disclaimer-modal'));
$('act-send').addEventListener('click', () => { $('send-modal').classList.remove('success'); openModal('send-modal'); });
// both receive entry points go through the backup interception gate (spec §3)
$('act-receive').addEventListener('click', openReceiveModal);
$('w-no-indexer-receive').addEventListener('click', openReceiveModal);
$('act-mint').addEventListener('click', () => { $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
$('dd-mint-open').addEventListener('click', () => { $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
$('net-btn').addEventListener('click', () => openModal('net-modal'));
$('hero-connect').addEventListener('click', () => openConnectModal());
// the asset dropdown decides which send form shows — via classes on the modal,
// never inline styles on w-send/w-transfer (drivers read their inline display)
$('send-asset').addEventListener('change', () => {
  const dgb = $('send-asset').value === 'dgb';
  $('send-modal').classList.toggle('asset-dgb', dgb);
  $('send-modal').classList.toggle('asset-dd', !dgb);
});
$('w-create-choice').addEventListener('click', () => { setConnectMode('create'); $('w-create-name').value = nextWalletName(); $('w-create-pass').focus(); });
$('w-form-back').addEventListener('click', () => setConnectMode('choice'));
// Remind me later: the wallet simply stays backedUp:false — the badge nags
$('w-backup-done').addEventListener('click', closeConnectModal);
$('w-backup-success-done').addEventListener('click', closeConnectModal);
$('w-connect').addEventListener('click', openConnectModal);
// the address chip is the wallet-switcher trigger (spec §7); its embedded
// Disconnect button keeps its own job
$('w-chip').addEventListener('click', (e) => {
  if (e.target.closest('#w-disconnect')) return;
  openWalletModal();
});
// the chip is a role="button" span (a real <button> can't nest Disconnect), so
// Enter/Space must open the switcher for keyboard/AT users too — it is the
// ONLY entry point to add/switch/rename/export/remove (spec §7)
$('w-chip').addEventListener('keydown', (e) => {
  if (e.target !== $('w-chip')) return; // the inner Disconnect button handles its own keys
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); // Space must not scroll the page
  openWalletModal();
});
$('w-modal-close').addEventListener('click', closeConnectModal);
$('w-connect-modal').addEventListener('click', (e) => { if (e.target === $('w-connect-modal')) closeConnectModal(); });
$('w-disconnect').addEventListener('click', () => lockWallet());

function renderAddress() {
  // Never show an address for a guessed network: on a mainnet deployment with
  // an unreachable node the default would be testnet-encoded — confusing at
  // best. loadStatus retries until the node names its chain, then re-renders.
  const addressActions = [$('w-copy'), $('w-next'), $('w-faucet'), $('w-copy-dd'), $('w-compat-copy')];
  if (!chainState.netKnown) {
    $('w-path').textContent = '';
    $('w-address').textContent = 'waiting for the node to report a supported network…';
    $('w-dd-address').textContent = '';
    $('w-compat-address').textContent = '';
    $('w-chip-addr').textContent = '…';
    $('w-qr').innerHTML = '';
    $('w-compat-qr').innerHTML = '';
    for (const b of addressActions) b.disabled = true; // nothing here to copy/claim
    return;
  }
  for (const b of addressActions) b.disabled = false;
  const { path, address, p2wpkhAddress } = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
  $('w-path').textContent = path;
  $('w-address').textContent = address;
  // The SAME key's P2WPKH twin (dgb1q…, same index) for senders that cannot
  // pay taproot (#103 decision 1). Already watched for balance/history (#38),
  // so funds arriving here show up like any other coin.
  $('w-compat-address').textContent = p2wpkhAddress;
  // Same taproot key in DigiDollar base58check form — the ONLY encoding Core /
  // mobile wallets accept as a DigiDollar recipient (their senddigidollar checks
  // the DD…/TD…/RD… prefix). decodeDDAddress(address) yields the shared key.
  $('w-dd-address').textContent = encodeDDAddress(decodeDDAddress(address).outputKeyHex, chainState.netName);
  $('w-chip-addr').textContent = address.slice(0, 10) + '…' + address.slice(-4);
  updateReceiveQr();
}

// Receive QR + payment-request copy (#71). Bare address by default; when the
// user requests a specific amount, both switch to a BIP21 `digibyte:` URI so a
// mobile scan prefills address + amount. The address is encoded VERBATIM in
// byte mode — the uppercase/alphanumeric-mode trick makes a sparser QR, but
// BIP-173's "decoders must accept upper" is fiction in the wild: ecosystem
// wallets reject all-caps bech32, and the scan then reads as "invalid
// address" even though the same address pasted as text works (#103 spirit:
// interop beats elegance).
function drawAddressQr(el, address, requestSats) {
  const qr = qrcode(0, 'M');
  qr.addData(requestSats > 0n ? encodeBip21({ address, amountSats: requestSats }) : address, 'Byte');
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function updateReceiveQr() {
  if (!chainState.netKnown) return;
  const address = $('w-address').textContent;
  let requestSats = 0n;
  try {
    const raw = $('w-req-amount').value.trim();
    if (raw) requestSats = dgbToSats(raw);
  } catch { requestSats = 0n; } // partial/invalid input → fall back to bare address
  const useUri = requestSats > 0n;
  drawAddressQr($('w-qr'), address, requestSats);
  $('w-copy-uri').style.display = useUri ? '' : 'none';
  // the compat view mirrors the same request on the P2WPKH twin (#103): the
  // BIP21 amount applies to whichever address the sender is shown
  if ($('w-compat-section').style.display !== 'none') {
    drawAddressQr($('w-compat-qr'), $('w-compat-address').textContent, requestSats);
    $('w-compat-copy-uri').style.display = useUri ? '' : 'none';
  }
}

// Receive compat toggle (#103 decision 1): the receive view is taproot-first —
// the twin stays behind this low-emphasis link and re-hides on every open.
function setCompatShown(show) {
  $('w-compat-section').style.display = show ? 'block' : 'none';
  $('w-compat-toggle').textContent = show ? 'Hide compatibility address' : 'Sender can’t pay this address?';
  if (show) updateReceiveQr(); // the twin QR renders lazily, only when revealed
}
$('w-compat-toggle').addEventListener('click', () => {
  setCompatShown($('w-compat-section').style.display === 'none');
});

function openWallet(id, mnemonic) {
  wallet.id = id;
  wallet.mnemonic = mnemonic;
  wallet.seed = mnemonicToSeed(mnemonic);
  wallet.index = 0;
  renderAddress();
  hideSeed();
  renderBackupCta();
  $('w-open-err').textContent = '';
  show('open');
  startMoneyPolling();
  armAutolock(); // the inactivity countdown starts (only) with an unlocked wallet
}

// Shared teardown for lock AND wallet switch (spec §7): every pending draft
// holds per-UTXO private keys, and history/positions/balances belong to the
// outgoing wallet. Does NOT touch the vault key — lockWallet drops that on top.
function resetWalletState() {
  resetSend(); // pendingSend holds per-UTXO private keys — drop them with the seed
  resetMint(); // pendingMint holds the funding UTXO's private key — same
  resetTransfer(); // pendingTransfer holds DD + fee UTXO keys — same
  resetRedeem(); // pendingRedeem holds burn + fee UTXO keys — same
  resetConsolidate(); // pendingConsolidate holds every spendable coin's key — same
  $('w-send-out').textContent = '';
  $('w-mint-out').textContent = '';
  $('w-tr-out').textContent = '';
  $('w-rd-out').textContent = '';
  clearInterval(moneyTimer);
  $('w-money').style.display = 'none';
  // drop this wallet's Activity view so the next wallet doesn't inherit its
  // expanded page or see its rows flash before the first refresh (#69).
  allHistory = []; historyLimit = 8; myAddrSet = new Set(); $('w-history').innerHTML = '';
  // the next wallet's balances are unknown until its first refresh — a stale
  // figure must not leak into fiat rows or the remove-ceremony warning
  lastConfirmedDgb = null; lastDdUsd = 0; openPositions = new Map();
  renderBackupStrip(); // funds unknown again — the outgoing wallet's nag must not carry over
  hideSeed(); // an open reveal must not float over the next view (§5)
  closeConnectModal(); // nor a mid-ceremony backup view — words wiped with it
  closeWalletModal(); // nor the switcher (lock teardown, §5)
  // nor a pending re-auth prompt: its promise must settle (false) so the
  // awaiting flow dies here instead of resuming against a torn-down wallet,
  // and the password box must not float over the locked screen (§5)
  settleReauth(false);
  clearTimeout(autolockTimer); // openWallet re-arms it on switch/unlock
}

function lockWallet() {
  vault.lock(); // drops the session key + every plaintext mnemonic
  wallet.id = null;
  wallet.mnemonic = null;
  wallet.seed = null;
  resetWalletState();
  $('w-unlock-pass').value = '';
  $('w-locked-err').textContent = '';
  show('locked');
}

/** Switch the open view to another wallet in the unlocked vault: the full
 * lock-style state reset (drafts, history, positions) WITHOUT dropping the
 * vault key, then open the new wallet (spec §7). */
function switchToWallet(id) {
  resetWalletState();
  openWallet(id, vault.getMnemonic(id));
}

// ---- Cross-tab sync (spec §1) ----
// The vault manager refreshes its own record on BroadcastChannel writes, but
// the UI must follow: an erased vault relocks this tab (dropping the seed from
// the page), a cross-tab switch/remove re-opens the wallet the vault now says
// is active, and meta-driven surfaces (switcher list, backup badge, locked
// names) re-render. Also runs after a VaultConflictError — the manager
// refreshed before rethrowing, so the same reconciliation applies.
function reconcileVaultUi() {
  const st = vault.status;
  if (st === 'unlocked') {
    const m = vault.meta();
    if (wallet.id && m.activeId !== wallet.id) {
      // another tab switched away from (or removed) the wallet on display —
      // the shown address and its guard state must come from the same wallet
      switchToWallet(m.activeId);
    } else {
      renderBackupCta(); // badge/strip may have changed (quiz pass elsewhere)
      if ($('wallet-modal').classList.contains('open')) renderWalletList();
    }
    return;
  }
  // dropped out of unlocked: the vault was erased or re-created under a new
  // salt in another tab. The in-memory seed is torn down like a lock.
  if (wallet.seed || wallet.id) {
    wallet.id = null;
    wallet.mnemonic = null;
    wallet.seed = null;
    resetWalletState();
  }
  const target = st === 'none' ? 'none' : 'locked';
  if (shownState !== target) show(target);
  else if (target === 'locked' && connectMode === 'unlock') renderLockedNames(); // names may have changed
}
keystore.onVaultChanged(() => {
  vault.refresh().then(reconcileVaultUi).catch(() => {});
});

// Locked screen: every wallet's name from the cleartext meta and ONE password
// field (spec §7). A not-yet-migrated v1 record has no names → line hidden.
function renderLockedNames() {
  const el = $('w-locked-names');
  const wallets = vault.meta()?.wallets ?? [];
  el.textContent = wallets.length > 1
    ? `${wallets.length} wallets · ${wallets.map((w) => w.name).join(', ')}`
    : wallets[0]?.name ?? '';
  el.style.display = el.textContent ? 'block' : 'none';
}

// "Wallet N" prefill for the create/restore name field — N past every taken
// default so an untouched submit never trips the duplicate-name guard.
function nextWalletName() {
  const names = new Set((vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
  let n = names.size + 1;
  while (names.has(`wallet ${n}`)) n += 1;
  return `Wallet ${n}`;
}

/** Put a wallet into the vault: first one creates the vault (master password
 * fields), later ones ride the unlocked session key — no password re-prompt. */
async function createWalletEntry({ name, mnemonic, backedUp = false }) {
  if (vault.status === 'unlocked') {
    // duplicate-mnemonic contract: an existing seed comes back existed:true
    const { id, existed } = await vault.addWallet({ name, mnemonic, backedUp });
    await vault.setActive(id); // new or duplicate, it becomes the active wallet
    return { id, existed };
  }
  const pass = $('w-create-pass').value;
  if (pass.length < 8) throw new Error('password must be at least 8 characters');
  if (pass !== $('w-create-pass2').value) throw new Error('passwords do not match');
  const id = await vault.createVault(pass, { name, mnemonic, backedUp });
  return { id, existed: false };
}

// Error → user copy at the UI boundary. A lost CAS race must never leak the
// internal VaultConflictError message (spec §1): show the mandated copy and
// re-drive the UI — the manager already re-synced from storage before
// rethrowing, so reconcile renders what the other tab wrote.
function surfaceError(e) {
  if (e instanceof keystore.VaultConflictError) {
    reconcileVaultUi();
    return 'This wallet was changed in another tab — reloading.';
  }
  return e.message;
}

async function busy(btn, errId, fn) {
  const el = $(errId);
  el.textContent = '';
  // A fragmentation error (consolidatable flag) reveals the "Consolidate
  // coins" offer that sits under this error area, when one exists (#103
  // decision 2). Any other outcome — success or a different error — hides it,
  // so a stale offer never outlives the error it belongs to.
  const offer = $(errId + '-consolidate');
  if (offer) offer.style.display = 'none';
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    el.textContent = surfaceError(e);
    if (offer && e.consolidatable) offer.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

$('w-create').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const name = $('w-create-name').value.trim() || nextWalletName();
    const mnemonic = generateMnemonic();
    const { id } = await createWalletEntry({ name, mnemonic });
    // the wallet opens immediately; the backup ceremony overlays it (drivers
    // click w-backup-done once to dismiss and find the wallet already open).
    // switchToWallet also resets the previous wallet's state (add-while-open).
    switchToWallet(id);
    beginBackupCeremony(id, mnemonic);
  }));

$('w-show-restore').addEventListener('click', () => { setConnectMode('restore'); $('w-create-name').value = nextWalletName(); $('w-restore-seed').focus(); });

$('w-restore-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const words = $('w-restore-seed').value.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(words)) throw new Error('not a valid BIP39 seed phrase (check the words and their order)');
    const name = $('w-create-name').value.trim() || nextWalletName();
    // typing the words proves possession — a restored wallet IS backed up (§2)
    const { id, existed } = await createWalletEntry({ name, mnemonic: words, backedUp: true });
    $('w-restore-seed').value = ''; // no mnemonic left in the DOM (§2 rules)
    switchToWallet(id);
    // duplicate-mnemonic contract (§2): say so in the wallet switcher
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this wallet (${w.name}) — switched to it.`);
    }
  }));

// ---- Keystore file import (spec §4) ----
// Picker → validate the envelope (clear errors) → the FILE's password →
// decrypt → add as a new wallet and switch to it. A file import proves the
// password, not the words, so the wallet stays backedUp:false.
$('w-show-import').addEventListener('click', () => { setConnectMode('import'); });

$('w-import-file').addEventListener('change', (e) =>
  busy(e.target, 'w-none-err', async () => {
    pendingImport = null;
    $('w-import-info').style.display = 'none';
    $('w-import-warn').style.display = 'none';
    const file = $('w-import-file').files[0];
    if (!file) return;
    pendingImport = keystore.parseKeystoreFile(await file.text());
    const when = new Date(pendingImport.exportedAt);
    $('w-import-info').textContent = `“${pendingImport.name}”` +
      (Number.isNaN(when.getTime()) ? '' : ` — exported ${when.toLocaleDateString('en-CA')}`) +
      (pendingImport.network ? ` on ${pendingImport.network}` : '');
    $('w-import-info').style.display = 'block';
    // network mismatch: warn but allow (§4) — mnemonics are network-agnostic,
    // the same seed just derives different-looking addresses per chain
    if (pendingImport.network && chainState.netKnown && pendingImport.network !== chainState.netName) {
      $('w-import-warn').textContent = `This file was exported on ${pendingImport.network}, but this wallet runs on ` +
        `${chainState.netName}. The seed phrase works on both networks — only the addresses look different.`;
      $('w-import-warn').style.display = 'block';
    }
    $('w-import-pass').focus();
  }));

// name from the envelope, de-duplicated against the vault ("Trading" → "Trading 2")
function importedWalletName(name) {
  const base = String(name ?? '').trim() || nextWalletName();
  const taken = new Set((vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base.toLowerCase()} ${n}`)) n += 1;
  return `${base} ${n}`;
}

$('w-import-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    if (!pendingImport) throw new Error('pick a backup file first');
    let mnemonic;
    try {
      mnemonic = await keystore.decryptKeystoreFile(pendingImport, $('w-import-pass').value);
    } catch (err) {
      throw err?.name === 'OperationError' ? new Error('wrong password for this file') : err;
    }
    if (!validateMnemonic(mnemonic)) throw new Error('the file decrypted, but it does not hold a valid seed phrase');
    const name = importedWalletName(pendingImport.name);
    const { id, existed } = await createWalletEntry({ name, mnemonic, backedUp: false });
    switchToWallet(id); // also resets the import step (mode leaves 'import')
    // duplicate-mnemonic contract (§2): say so in the wallet switcher
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this wallet (${w.name}) — switched to it.`);
    }
  }));

$('w-unlock').addEventListener('click', (e) =>
  busy(e.target, 'w-locked-err', async () => {
    let meta;
    try {
      meta = await vault.unlock($('w-unlock-pass').value); // migrates v1 transparently
    } catch (err) {
      // GCM auth failure = wrong password; anything else (storage failure,
      // interrupted migration) deserves its real message
      throw err?.name === 'OperationError' ? new Error('wrong password') : err;
    }
    $('w-unlock-pass').value = '';
    // one password opens the whole vault; the switcher picks any other wallet
    openWallet(meta.activeId, vault.getMnemonic(meta.activeId));
  }));
$('w-unlock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-unlock').click(); });

// ---- Global reset ceremony (spec §5, locked screen only) ----
// "Erase all wallets on this device": list every wallet's name, arm the
// button only on a typed ERASE, then wipe v1 and v2 records alike. A
// not-yet-migrated v1 record has no names — it migrates to "Wallet 1", so
// call it that here too.
$('w-forget').addEventListener('click', (e) => {
  e.preventDefault();
  const names = (vault.meta()?.wallets ?? []).map((w) => w.name);
  $('w-erase-names').innerHTML = (names.length ? names : ['Wallet 1 (created by an older version)'])
    .map((n) => `<li>${esc(n)}</li>`).join('');
  setConnectMode('erase');
  $('w-erase-input').focus();
});
$('w-erase-input').addEventListener('input', () => {
  $('w-erase-go').disabled = $('w-erase-input').value.trim() !== 'ERASE';
});
$('w-erase-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('w-erase-go').disabled) $('w-erase-go').click(); });
$('w-erase-cancel').addEventListener('click', () => setConnectMode('unlock'));
$('w-erase-go').addEventListener('click', (e) =>
  busy(e.target, 'w-erase-err', async () => {
    await keystore.deleteAllRecords();
    await vault.load();
    show('none'); // back to the guest hero; the modal drops to choice mode
  }));

$('w-lock').addEventListener('click', lockWallet);
$('w-next').addEventListener('click', () => { wallet.index += 1; renderAddress(); refreshMoney(); });
$('w-copy').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-address').textContent)));
$('w-copy-dd').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-dd-address').textContent)));
// BIP21 request amount (#71): live-redraw the QR, and copy the full payment URI.
$('w-req-amount').addEventListener('input', updateReceiveQr);
$('w-copy-uri').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () =>
    navigator.clipboard.writeText(encodeBip21({ address: $('w-address').textContent, amountSats: dgbToSats($('w-req-amount').value) }))));
// compat twin copy buttons (#103 decision 1) — the payment request carries the
// twin address, so the BIP21 amount applies to the address actually shown
$('w-compat-copy').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-compat-address').textContent)));
$('w-compat-copy-uri').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () =>
    navigator.clipboard.writeText(encodeBip21({ address: $('w-compat-address').textContent, amountSats: dgbToSats($('w-req-amount').value) }))));
$('w-faucet').addEventListener('click', (e) =>
  busy(e.target, 'w-open-err', async () => {
    $('w-faucet-out').textContent = 'Requesting…';
    try {
      const res = await fetch('/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: $('w-address').textContent }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      $('w-faucet-out').textContent = `Sent ${json.amountDgb.toLocaleString('en-US')} DGB — tx ${json.txid.slice(0, 16)}…`;
    } catch (err) {
      $('w-faucet-out').textContent = '';
      throw err;
    }
  }));

// ---- Inactivity auto-lock (spec §5) ----
// Device-scoped preference in localStorage (minutes; 0 = Never) — NOT in the
// vault, so it is readable without an unlock and never follows a keystore
// file to another device. The ?autolockSecs= override exists for drivers and
// is honored ONLY in mock mode: on a live deployment a crafted link must not
// silently disable (or stretch) auto-lock.
const AUTOLOCK_KEY = 'diginaut.autolock';
const AUTOLOCK_DEFAULT_MIN = 5;
function autolockDelayMs() {
  if (appConfig.mock) {
    const secs = Number(new URLSearchParams(location.search).get('autolockSecs'));
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  let mins = AUTOLOCK_DEFAULT_MIN;
  try {
    const stored = Number(localStorage.getItem(AUTOLOCK_KEY));
    if (Number.isFinite(stored) && stored >= 0) mins = stored;
  } catch { /* private mode → default */ }
  return mins * 60_000; // 0 = Never
}
let autolockTimer = null;
function armAutolock() {
  clearTimeout(autolockTimer);
  if (vault.status !== 'unlocked') return; // the timer only runs while unlocked
  const ms = autolockDelayMs();
  if (!ms) return; // Never
  // re-check on fire: the vault may have been erased/removed since arming
  autolockTimer = setTimeout(() => { if (vault.status === 'unlocked') lockWallet(); }, ms);
}
// Activity = pointerdown/keydown anywhere, throttled to one re-arm a second —
// typing must not schedule hundreds of timers.
let lastActivityArm = 0;
function noteActivity() {
  if (Date.now() - lastActivityArm < 1000) return;
  lastActivityArm = Date.now();
  armAutolock();
}
document.addEventListener('pointerdown', noteActivity, true);
document.addEventListener('keydown', noteActivity, true);
$('w-autolock').addEventListener('change', () => {
  try { localStorage.setItem(AUTOLOCK_KEY, $('w-autolock').value); } catch { /* stays a session preference */ }
  armAutolock();
});

// ---- Password re-auth (spec §5) ----
// One small prompt reused by every sensitive action: seed reveal, backup
// re-entry, and keystore export. Remove-wallet uses its own type-the-name
// ceremony instead. Resolves the TYPED password (truthy) only after
// verifyPassword — a decrypt probe against storage, no state change — and
// false on cancel; boolean callers and the export (which derives the file's
// key from the password) share the same gate.
let reauthResolve = null;
function requireReauth(hint) {
  return new Promise((resolve) => {
    reauthResolve = resolve;
    $('reauth-hint').textContent = hint;
    $('reauth-pass').value = '';
    $('reauth-err').textContent = '';
    $('reauth-modal').classList.add('open');
    $('reauth-pass').focus();
  });
}
function settleReauth(ok) {
  const pass = ok && $('reauth-pass').value; // never empty: createVault enforces ≥8 chars
  $('reauth-modal').classList.remove('open');
  $('reauth-pass').value = '';
  reauthResolve?.(pass);
  reauthResolve = null;
}
$('reauth-go').addEventListener('click', (e) =>
  busy(e.target, 'reauth-err', async () => {
    if (!(await vault.verifyPassword($('reauth-pass').value))) throw new Error('wrong password');
    settleReauth(true);
  }));
$('reauth-cancel').addEventListener('click', () => settleReauth(false));
$('reauth-modal').addEventListener('click', (e) => { if (e.target === $('reauth-modal')) settleReauth(false); });
$('reauth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('reauth-go').click(); });

// ---- Seed reveal ceremony + backup quiz (spec §2/§5) ----
// While blurred the grids hold DECOY words (random BIP39, re-rolled per open)
// so the blur cannot be peeked through; "Tap to reveal" swaps in the real
// words. Real words exist in the DOM only while a reveal step is open.
function randomBip39Words(n, exclude = new Set()) {
  const out = [];
  while (out.length < n) {
    const w = wordlist[crypto.getRandomValues(new Uint32Array(1))[0] % wordlist.length];
    if (!exclude.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}
function shuffle(arr) { // Fisher–Yates over a copy
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// newline-joined so the grid's textContent stays space-separable words —
// drivers capture the mnemonic with textContent.trim().split(/\s+/)
const wordGridHtml = (words) => words.map((w) => `<li>${esc(w)}</li>`).join('\n');

let ceremony = null; // { id, words, quiz } while the backup flow is open

function renderBackupGrid(revealed) {
  $('w-backup-words').innerHTML = wordGridHtml(revealed ? ceremony.words : randomBip39Words(ceremony.words.length));
  $('w-backup-reveal').classList.toggle('blurred', !revealed);
}
/** Open the reveal → quiz flow over the (already open) wallet. */
function beginBackupCeremony(id, mnemonic) {
  ceremony = { id, words: mnemonic.trim().split(/\s+/), quiz: null };
  renderBackupGrid(false);
  setConnectMode('backup');
  $('w-connect-modal').classList.add('open');
}
$('w-backup-show').addEventListener('click', () => { renderBackupGrid(true); armSeedHide(); });
$('w-backup-continue').addEventListener('click', () => { buildQuiz(); setConnectMode('quiz'); });

// Quiz: 3 slots at distinct random indices (ascending); chips are ONLY the 3
// removed words + 6 random decoys — never the full seed in legible plaintext.
// Every attempt re-randomizes indices and re-rolls decoys (unlimited retries).
function buildQuiz() {
  const { words } = ceremony;
  const idxs = shuffle([...words.keys()]).slice(0, 3).sort((a, b) => a - b);
  const chips = shuffle([...idxs.map((i) => words[i]), ...randomBip39Words(6, new Set(words))]);
  ceremony.quiz = { idxs, chips, filled: [null, null, null] }; // filled = chip indices (words can repeat)
  renderQuiz();
}
function renderQuiz() {
  const q = ceremony.quiz;
  $('w-quiz-slots').innerHTML = q.idxs.map((wi, s) => {
    const chip = q.filled[s];
    return `<button type="button" class="quiz-slot${chip == null ? '' : ' filled'}" data-slot="${s}">` +
      `<span class="qn">Word #${wi + 1}</span><span class="mono">${chip == null ? '·' : esc(q.chips[chip])}</span></button>`;
  }).join('');
  $('w-quiz-chips').innerHTML = q.chips.map((w, i) =>
    `<button type="button" class="quiz-chip secondary" data-chip="${i}"${q.filled.includes(i) ? ' disabled' : ''}>${esc(w)}</button>`).join('');
}
$('w-quiz-chips').addEventListener('click', (e) => {
  const i = e.target?.dataset?.chip;
  if (i == null || !ceremony?.quiz) return;
  const q = ceremony.quiz;
  const slot = q.filled.indexOf(null); // chips fill the next empty slot
  if (slot === -1 || q.filled.includes(Number(i))) return;
  q.filled[slot] = Number(i);
  renderQuiz();
});
$('w-quiz-slots').addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-slot]');
  if (!btn || !ceremony?.quiz) return;
  const q = ceremony.quiz;
  if (q.filled[btn.dataset.slot] == null) return;
  q.filled[btn.dataset.slot] = null; // click a filled slot to clear it
  renderQuiz();
});
$('w-quiz-verify').addEventListener('click', (e) =>
  busy(e.target, 'w-quiz-err', async () => {
    const q = ceremony.quiz;
    if (q.filled.some((c) => c == null)) throw new Error('fill in all three words first');
    if (!q.idxs.every((wi, s) => q.chips[q.filled[s]] === ceremony.words[wi])) {
      buildQuiz(); // fresh indices, fresh decoys, cleared slots
      throw new Error('Not quite — check your written copy and try again.');
    }
    await vault.setBackedUp(ceremony.id); // cleared ONLY by this quiz pass
    renderBackupCta();
    setConnectMode('backup-done'); // success beat; Done closes
  }));

// ---- Backup-status surfaces (spec §3) ----
// The active wallet's backedUp flag drives the header badge, the net-modal
// button and the balance-gated strip; all re-render on wallet switch
// (openWallet) and on quiz pass. The flag is cleared ONLY by a quiz pass.
function renderBackupCta() {
  // keyed to the DISPLAYED wallet (wallet.id), not vault activeId: a cross-tab
  // setActive must not borrow another wallet's flag for the shown address
  const m = vault.meta();
  const active = m?.wallets.find((w) => w.id === wallet.id);
  const nag = Boolean(active && !active.backedUp);
  $('w-backup-now').style.display = nag ? 'block' : 'none';
  $('w-backup-badge').style.display = nag ? 'inline-block' : 'none';
  renderBackupStrip();
}

/** Every backup re-entry surface (badge, strip, receive guard, net-modal
 * button) funnels here — re-auth gated like any other seed access (§5). */
async function reenterBackupCeremony() {
  if (!wallet.id) return;
  if (!(await requireReauth('Confirm your password to back up this wallet.'))) return;
  $('net-modal').classList.remove('open');
  beginBackupCeremony(wallet.id, vault.getMnemonic(wallet.id));
}
$('w-backup-now').addEventListener('click', reenterBackupCeremony);
$('w-backup-badge').addEventListener('click', reenterBackupCeremony);

// Balance-gated warning strip: the active wallet is not backed up AND holds
// anything the indexer can see (confirmed DGB, spendable DD, or a locked
// position). Dismiss is per wallet, per page load — the nag comes back next
// session by design. A no-indexer deployment never learns the balance, so
// the receive interception below is the only funds-arriving guard there.
const stripDismissed = new Set(); // wallet ids dismissed this session
function renderBackupStrip() {
  const m = vault.status === 'unlocked' ? vault.meta() : null;
  const active = m?.wallets.find((w) => w.id === wallet.id); // the wallet on display
  const funds = (lastConfirmedDgb ?? 0) > 0 || lastDdUsd > 0 || openPositions.size > 0;
  const nag = Boolean(active && !active.backedUp && funds && !stripDismissed.has(active.id));
  $('w-backup-strip').style.display = nag ? 'block' : 'none';
}
$('w-backup-strip-go').addEventListener('click', reenterBackupCeremony);
$('w-backup-strip-dismiss').addEventListener('click', () => {
  stripDismissed.add(wallet.id);
  renderBackupStrip();
});

// Receive interception (BlueWallet pattern, spec §3): opening Receive on an
// un-backed-up wallet shows a warning step first — EVERY open until the quiz
// passes; "Continue anyway" is good for that one open. Both entry points
// (act-receive and the no-indexer card) come through this gate.
function openReceiveModal() {
  // the guard must judge the wallet whose ADDRESS is shown (wallet.id) — a
  // cross-tab setActive to a backed-up wallet must not skip the interception
  // for this tab's still-displayed, un-backed-up address (spec §3)
  const m = vault.meta();
  const active = m?.wallets.find((w) => w.id === wallet.id);
  const guard = Boolean(active && !active.backedUp);
  $('w-receive-guard').style.display = guard ? 'block' : 'none';
  $('w-receive-body').style.display = guard ? 'none' : 'block';
  setCompatShown(false); // taproot-first on every open (#103 decision 1)
  openModal('receive-modal');
}
$('w-receive-anyway').addEventListener('click', () => {
  $('w-receive-guard').style.display = 'none';
  $('w-receive-body').style.display = 'block';
});
$('w-receive-backup').addEventListener('click', () => {
  $('receive-modal').classList.remove('open');
  reenterBackupCeremony();
});

// Show seed phrase (net-modal): re-auth, then the same blur + decoy ceremony.
// After the tap, w-seed-words holds the REAL mnemonic as plain text.
function renderSeedGrid(revealed) {
  const words = wallet.mnemonic.trim().split(/\s+/);
  $('w-seed-words').innerHTML = wordGridHtml(revealed ? words : randomBip39Words(words.length));
  $('w-seed-reveal').classList.toggle('blurred', !revealed);
}
function hideSeed() {
  clearTimeout(seedHideTimer);
  $('w-seed').style.display = 'none';
  $('w-seed-words').innerHTML = ''; // never leave a seed in the DOM
  $('w-backup').textContent = 'Show seed phrase';
}
$('w-backup').addEventListener('click', async () => {
  if ($('w-seed').style.display !== 'none') return hideSeed();
  if (!(await requireReauth("Confirm your password to reveal this wallet's seed phrase."))) return;
  renderSeedGrid(false); // blurred decoys until the tap
  $('w-seed').style.display = 'block';
  $('w-backup').textContent = 'Hide seed phrase';
});
$('w-seed-show').addEventListener('click', () => { renderSeedGrid(true); armSeedHide(); });

// A revealed seed auto-hides after 60 s, and switching tabs hides it at once
// (spec §5): both grids — w-seed-words AND the backup ceremony's words — are
// wiped and re-blurred (fresh decoys), so a walked-away-from screen or a
// backgrounded tab never keeps a legible seed.
let seedHideTimer = null;
function armSeedHide() {
  clearTimeout(seedHideTimer);
  seedHideTimer = setTimeout(wipeRevealedSeeds, 60_000);
}
function wipeRevealedSeeds() {
  clearTimeout(seedHideTimer);
  if ($('w-seed').style.display !== 'none') hideSeed();
  if (connectMode === 'backup' && ceremony) renderBackupGrid(false); // decoys + blur back on
}
document.addEventListener('visibilitychange', () => { if (document.hidden) wipeRevealedSeeds(); });

// ---- Wallet switcher (spec §7) ----
// Names + backup flags come from the CLEARTEXT vault meta; the address is
// derived lazily and only for the ACTIVE wallet — deriving every wallet's
// would drag every mnemonic through seed derivation just for a list row.
let managingId = null; // wallet id with the manage row (rename/remove) expanded
let removingId = null; // wallet id the remove ceremony is aimed at

function openWalletModal(note) {
  managingId = null;
  $('w-wallet-note').textContent = note ?? '';
  $('w-wallet-note').style.display = note ? 'block' : 'none';
  $('w-wallet-err').textContent = '';
  showRemoveView(null);
  renderWalletList();
  $('wallet-modal').classList.add('open');
}
function closeWalletModal() {
  $('wallet-modal').classList.remove('open');
}

function renderWalletList() {
  const m = vault.meta();
  if (!m) { $('w-wallet-list').innerHTML = ''; return; } // vault gone — modal is closing anyway
  $('w-wallet-list').innerHTML = m.wallets.map((w) => {
    const active = w.id === m.activeId;
    const dot = w.backedUp ? '' : ' <span class="wal-dot" title="Not backed up"></span>';
    const sub = active ? `<div class="wal-sub mono">${esc($('w-chip-addr').textContent)}</div>` : '';
    return `<div class="wal-row">` +
      `<button type="button" class="wal-pick" data-switch="${esc(w.id)}">` +
      `<span><span class="wal-name">${esc(w.name)}</span>${dot}${sub}</span>` +
      (active ? '<span class="wal-check">✓</span>' : '') +
      `</button>` +
      `<button type="button" class="wal-manage secondary" data-manage="${esc(w.id)}" title="Rename or remove">⋯</button>` +
      `</div>` +
      (managingId === w.id ? walletEditHtml(w) : '');
  }).join('');
}

function walletEditHtml(w) {
  return `<div class="wal-edit">` +
    `<input id="w-rename-input" autocomplete="off" value="${esc(w.name)}" />` +
    `<div class="grid">` +
    `<button type="button" id="w-rename-go" class="secondary" data-rename="${esc(w.id)}">Rename</button>` +
    `<button type="button" id="w-remove-open" class="danger" data-remove="${esc(w.id)}">Remove…</button>` +
    `</div>` +
    // deliberately SECONDARY messaging (§4): the file is a convenience copy
    `<button type="button" id="w-export-go" class="secondary" data-export="${esc(w.id)}">Export backup file</button>` +
    `<p class="hint" style="margin:6px 0 0">An encrypted copy of this wallet. It only opens with your password — it is NOT a replacement for the seed phrase.</p>` +
    `</div>`;
}

// Hand the envelope to the browser as a download (Blob URL, §4 filename).
// Revoke on a timeout — revoking synchronously can abort the save.
function downloadKeystoreFile(envelope) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = keystore.keystoreFileName(envelope.name, new Date(envelope.exportedAt));
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('w-wallet-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-switch],[data-manage],[data-rename],[data-export],[data-remove]');
  if (!btn) return;
  $('w-wallet-err').textContent = '';
  try {
    if (btn.dataset.switch) {
      if (btn.dataset.switch === wallet.id) return closeWalletModal(); // already open
      await vault.setActive(btn.dataset.switch); // persisted so unlock reopens it
      switchToWallet(btn.dataset.switch); // the full state reset closes this modal
    } else if (btn.dataset.manage) {
      managingId = managingId === btn.dataset.manage ? null : btn.dataset.manage;
      renderWalletList();
    } else if (btn.dataset.rename) {
      await vault.renameWallet(btn.dataset.rename, $('w-rename-input').value); // duplicate guard inside
      managingId = null;
      renderWalletList();
    } else if (btn.dataset.export) {
      // export requires typing the password (§4/§5) — it re-proves the user
      // can open what they save, and the file's fresh KDF runs on that string
      const pass = await requireReauth('Confirm your password to export an encrypted copy of this wallet.');
      if (!pass) return;
      const w = vault.meta().wallets.find((x) => x.id === btn.dataset.export);
      downloadKeystoreFile(await keystore.buildKeystoreFile({
        name: w.name,
        network: chainState.netKnown ? chainState.netName : null,
        mnemonic: vault.getMnemonic(w.id), // export does NOT set backedUp (§4)
        password: pass,
      }));
      managingId = null;
      openWalletModal(`Saved ${keystore.keystoreFileName(w.name)} — it only opens with your password.`);
    } else if (btn.dataset.remove) {
      showRemoveView(btn.dataset.remove);
    }
  } catch (err) {
    $('w-wallet-err').textContent = surfaceError(err); // duplicate name, tab conflict, …
  }
});

// Add wallet: the connect modal in choice mode while the app stays OPEN —
// password fields stay hidden (the vault exists), create/restore/import ride
// the unlocked session key (§2 modal-mode decoupling).
$('w-add-wallet').addEventListener('click', () => {
  closeWalletModal();
  openConnectModal();
});

/** Swap the switcher between its list and the remove ceremony (id=null → list). */
function showRemoveView(id) {
  removingId = id;
  $('w-wallet-main').style.display = id ? 'none' : 'block';
  $('w-remove-view').style.display = id ? 'block' : 'none';
  if (!id) return;
  const m = vault.meta();
  const w = m.wallets.find((x) => x.id === id);
  $('w-remove-target').textContent = w.name;
  // the balance is only known for the ACTIVE wallet — that's the one the
  // indexer poll watches; anything else is honestly "not checked"
  const held = [];
  if (id === m.activeId && lastConfirmedDgb != null) {
    if (lastConfirmedDgb > 0) held.push(`${fmtDGB(lastConfirmedDgb)} DGB`);
    if (lastDdUsd > 0) held.push(`${fmtUSD(lastDdUsd)} DigiDollar`);
    if (openPositions.size > 0) held.push(`${openPositions.size} locked position${openPositions.size === 1 ? '' : 's'}`);
  }
  const lines = [];
  if (held.length) lines.push(`This wallet holds ${held.join(', ')}.`);
  else if (id === m.activeId) {
    lines.push(lastConfirmedDgb != null
      ? 'This wallet holds no funds the indexer can see.'
      : 'Its balance could not be checked.'); // no indexer on this deployment
  } else lines.push('Its balance was not checked — only the active wallet is watched.');
  lines.push(w.backedUp
    ? 'You verified its seed phrase backup — that phrase can restore it later.'
    : 'This wallet is NOT backed up — removing it without the seed phrase means the funds are unrecoverable.');
  if (m.wallets.length === 1) lines.push('It is the last wallet on this device: removing it erases the vault entirely.');
  $('w-remove-warnings').innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join('');
  $('w-remove-name').value = '';
  $('w-remove-go').disabled = true;
  $('w-remove-err').textContent = '';
}

// the confirm button arms only on an exact (trimmed) name match
$('w-remove-name').addEventListener('input', () => {
  const w = vault.meta()?.wallets.find((x) => x.id === removingId);
  $('w-remove-go').disabled = !w || $('w-remove-name').value.trim() !== w.name;
});
$('w-remove-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('w-remove-go').disabled) $('w-remove-go').click(); });
$('w-remove-cancel').addEventListener('click', () => showRemoveView(null));

$('w-remove-go').addEventListener('click', (e) =>
  busy(e.target, 'w-remove-err', async () => {
    const id = removingId;
    await vault.removeWallet(id); // last wallet → deletes the vault record (§5)
    showRemoveView(null);
    if (vault.status === 'none') {
      // nothing left on this device — back to the guest hero
      wallet.id = null; wallet.mnemonic = null; wallet.seed = null;
      resetWalletState();
      show('none');
    } else if (id === wallet.id) {
      // removed the wallet being viewed: the vault handed active to the
      // adjacent one; re-run the switch path so the open view never keeps
      // showing a removed wallet (§5)
      switchToWallet(vault.meta().activeId);
    } else {
      renderWalletList(); // stay in the list, minus one row
    }
  }));

// ---- Balance & history (#5): every query goes through the indexer seam ----
const fmtSats = (sats) => fmtDGB(Number(sats) / 1e8);

async function fetchIndexer(path) {
  const res = await fetch('/api/indexer' + path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** Every derivation the wallet watches: indices up to the current one, +2 lookahead. */
function watchedDerivations() {
  return Array.from({ length: wallet.index + 3 }, (_, i) =>
    deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }));
}

// DigiDollar positions (#13): locked mints are NOT part of the DGB balance —
// they render as their own list ($ amount, tier, collateral, expiry date).
const SECONDS_PER_BLOCK = 15;
let openPositions = new Map(); // txid → { position, address } — feeds the redeem flow

// Activity list state (#69): the merged per-address history plus a client-side
// cache of each tx's enrichment. Non-final txs are re-fetched each poll (their
// confirmation count still climbs); a tx is cached for good only once final.
const FINAL_CONF = 6;            // Android parity: 6+ confirmations = final
let allHistory = [];             // merged {txid, height}, newest-first
let historyLimit = 8;            // "Show more" bumps this by 8
const txDetailCache = new Map(); // txid → /api/tx enrichment
let myAddrSet = new Set();       // lowercased wallet addresses (P2TR + P2WPKH twin)
// history amounts/fees want sat-level precision — fmtDGB caps at 2 decimals and
// would swallow a fee to "0". Trim to significant digits instead.
const fmtDgb8 = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
function renderPositions(perAddr) {
  const seen = new Set();
  const positions = perAddr.flatMap((r) => r.positions.positions.map((p) => ({ ...p, address: r.positions.address })))
    .filter((p) => (seen.has(p.txid) ? false : seen.add(p.txid)));
  openPositions = new Map(positions.map((p) => [p.txid, p]));
  const tipHeight = Math.max(0, ...perAddr.map((r) => r.positions.tipHeight));
  const totalCents = positions.reduce((n, p) => n + Number(p.ddCents), 0);
  $('w-dd-total').textContent = positions.length ? fmtUSD(totalCents / 100) : '';
  if (!positions.length) {
    $('w-positions').textContent = 'No open positions.';
    return;
  }
  $('w-positions').innerHTML = positions.map((p) => {
    const blocksLeft = p.unlockHeight - tipHeight;
    // AC (#16): a still-locked position says exactly when it opens instead of
    // offering a redeem that consensus (CLTV) would reject.
    const state = blocksLeft > 0
      ? `<span class="warn-text">locked until ≈ ${new Date(Date.now() + blocksLeft * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA')} (block ${p.unlockHeight.toLocaleString('en-US')})</span>`
      : `<button class="secondary" data-redeem="${esc(p.txid)}" style="width:auto;padding:1px 10px;margin:0">Redeem</button>`;
    return `<div>${fmtUSD(Number(p.ddCents) / 100)} · ${esc(p.tierLabel)} · ` +
      `locked ${fmtSats(BigInt(p.collateralSats))} DGB · ${state}</div>`;
  }).join('');
}

async function refreshMoney() {
  // netKnown gate: querying the indexer with addresses derived for a GUESSED
  // network would render a confident zero balance — wait for the real chain
  // (the 8s poll picks up automatically once loadStatus succeeds).
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown) return;
  try {
    // Each derivation is watched at TWO addresses: its P2TR (receive address,
    // carries DD positions/tokens) and its P2WPKH twin — mint change lands
    // there by consensus (#38), so it must count toward balance and history.
    // DD lives on P2TR only; the twin contributes plain DGB.
    const addrs = watchedDerivations().flatMap((d) => [
      { address: d.address, dd: true },
      { address: d.p2wpkhAddress, dd: false },
    ]);
    const perAddr = await Promise.all(addrs.map(async ({ address: a, dd }) => ({
      utxos: (await fetchIndexer(`/address/${a}/utxos`)).utxos,
      history: (await fetchIndexer(`/address/${a}/history`)).history,
      positions: dd ? await fetchIndexer(`/address/${a}/positions`) : { address: a, positions: [], tipHeight: 0 },
      ddCents: dd ? BigInt((await fetchIndexer(`/address/${a}/dd-utxos`)).totalCents) : 0n,
    })));
    if (!wallet.seed) return; // locked while we were fetching
    const utxos = perAddr.flatMap((r) => r.utxos);
    const confirmed = utxos.filter((u) => u.height > 0).reduce((n, u) => n + Number(u.valueSats), 0);
    const pending = utxos.filter((u) => u.height === 0).reduce((n, u) => n + Number(u.valueSats), 0);
    $('w-balance').textContent = fmtDGB(confirmed / 1e8);
    $('as-dgb').textContent = fmtDGB(confirmed / 1e8);
    lastConfirmedDgb = confirmed / 1e8;
    renderFiat();
    $('w-pending-row').style.display = pending > 0 ? 'flex' : 'none';
    if (pending > 0) $('w-pending').textContent = fmtDGB(pending / 1e8);

    // Activity (#69): merge per-address history, then enrich the visible page
    // (direction, signed amount, fee, date, confirmations) via /api/tx/:txid.
    // Classification is wallet-side — only here is the full watched-address set
    // known, so a self-send between our own addresses nets correctly.
    myAddrSet = new Set(addrs.map(({ address }) => address.toLowerCase()));
    const seen = new Set();
    allHistory = perAddr.flatMap((r) => r.history)
      .filter((h) => (seen.has(h.txid) ? false : seen.add(h.txid)))
      .sort((a, b) => (a.height === 0 ? Infinity : a.height) < (b.height === 0 ? Infinity : b.height) ? 1 : -1);
    renderHistory();
    enrichVisible();
    const ddCents = perAddr.reduce((s, r) => s + r.ddCents, 0n);
    lastDdUsd = Number(ddCents) / 100;
    $('w-dd-balance').textContent = lastDdUsd.toLocaleString('en-US', { minimumFractionDigits: 2 });
    renderPositions(perAddr);
    renderBackupStrip(); // balance-gated (§3): fresh funds may summon the backup nag
    // a transient indexer hiccup shouldn't leave a stale error after recovery
    if ($('w-open-err').textContent.startsWith('indexer:')) $('w-open-err').textContent = '';
    const firstShow = $('w-money').style.display === 'none';
    $('loading-veil').style.display = 'none';
    $('w-money').style.display = 'grid';
    if (firstShow) renderSparkline(lastPriceSeries); // real width only now
  } catch (e) {
    $('loading-veil').style.display = 'none';
    // transport-level failures mean the index isn't serving yet (e.g. initial
    // ElectrumX sync after a deployment) — say that, not ECONNREFUSED
    $('w-open-err').textContent = /ECONNREFUSED|ETIMEDOUT|unreachable|socket|502|503/i.test(e.message)
      ? 'indexer: the balance index is still syncing — balances and history will appear once it catches up (your on-chain funds are unaffected)'
      : 'indexer: ' + e.message;
  }
}

// ---- Activity rendering (#69) ----
const DD_LABEL = { mint: 'Minted DigiDollar', redeem: 'Redeemed DigiDollar', transfer: 'DigiDollar transfer' };
const truncAddr = (a) => (a ? a.slice(0, 10) + '…' + a.slice(-4) : '');
function relTime(unixSec) {
  if (!unixSec) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString('en-CA');
}

function txExplorerLink(txid) {
  const short = txid.slice(0, 12) + '…';
  return appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
    ? `<a href="${appConfig.explorerTxUrl}${txid}" target="_blank" rel="noopener">${short}</a>`
    : `<span class="mono">${esc(short)}</span>`;
}

/** One Activity row. Thin (txid + pending/confirmed) until enrichment arrives. */
function historyRow(h) {
  const link = txExplorerLink(h.txid);
  const detail = txDetailCache.get(h.txid);
  if (!detail) {
    const conf = h.height === 0
      ? '<span class="tx-conf pending">pending</span>'
      : '<span class="tx-conf partial">confirmed</span>';
    return `<div class="tx"><div class="tx-icon out">·</div>` +
      `<div class="tx-main"><div class="tx-title">Transaction</div><div class="tx-sub">${link}</div></div>` +
      `<div class="tx-right">${conf}</div></div>`;
  }
  // The indexer is treated as untrusted (#55): parse only well-formed integers,
  // tolerate null/garbage array elements, and never interpolate a raw field.
  const sat = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : 0n);
  const isMine = (a) => typeof a === 'string' && myAddrSet.has(a.toLowerCase());
  const vin = (Array.isArray(detail.vin) ? detail.vin : []).filter((v) => v && typeof v === 'object');
  const vout = (Array.isArray(detail.vout) ? detail.vout : []).filter((o) => o && typeof o === 'object');
  // Amounts use OUTPUT flow, not net-of-inputs: the indexer caps prevout
  // resolution (server.js MAX_VIN_RESOLVE), so Σ(my inputs) is unreliable for a
  // >40-input send/consolidation. What LEFT the wallet = Σ(outputs to others);
  // what ARRIVED = Σ(outputs to us). Both come from vout, which is never capped.
  // We only need inputs to answer "did we send?" — true for any wallet-built tx
  // since its own coins fund vin[0] (within the resolved window). Fee is shown
  // separately, so excluding it from the amount matches how wallets read.
  const toOthers = vout.filter((o) => o.address && !isMine(o.address)).reduce((s, o) => s + sat(o.valueSats), 0n);
  const toMine = vout.filter((o) => isMine(o.address)).reduce((s, o) => s + sat(o.valueSats), 0n);
  const sent = vin.some((v) => isMine(v.address)); // we funded at least one (resolved) input
  const coinbase = vin.length > 0 && vin.every((v) => v.address == null && v.valueSats == null);
  const extOut = vout.find((o) => o.address && !isMine(o.address) && sat(o.valueSats) > 0n);
  const extIn = vin.find((v) => v.address && !isMine(v.address));

  let title, iconCls, icon, cp = '', amt;
  if (detail.type !== 'dgb') {
    // The DGB shown for a DD tx is the collateral movement: a mint locks it
    // (out), a redeem frees it (back to us); a DD-only transfer is DGB-neutral
    // (just the fee), so no DGB amount — the label carries the meaning.
    title = DD_LABEL[detail.type] || 'DigiDollar';
    iconCls = 'dd'; icon = '◆';
    amt = detail.type === 'mint' ? -toOthers : detail.type === 'redeem' ? toMine : 0n;
    cp = sent && extOut ? `to ${truncAddr(extOut.address)}` : (extIn ? `from ${truncAddr(extIn.address)}` : '');
  } else if (sent) {
    title = toOthers > 0n ? 'Sent' : 'Sent to self';
    iconCls = 'out'; icon = '↑'; amt = -toOthers;
    cp = extOut ? `to ${truncAddr(extOut.address)}` : '';
  } else {
    title = coinbase ? 'Mined' : 'Received';
    iconCls = 'in'; icon = '↓'; amt = toMine;
    cp = !coinbase && extIn ? `from ${truncAddr(extIn.address)}` : '';
  }

  const amtCls = amt > 0n ? 'in' : 'out';
  const sign = amt > 0n ? '+' : amt < 0n ? '−' : '';
  const amtStr = amt === 0n ? '' : `${sign}${fmtDgb8(amt < 0n ? -amt : amt)} DGB`; // no misleading "0 DGB"
  const c = Number(detail.confirmations) || 0; // coerce: a number never carries markup
  const conf = (c <= 0 || h.height === 0)
    ? '<span class="tx-conf pending">pending</span>'
    : c >= FINAL_CONF ? '<span class="tx-conf final">✓ final</span>'
      : `<span class="tx-conf partial">${c} conf</span>`;
  const feeStr = sent && detail.feeSats != null ? `fee ${fmtDgb8(sat(detail.feeSats))} DGB` : '';
  const time = Number(detail.time) || 0;
  const sub = [cp, relTime(time), feeStr].filter(Boolean).join(' · ');

  return `<div class="tx">` +
    `<div class="tx-icon ${iconCls}">${icon}</div>` +
    `<div class="tx-main"><div class="tx-title">${esc(title)}</div>` +
    `<div class="tx-sub">${esc(sub)}${sub ? ' · ' : ''}${link}</div></div>` +
    `<div class="tx-right"><div class="tx-amt ${amtCls}">${amtStr}</div>${conf}</div></div>`;
}

function renderHistory() {
  const shown = allHistory.slice(0, historyLimit);
  const rows = shown.map(historyRow).join('');
  const more = allHistory.length > historyLimit
    ? '<button id="w-history-more" class="secondary">Show more</button>' : '';
  $('w-history').innerHTML = rows + more || 'No transactions yet.';
  const mb = $('w-history-more');
  if (mb) mb.addEventListener('click', () => { historyLimit += 8; renderHistory(); enrichVisible(); });
}

/** Fetch enrichment for the visible page; re-render as details arrive. A tx is
 *  re-fetched every poll until it reaches finality (FINAL_CONF confirmations) —
 *  before then its confirmation count (and the pending→mined flip) still change,
 *  so a cached entry would otherwise freeze at "pending"/its first count. */
async function enrichVisible() {
  const targets = allHistory.slice(0, historyLimit).filter((h) => {
    if (!/^[0-9a-f]{64}$/.test(h.txid)) return false;
    const d = txDetailCache.get(h.txid);
    return !d || (Number(d.confirmations) || 0) < FINAL_CONF;
  });
  if (!targets.length) return;
  await Promise.all(targets.map(async (h) => {
    try { txDetailCache.set(h.txid, await fetchIndexer(`/tx/${h.txid}`)); } catch { /* keep the thin row */ }
  }));
  renderHistory();
}

// fiat equivalents (hero + asset row) from the latest oracle price
let lastConfirmedDgb = null;
let lastDdUsd = 0; // spendable DD of the active wallet — remove-ceremony warning
function renderFiat() {
  const has = lastPriceUsd != null && lastConfirmedDgb != null;
  $('w-balance-usd').textContent = has ? '≈ ' + fmtUSD(lastConfirmedDgb * lastPriceUsd) : '';
  $('as-dgb-usd').textContent = has ? fmtUSD(lastConfirmedDgb * lastPriceUsd) : '';
}

// live collateral estimate in the mint modal (exact Core arithmetic, same
// requiredCollateralSats the review step uses — just non-binding and instant)
function updateMintEstimate() {
  const el = $('mint-estimate');
  try {
    const cents = ddToCents($('w-mint-amount').value || '0');
    if (cents <= 0n || lastPriceMicroUsd == null) { el.textContent = ''; return; }
    const tier = LOCK_TIERS.find((t) => t.id === $('w-mint-tier').value) || LOCK_TIERS[0];
    const bps = lastDcaBps ?? 10_000n;
    const sats = requiredCollateralSats({ ddCents: cents, tierId: tier.id, oraclePriceMicroUsd: lastPriceMicroUsd, dcaMultiplierBps: bps });
    const ratio = effectiveRatioPercent(tier.ratioPercent, bps);
    el.textContent = `≈ ${fmtSats(sats)} DGB collateral (${ratio}% · ${tier.label} lock)` + (dcaNote() ? ` · ${dcaNote()}` : '');
  } catch {
    el.textContent = ''; // partial input while typing
  }
}
$('w-mint-amount').addEventListener('input', updateMintEstimate);
$('w-mint-tier').addEventListener('change', updateMintEstimate);

// ---- DGB price sparkline (24h, /api/price-history) ----
let lastPriceSeries = null; // cached so re-docking/resizing can re-render
async function loadPriceChart() {
  try {
    const { series } = await (await fetch('/api/price-history')).json();
    lastPriceSeries = series;
    renderSparkline(series);
  } catch { /* chart is decorative — never block the wallet on it */ }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderSparkline(lastPriceSeries), 200);
});

function renderSparkline(series) {
  const svg = $('price-chart');
  const tip = $('chart-tip');
  if (!Array.isArray(series) || series.length < 2) {
    svg.replaceChildren();
    $('price-delta').textContent = '';
    $('price-hint').textContent = 'Collecting price history — the chart appears after a few samples.';
    return;
  }
  $('price-hint').textContent = '';
  const W = $('chart-wrap').clientWidth || 430;
  const isDocked = Boolean($('price-block').closest('.hero'));
  const H = isDocked ? 72 : 96;
  const PAD = 6;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  // Downsample to a calm neobank-style curve: ~fifty averaged buckets instead
  // of every raw sample, then a Catmull-Rom smooth through them.
  const TARGET = 48;
  let pts = series;
  if (series.length > TARGET) {
    const step = series.length / TARGET;
    pts = Array.from({ length: TARGET }, (_, i) => {
      const chunk = series.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
      return {
        t: chunk[chunk.length - 1].t,
        price_micro_usd: chunk.reduce((s, p) => s + p.price_micro_usd, 0) / chunk.length,
      };
    });
    pts[pts.length - 1] = series[series.length - 1]; // end on the live price
  }
  const ts = pts.map((p) => p.t);
  const vs = pts.map((p) => p.price_micro_usd);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  let vMin = Math.min(...vs);
  let vMax = Math.max(...vs);
  if (vMin === vMax) { vMin -= 1; vMax += 1; } // flat series still draws a line
  const pad = (vMax - vMin) * 0.08;
  vMin -= pad; vMax += pad;
  const x = (t) => PAD + ((t - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v) => PAD + (1 - (v - vMin) / (vMax - vMin)) * (H - 2 * PAD);
  const P = pts.map((p) => [x(p.t), y(p.price_micro_usd)]);
  // Catmull-Rom → cubic beziers: one flowing line, no jagged segments
  let line = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    line += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ` +
      `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ` +
      `${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  // 2px accent curve over a soft vertical gradient; end-dot with surface ring
  svg.innerHTML =
    `<defs><linearGradient id="price-grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="var(--accent)" stop-opacity=".20"></stop>` +
    `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"></stop>` +
    `</linearGradient></defs>` +
    `<path d="${line}L${x(t1).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z" fill="url(#price-grad)"></path>` +
    `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>` +
    `<line class="hair" y1="0" y2="${H}" stroke="var(--gray-300)" stroke-width="1" style="display:none"></line>` +
    `<circle class="hover-dot" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2" style="display:none"></circle>` +
    `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.price_micro_usd).toFixed(1)}" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2"></circle>`;
  const raw = series.map((p) => p.price_micro_usd);
  const delta = ((raw[raw.length - 1] - raw[0]) / raw[0]) * 100;
  $('price-delta').textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% · 24h`;
  $('price-delta').className = 'price-delta ' + (delta >= 0 ? 'up' : 'down');
  // crosshair snaps to the nearest sample; tooltip shows its value + time
  const fmtP = (micro) => '$' + (micro / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
  svg.onpointermove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const tAt = t0 + ((ev.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(ts[i] - tAt) < Math.abs(ts[best] - tAt)) best = i;
    const p = pts[best];
    const hair = svg.querySelector('.hair');
    const dot = svg.querySelector('.hover-dot');
    hair.setAttribute('x1', x(p.t)); hair.setAttribute('x2', x(p.t)); hair.style.display = '';
    dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.price_micro_usd)); dot.style.display = '';
    tip.querySelector('.tv').textContent = fmtP(p.price_micro_usd);
    tip.querySelector('.tk').textContent = new Date(p.t * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    tip.style.left = `${(x(p.t) / W) * 100}%`;
    tip.style.top = '0';
    tip.style.display = 'block';
  };
  svg.onpointerleave = () => {
    tip.style.display = 'none';
    svg.querySelector('.hair').style.display = 'none';
    svg.querySelector('.hover-dot').style.display = 'none';
  };
}

// ---- Send DGB (#6): plan → confirmation screen → sign → broadcast ----
// Nothing is signed until the user presses "Confirm & send"; the plan step only
// selects UTXOs and prices the fee so the confirmation can display them.

/** "1.5" → 150000000n without float rounding (8 decimal places max). */
function dgbToSats(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error('enter the amount as a plain number, e.g. 1.5');
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}
const satsToDgb = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** Every watched derivation (address + its key), spendable UTXOs attached.
 * Includes each key's P2WPKH twin — mint change (#38) — tagged type:'p2wpkh'
 * so planSpend prices it and buildSignedSpendTx signs it per BIP-143. */
async function spendableUtxos() {
  const perAddr = await Promise.all(watchedDerivations().flatMap((d) => [
    { address: d.address, type: undefined, privKeyHex: d.privKeyHex },
    { address: d.p2wpkhAddress, type: 'p2wpkh', privKeyHex: d.privKeyHex },
  ].map(async ({ address, type, privKeyHex }) => {
    const { utxos } = await fetchIndexer(`/address/${address}/utxos`);
    return utxos.map((u) => ({
      txidHex: u.txid, vout: u.vout, valueSats: BigInt(u.valueSats), height: Number(u.height), privKeyHex, ...(type && { type }),
    }));
  })));
  return perAddr.flat();
}

let pendingSend = null; // { plan, recipientScriptHex, amountSats, address } while confirming

function resetSend() {
  pendingSend = null;
  $('w-send-confirm').style.display = 'none';
  $('w-send-review').disabled = false;
}

// A pasted/scanned BIP21 `digibyte:` URI in the recipient field is unpacked into
// its parts (#71): the bare address replaces the field value, an embedded amount
// prefills the amount field (unless the user already typed one), and label/message
// show as read-only context. Bare addresses are untouched. Called from the input
// listener (live paste) and defensively from review (drivers set .value directly,
// which fires no input event). Idempotent: re-running on a bare address is a no-op.
function absorbSendUri() {
  const parsed = parseBip21($('w-send-to').value);
  if (!parsed) return;
  if (parsed.address !== $('w-send-to').value.trim()) $('w-send-to').value = parsed.address;
  if (parsed.amountSats != null && parsed.amountSats > 0n && !$('w-send-amount').value.trim()) {
    // satsToDgbString (not the locale-formatted satsToDgb): no thousands commas,
    // so the value stays parseable by dgbToSats at review for amounts ≥ 1000 DGB.
    $('w-send-amount').value = satsToDgbString(parsed.amountSats);
  }
  const ctx = [parsed.label && `Label: ${parsed.label}`, parsed.message && `Message: ${parsed.message}`]
    .filter(Boolean).join(' · ');
  $('w-send-uri-ctx').textContent = ctx;
  $('w-send-uri-ctx').style.display = ctx ? 'block' : 'none';
}
$('w-send-to').addEventListener('input', absorbSendUri);

// ---- Fiat entry + send-max on the DGB send (#70) ----
// The amount can be typed in DGB or USD; USD is converted through the SAME
// oracle price the header shows (lastPriceMicroUsd), integer-only so the signed
// tx matches the review-time quote exactly. Send-max drains the confirmed,
// non-DD balance via planMaxSpend (one output, zero change).
let sendCcy = 'DGB';      // 'DGB' | 'USD' — active entry currency
let sendMaxArmed = false; // true once "Max" is clicked, until the amount is edited

// USD is only offered when the oracle price is present AND fresh (not stale) —
// same gate the mint flow uses. Stale/missing price → DGB-only entry.
const priceUsable = () => lastPriceMicroUsd != null && lastPriceMicroUsd > 0n && netHealth.oracle === true;

/** "12.50" USD → sats, floored, via the live micro-USD/DGB oracle price. */
function usdToSats(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error('enter the USD amount as a plain number, e.g. 12.50');
  if (!priceUsable()) throw new Error('no fresh oracle price for USD conversion');
  const microUsd = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return (microUsd * 100_000_000n) / lastPriceMicroUsd; // 1 DGB = 1e8 sats
}

/** The amount the user asked for, in sats, honouring the active currency. */
function sendAmountSats() {
  return sendCcy === 'USD' ? usdToSats($('w-send-amount').value) : dgbToSats($('w-send-amount').value);
}

const satsToUsd = (sats) => lastPriceUsd != null ? Number(sats) * lastPriceUsd / 1e8 : null;

// USD value of a sats amount for the $500 beta cap (#54), from a price fetched
// FRESH at review time — never the cached lastPriceUsd. Returns null (→ the
// warn-allow path, decision #6) off-mainnet, or when the node has no quote or
// reports it stale, so the cap never enforces at a wrong/boot-time rate.
async function freshCapUsd(amountSats) {
  if (chainState.netName !== 'mainnet') return null; // cap is mainnet-only
  try {
    const price = await rpc('getoracleprice');
    if (!price?.price_micro_usd || price.is_stale) return null;
    // price_micro_usd is µUSD per DGB; amountSats is 1e-8 DGB
    return Number(amountSats) * Number(price.price_micro_usd) / 1e14;
  } catch {
    return null; // node unreachable / no quote → couldn't verify
  }
}

/** Live "≈ …" line under the input, showing the amount in the other currency. */
function updateSendEq() {
  const el = $('w-send-amount-eq');
  const raw = $('w-send-amount').value.trim();
  let out = '';
  if (raw) {
    try {
      if (sendCcy === 'USD') out = '≈ ' + satsToDgbString(usdToSats(raw)) + ' DGB';
      else { const usd = satsToUsd(dgbToSats(raw)); if (usd != null) out = '≈ ' + fmtUSD(usd); }
    } catch { out = ''; }
  }
  el.textContent = out;
  el.style.display = out ? 'block' : 'none';
}

function setSendCcy(ccy) {
  sendCcy = ccy;
  $('w-send-amount-label').textContent = `Amount (${ccy})`;
  $('w-send-ccy').textContent = '⇄ ' + (ccy === 'DGB' ? 'USD' : 'DGB');
  $('w-send-ccy').title = ccy === 'DGB' ? 'Enter the amount in USD instead' : 'Enter the amount in DGB instead';
  $('w-send-amount').placeholder = ccy === 'USD' ? '0.00' : '';
  updateSendEq();
}

// Keep the currency control in sync with oracle freshness. Called on every
// status poll: if the price goes stale while USD is active, fall back to DGB.
function syncSendPriceGate() {
  const ok = priceUsable();
  $('w-send-ccy').disabled = !ok;
  if (!ok) {
    $('w-send-ccy').title = 'USD entry needs a fresh oracle price';
    if (sendCcy === 'USD') setSendCcy('DGB');
  } else if (sendCcy === 'DGB') {
    $('w-send-ccy').title = 'Enter the amount in USD instead';
  }
}

$('w-send-ccy').addEventListener('click', () => {
  if ($('w-send-ccy').disabled) return;
  setSendCcy(sendCcy === 'DGB' ? 'USD' : 'DGB');
});

// Manual edits override an armed max.
$('w-send-amount').addEventListener('input', () => { sendMaxArmed = false; updateSendEq(); });

// Max: fill the field with the entire spendable balance (confirmed, non-DD),
// and arm the max path so review recomputes it exactly against fresh UTXOs.
$('w-send-max').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    if (!wallet.seed) throw new Error('wallet is locked');
    if (!appConfig.indexer || !chainState.netKnown) throw new Error('balance is unavailable right now');
    absorbSendUri();
    // Price the output against the recipient's script when we have one (legacy
    // outputs are smaller); else assume P2TR — review recomputes exactly anyway.
    let recipientScriptHex;
    const addr = $('w-send-to').value.trim();
    if (addr) { try { recipientScriptHex = decodeAddress(addr).scriptPubKeyHex; } catch { /* refine at review */ } }
    const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
    const plan = planMaxSpend({ utxos: spendable, recipientScriptHex });
    sendMaxArmed = true;
    if (sendCcy === 'USD' && priceUsable()) $('w-send-amount').value = satsToUsd(plan.amountSats).toFixed(2);
    else { if (sendCcy === 'USD') setSendCcy('DGB'); $('w-send-amount').value = satsToDgbString(plan.amountSats); }
    updateSendEq();
  }));

$('w-send-review').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    $('w-send-out').textContent = '';
    absorbSendUri(); // handle a URI set programmatically (no input event fired)
    const address = $('w-send-to').value.trim();
    // DGB sends accept every address type: segwit bech32/bech32m AND legacy
    // base58check P2PKH (D…)/P2SH (S…/3…). decodeAddress normalizes all of them.
    let decoded;
    try {
      decoded = decodeAddress(address);
    } catch (err) {
      throw new Error(`invalid address: ${err.message}`);
    }
    if (!decoded.networks.includes(chainState.netName)) {
      throw new Error(`address is not for this network (need a ${chainState.netName} address)`);
    }
    const recipientScriptHex = decoded.scriptPubKeyHex;
    let amountSats, plan;
    if (sendMaxArmed) {
      // Max: recompute against fresh confirmed, non-DD coins with the real
      // recipient script — one output, zero change (planMaxSpend). This is the
      // quote the tx is built from, so no re-quote happens between here and sign.
      const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
      const m = planMaxSpend({ utxos: spendable, recipientScriptHex });
      ({ amountSats } = m);
      plan = { inputs: m.inputs, feeSats: m.feeSats };
    } else {
      amountSats = sendAmountSats(); // DGB or USD, converted at review time
      if (amountSats <= 0n) throw new Error('amount must be positive');
      plan = planSpend({ utxos: await spendableUtxos(), amountSats, recipientScriptHex });
    }
    // $500/tx beta cap (#54). Price it from a FRESH quote fetched at review
    // time — not the boot-time lastPriceUsd, which never refreshes and would
    // fail open after a transient oracle hiccup or under-count as DGB drifts
    // (the mint flow already re-fetches here). A stale or unavailable quote is
    // treated as "couldn't verify" → warn on the confirm screen, ALLOW the
    // send (decision #6). capUsd is null off-mainnet (the cap is mainnet-only).
    const capUsd = await freshCapUsd(amountSats);
    const capErr = betaCapError(chainState.netName, capUsd);
    if (capErr) throw new Error(`${capErr} (this send is ≈ ${fmtUSD(capUsd)})`);
    const capUnverified = chainState.netName === 'mainnet' && capUsd == null;
    $('w-send-c-capnote').style.display = capUnverified ? 'block' : 'none';
    // prefer the fresh cap price for the confirm estimate; fall back to the
    // cached oracle price off-mainnet or when the cap price was unavailable
    const usd = capUsd ?? satsToUsd(amountSats);
    pendingSend = { plan, recipientScriptHex, amountSats, address };
    $('w-send-c-to').textContent = address;
    $('w-send-c-amount').textContent = satsToDgb(amountSats);
    $('w-send-c-amount-usd').textContent = usd != null ? `  ≈ ${fmtUSD(usd)}` : '';
    $('w-send-c-fee').textContent = satsToDgb(plan.feeSats);
    $('w-send-confirm').style.display = 'block';
    $('w-send-review').disabled = true;
  }));

$('w-send-cancel').addEventListener('click', resetSend);

$('w-send-go').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    const { plan, recipientScriptHex, amountSats } = pendingSend;
    if (!wallet.seed) throw new Error('wallet is locked');
    // change returns to the wallet's current receive address
    const changeAddress = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
    const { hex } = buildSignedSpendTx({
      utxos: plan.inputs,
      recipientScriptHex,
      amountSats,
      changeScriptHex: scriptPubKeyFromAddress(changeAddress),
      feeSats: plan.feeSats,
    });
    const txid = await broadcastTx(hex);
    resetSend();
    sendMaxArmed = false;
    $('w-send-to').value = '';
    $('w-send-amount').value = '';
    $('w-send-amount-eq').style.display = 'none';
    $('w-send-uri-ctx').style.display = 'none';
    $('w-send-out').textContent = `Sent — tx ${txid.slice(0, 16)}…`;
    showTxSuccess('send-modal', txid, 'Transaction sent', 'It appears in Activity as pending until the next block confirms it.');
    refreshMoney();
  }));

// ---- Guided consolidation (#103 decision 2) ----
// When a plan fails only because the balance is FRAGMENTED — it covers the
// amount, but no single qualifying coin does — the error area offers
// "Consolidate coins": ONE self-spend of every confirmed DGB coin (P2WPKH
// twins included, #38/decision 3) to the CURRENT taproot receive address, so
// the retry finds one big P2TR coin. NEVER automatic: the user reviews the
// coin count and fee in this modal and confirms, like any other spend.

/** An error the Consolidate offer can actually fix. busy() reads the flag. */
function fragmentationError(msg) {
  const e = new Error(msg);
  e.consolidatable = true;
  return e;
}

let pendingConsolidate = null; // { plan, toAddress } — plan.inputs hold per-UTXO keys

function resetConsolidate() {
  pendingConsolidate = null;
  $('consolidate-modal').classList.remove('open');
}

async function openConsolidateModal() {
  // normal gating (#103): a locked wallet has no keys to plan with, and an
  // open connect/backup ceremony keeps its modal in front — never plan under it
  if (!wallet.seed || $('w-connect-modal').classList.contains('open')) return;
  pendingConsolidate = null;
  $('consolidate-modal').classList.remove('success');
  $('w-cons-err').textContent = '';
  $('w-cons-confirm').style.display = 'none';
  openModal('consolidate-modal');
  try {
    if (!appConfig.indexer || !chainState.netKnown) throw new Error('balance is unavailable right now');
    const current = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
    const toAddress = current.address;
    // confirmed, non-DD coins only — the same set Send-max drains. planMaxSpend
    // prices the one-output tx: amount = Σ(inputs) − fee, zero change. No $500
    // beta cap here: a self-spend moves nothing out of the wallet — capping it
    // would strand any balance above the cap fragmented forever.
    const spendable = (await spendableUtxos()).filter((u) => u.height > 0 && u.valueSats > 0n);
    if (spendable.length === 0) throw new Error('no confirmed coins to consolidate');
    // ONE coin is not always pointless: a sole P2WPKH twin (the common
    // post-mint case — mint change lands as v0) still needs consolidating,
    // because the self-spend converts it to key-path P2TR on the current
    // address, which the mint/transfer/redeem builders require. Same for a
    // sole P2TR coin on an OLD address: the fee gates want it on the current
    // one. Only a single P2TR coin ALREADY on the current address gains
    // nothing — a self-spend there would change nothing but pay a fee.
    if (spendable.length === 1 && spendable[0].type !== 'p2wpkh' && spendable[0].privKeyHex === current.privKeyHex) {
      throw new Error('your DGB is already a single coin on your current address — consolidating would only pay a fee');
    }
    const plan = planMaxSpend({ utxos: spendable, recipientScriptHex: scriptPubKeyFromAddress(toAddress) });
    pendingConsolidate = { plan, toAddress };
    $('w-cons-c-count').textContent = String(plan.inputs.length);
    $('w-cons-c-amount').textContent = satsToDgb(plan.amountSats);
    $('w-cons-c-to').textContent = toAddress;
    $('w-cons-c-fee').textContent = satsToDgb(plan.feeSats);
    $('w-cons-confirm').style.display = 'block';
  } catch (e) {
    $('w-cons-err').textContent = surfaceError(e);
  }
}
for (const id of ['w-send-err-consolidate', 'w-mint-err-consolidate', 'w-tr-err-consolidate', 'w-rd-err-consolidate']) {
  $(id).addEventListener('click', openConsolidateModal);
}

$('w-cons-go').addEventListener('click', (e) =>
  busy(e.target, 'w-cons-err', async () => {
    if (!wallet.seed) throw new Error('wallet is locked');
    if (!pendingConsolidate) throw new Error('nothing planned — close and reopen this dialog');
    const { plan, toAddress } = pendingConsolidate;
    const script = scriptPubKeyFromAddress(toAddress);
    const { hex } = buildSignedSpendTx({
      utxos: plan.inputs,
      recipientScriptHex: script,
      amountSats: plan.amountSats,
      changeScriptHex: script, // zero change by construction (max plan) — same address either way
      feeSats: plan.feeSats,
    });
    const txid = await broadcastTx(hex);
    pendingConsolidate = null;
    showTxSuccess('consolidate-modal', txid, 'Consolidation sent',
      'Once the next block confirms it, retry the action that failed — your DGB will be one coin.');
    refreshMoney();
  }));

// ---- Mint DigiDollar (#14): plan → confirmation screen → sign → broadcast ----
// Feature-flagged (ADR-0002). Distinct, actionable errors for the three ways
// this can be impossible: softfork inactive, stale oracle quote, and not
// enough (or too fragmented) DGB for the collateral.
const MINT_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's 0.1 DGB DD fee floor

/** "100.5" → 10050n DD cents (2 decimal places max). */
function ddToCents(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error('enter the DigiDollar amount as a plain number, e.g. 100 or 99.50');
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

function initMintTiers() {
  $('w-mint-tier').innerHTML = LOCK_TIERS
    .map((t) => `<option value="${t.id}">${t.label} — ${t.ratioPercent}% collateral</option>`)
    .join('');
  // Tier slider UI over the hidden native select (still the source of truth —
  // drivers keep setting .value on it directly).
  const slider = $('tier-slider');
  slider.max = String(LOCK_TIERS.length - 1);
  const syncFromSelect = () => {
    const i = Math.max(0, LOCK_TIERS.findIndex((t) => t.id === $('w-mint-tier').value));
    const tier = LOCK_TIERS[i];
    slider.value = String(i);
    $('tier-name').textContent = tier.label;
    // the pill quotes the EFFECTIVE ratio — the estimate line explains the DCA
    $('tier-ratio').textContent = effectiveRatioPercent(tier.ratioPercent, lastDcaBps ?? 10_000n) + '% collateral';
    const p = (i / (LOCK_TIERS.length - 1)) * 100;
    slider.style.background = `linear-gradient(90deg, var(--accent) ${p}%, var(--gray-200) ${p}%)`;
  };
  slider.addEventListener('input', () => {
    $('w-mint-tier').value = LOCK_TIERS[Number(slider.value)].id;
    $('w-mint-tier').dispatchEvent(new Event('change', { bubbles: true }));
  });
  $('w-mint-tier').addEventListener('change', syncFromSelect);
  refreshTierReadout = syncFromSelect;
  syncFromSelect();
}

let pendingMint = null; // { utxo (with privKeyHex!), ddCents, tierId, priceMicroUsd } while confirming

function resetMint() {
  pendingMint = null;
  $('w-mint-confirm').style.display = 'none';
  $('w-mint-review').disabled = false;
}

const blocksToDate = (blocks) =>
  new Date(Date.now() + blocks * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA');

$('w-mint-review').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    $('w-mint-out').textContent = '';
    // 1. softfork gate — minting is consensus-impossible while inactive
    if (chainState.ddActive === false) {
      throw new Error('DigiDollar is not active on this network yet — minting is impossible until the softfork activates. Watch the Status card.');
    }
    const ddCents = ddToCents($('w-mint-amount').value);
    if (ddCents <= 0n) throw new Error('amount must be positive');
    // consensus limits — the node would reject with bad-dd-mint-amount AFTER signing
    const limits = DD_TX_LIMITS[chainState.netName];
    const fmtC = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    if (ddCents < limits.minMintCents) {
      throw new Error(`this network's consensus minimum is ${fmtC(limits.minMintCents)} per mint — enter at least that`);
    }
    if (ddCents > limits.maxMintCents) {
      throw new Error(`this network's consensus maximum is ${fmtC(limits.maxMintCents)} per mint`);
    }
    // $500/tx beta cap (#54) — USD-native, so it applies regardless of the price feed
    const mintCapErr = betaCapError(chainState.netName, Number(ddCents) / 100);
    if (mintCapErr) throw new Error(mintCapErr);
    const tierId = $('w-mint-tier').value;
    const tier = LOCK_TIERS.find((t) => t.id === tierId);
    // 2. oracle gate — a stale quote would be rejected by mempool policy anyway
    const price = await rpc('getoracleprice');
    if (!price?.price_micro_usd) throw new Error('oracle price unavailable — the node returned no quote');
    if (price.is_stale) {
      throw new Error('the oracle price is stale — the network has not published a fresh quote; try again in a few minutes');
    }
    const priceMicroUsd = BigInt(price.price_micro_usd);
    // consensus sanity bounds — say so BEFORE signing. Sub-cent DGB
    // prices are valid: the micro-USD path has no $0.01 floor.
    if (priceMicroUsd < ORACLE_MIN_PRICE_MICRO_USD || priceMicroUsd > ORACLE_MAX_PRICE_MICRO_USD) {
      throw new Error(`the oracle price ($${(Number(priceMicroUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })}/DGB) is outside the consensus bounds $0.0001–$100 — the network would reject this mint`);
    }
    // 3. volatility gate (#62): consensus freezes mints on sharp price moves.
    // Best-effort — if the status RPC is unavailable the broadcast error
    // mapping still catches the reject, but warning BEFORE signing is kinder.
    const prot = await rpc('getprotectionstatus').catch(() => null);
    if (prot?.volatility?.minting_restricted) {
      // covers the ≥50%/7d all-operations freeze too: Core sets mintingFrozen
      // whenever allOperationsFrozen is set (consensus/volatility.cpp)
      throw new Error(MINT_FREEZE_EXPLANATION + ' Your funds are untouched — try again once the market calms.');
    }
    if (prot?.oracle?.minting_restricted) {
      throw new Error('minting is restricted: the node reports no usable oracle price' + (prot.oracle.minting_restricted_reason ? ` (${prot.oracle.minting_restricted_reason})` : '') + ' — try again in a few minutes');
    }
    // 4. honest quote (#62): the node's DCA multiplier scales the required
    // collateral with network health — without it a degraded-system quote
    // would be too low and the mint rejected after signing.
    const dca = await rpc('getdcamultiplier');
    const dcaMultiplierBps = dcaBpsFromMultiplier(dca.multiplier);
    lastDcaBps = dcaMultiplierBps; // keep the live preview in step with the review
    lastDcaInfo = dca;
    const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd: priceMicroUsd, dcaMultiplierBps });
    const needSats = collateralSats + MINT_FEE_SATS;
    // 5. funding gate — the mint spends ONE UTXO, so it must cover everything.
    // Only P2TR coins qualify: buildSignedMintTx signs key-path taproot (a
    // p2wpkh coin — earlier mint change — is consolidated via Send first).
    const utxos = await spendableUtxos();
    const totalSats = utxos.reduce((s, u) => s + u.valueSats, 0n);
    const utxo = utxos.filter((u) => u.type !== 'p2wpkh' && u.valueSats >= needSats)
      .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
    if (!utxo) {
      // fragmented (not insufficient) funds are fixable by the guided
      // consolidation — the flag reveals the "Consolidate coins" offer (#103)
      throw totalSats >= needSats
        ? fragmentationError(`your balance covers it, but no single coin is large enough (a mint spends one coin). Send ${fmtSats(needSats)} DGB to your own address to consolidate, then retry.`)
        : new Error(`insufficient funds: this mint needs ${fmtSats(needSats)} DGB (collateral + fee), you have ${fmtSats(totalSats)} DGB`);
    }
    const { blocks: tipHeight } = await rpc('getblockchaininfo');
    const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
    pendingMint = { utxo, ddCents, tierId, priceMicroUsd, dcaMultiplierBps };
    $('w-mint-c-dd').textContent = (Number(ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-mint-c-coll').textContent = fmtSats(collateralSats);
    // the ratio row makes a degraded-health quote visibly different (#62)
    const effRatio = effectiveRatioPercent(tier.ratioPercent, dcaMultiplierBps);
    $('w-mint-c-ratio').textContent = dcaNote()
      ? `${effRatio}% (${tier.ratioPercent}% base, ${dcaNote()})`
      : `${effRatio}%`;
    // 6 digits = exact for micro-USD; 5 would round sub-cent prices ($0.002546 → $0.00255)
    $('w-mint-c-price').textContent = '$' + (Number(priceMicroUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' / DGB';
    $('w-mint-c-fee').textContent = fmtSats(MINT_FEE_SATS);
    $('w-mint-c-unlock').textContent = `≈ ${blocksToDate(unlockHeight - tipHeight)} (block ${unlockHeight.toLocaleString('en-US')})`;
    $('w-mint-confirm').style.display = 'block';
    $('w-mint-review').disabled = true;
  }));

$('w-mint-cancel').addEventListener('click', resetMint);

$('w-mint-go').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    const { utxo, ddCents, tierId, priceMicroUsd, dcaMultiplierBps } = pendingMint;
    if (!wallet.seed) throw new Error('wallet is locked');
    const { blocks: tipHeight } = await rpc('getblockchaininfo'); // fresh height at sign time
    const { hex } = buildSignedMintTx({
      utxo,
      privKeyHex: utxo.privKeyHex,
      ddCents,
      tierId,
      oraclePriceMicroUsd: priceMicroUsd,
      dcaMultiplierBps, // sign exactly what was reviewed — the builder recomputes collateral
      tipHeight,
      feeSats: MINT_FEE_SATS,
    });
    const txid = await broadcastTx(hex);
    resetMint();
    $('w-mint-amount').value = '';
    $('w-mint-out').textContent = `Minted — tx ${txid.slice(0, 16)}… The position appears below once confirmed.`;
    showTxSuccess('mint-modal', txid, 'Mint submitted', 'Your position appears under DigiDollar positions once the transaction confirms.');
    refreshMoney();
  }));

// ---- Transfer DigiDollar (#15): plan → confirmation → sign → broadcast ----
// Same stablecoin feature flag as Mint. A transfer spends ONE DD token UTXO
// plus ONE DGB fee UTXO owned by the SAME key (Core's transfer anatomy), so
// both coin picks are per-derivation-address.
const TRANSFER_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's DD fee floor

/** Every watched derivation's DD token UTXOs, with the owning key attached. */
async function ddUtxosWithKeys() {
  const derived = Array.from({ length: wallet.index + 3 }, (_, i) =>
    deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }));
  const perAddr = await Promise.all(derived.map(async (d) => {
    const { utxos } = await fetchIndexer(`/address/${d.address}/dd-utxos`);
    return utxos.map((u) => ({
      txidHex: u.txid, vout: u.vout, ddCents: BigInt(u.cents), height: u.height,
      privKeyHex: d.privKeyHex, address: d.address,
    }));
  }));
  return perAddr.flat();
}

let pendingTransfer = null; // { ddUtxo, feeUtxo (both hold keys!), cents, outputKeyHex } while confirming

function resetTransfer() {
  pendingTransfer = null;
  $('w-tr-confirm').style.display = 'none';
  $('w-tr-review').disabled = false;
}

$('w-tr-review').addEventListener('click', (e) =>
  busy(e.target, 'w-tr-err', async () => {
    $('w-tr-out').textContent = '';
    // Recipient may be given in EITHER encoding: the DigiDollar base58check form
    // (DD…/TD…/RD…, the ONLY form Core/Android senddigidollar accepts) or the
    // equivalent witness-v1 bech32m form (…1p…). Both encode the same 32-byte
    // taproot output key → the same scriptPubKey. decodeDDAddress accepts both.
    const address = $('w-tr-to').value.trim();
    let decoded;
    try {
      decoded = decodeDDAddress(address);
    } catch (err) {
      throw new Error(`invalid DigiDollar address: ${err.message}`);
    }
    if (decoded.network !== chainState.netName) {
      throw new Error(`address is not for this network (expected a ${chainState.netName} DigiDollar address)`);
    }
    const cents = ddToCents($('w-tr-amount').value);
    if (cents <= 0n) throw new Error('amount must be positive');
    const trLimits = DD_TX_LIMITS[chainState.netName];
    if (cents < trLimits.minOutputCents) {
      throw new Error(`consensus forbids DigiDollar outputs below $${(Number(trLimits.minOutputCents) / 100).toFixed(2)} — send at least that`);
    }
    // $500/tx beta cap (#54) — USD-native, so it applies regardless of the price feed
    const trCapErr = betaCapError(chainState.netName, Number(cents) / 100);
    if (trCapErr) throw new Error(trCapErr);
    const ddUtxos = await ddUtxosWithKeys();
    const totalCents = ddUtxos.reduce((s, u) => s + u.ddCents, 0n);
    const ddUtxo = ddUtxos.filter((u) => u.ddCents >= cents).sort((a, b) => (a.ddCents < b.ddCents ? -1 : 1))[0];
    if (!ddUtxo) {
      const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      throw new Error(totalCents >= cents
        ? `your DigiDollar covers it, but it is split across smaller coins (a transfer spends one DD coin, largest is $${fmtDD(ddUtxos.reduce((m, u) => (u.ddCents > m ? u.ddCents : m), 0n))}). Transfer that amount or less, or consolidate by transferring to your own address.`
        : `insufficient DigiDollar: you are sending $${fmtDD(cents)} but hold $${fmtDD(totalCents)}`);
    }
    // the fee coin must sit on the SAME address as the DD coin being spent —
    // and be P2TR: buildSignedTransferTx signs key-path taproot, not v0
    const feeUtxo = (await spendableUtxos())
      .filter((u) => u.type !== 'p2wpkh' && u.privKeyHex === ddUtxo.privKeyHex && u.valueSats >= TRANSFER_FEE_SATS)
      .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
    if (!feeUtxo) {
      const msg = `no DGB for the fee on the address holding this DigiDollar — send at least ${fmtSats(TRANSFER_FEE_SATS)} DGB to ${ddUtxo.address}, then retry`;
      // consolidation lands every DGB coin on the CURRENT receive address as
      // P2TR — offer it only when that is where the fee is missing (a fee-only
      // p2wpkh twin balance there is the common post-mint case, #103)
      const cur = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
      throw ddUtxo.address === cur ? fragmentationError(msg) : new Error(msg);
    }
    pendingTransfer = { ddUtxo, feeUtxo, cents, outputKeyHex: decoded.outputKeyHex, address };
    $('w-tr-c-to').textContent = address;
    $('w-tr-c-dd').textContent = (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-tr-c-change').textContent = (Number(ddUtxo.ddCents - cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-tr-c-fee').textContent = fmtSats(TRANSFER_FEE_SATS);
    $('w-tr-confirm').style.display = 'block';
    $('w-tr-review').disabled = true;
  }));

$('w-tr-cancel').addEventListener('click', resetTransfer);

$('w-tr-go').addEventListener('click', (e) =>
  busy(e.target, 'w-tr-err', async () => {
    const { ddUtxo, feeUtxo, cents, outputKeyHex } = pendingTransfer;
    if (!wallet.seed) throw new Error('wallet is locked');
    const { hex } = buildSignedTransferTx({
      ddUtxo: { txidHex: ddUtxo.txidHex, vout: ddUtxo.vout, ddCents: ddUtxo.ddCents },
      feeUtxo: { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats },
      privKeyHex: ddUtxo.privKeyHex,
      recipients: [{ outputKeyHex, cents }],
      feeSats: TRANSFER_FEE_SATS,
      // fee change back to the WATCHED address (default P2WPKH would vanish from view)
      dgbChangeScriptHex: scriptPubKeyFromAddress(ddUtxo.address),
    });
    const txid = await broadcastTx(hex);
    resetTransfer();
    $('w-tr-to').value = '';
    $('w-tr-amount').value = '';
    $('w-tr-out').textContent = `Transferred — tx ${txid.slice(0, 16)}…`;
    showTxSuccess('send-modal', txid, 'DigiDollar sent', 'The transfer appears in Activity as pending until the next block confirms it.');
    refreshMoney();
  }));

// ---- Redeem DigiDollar (#16): pick a position → confirmation → sign → broadcast ----
// Full redemption via the Normal tapscript path (expired CLTV + owner sig):
// burns DD covering the minted amount, returns the whole collateral to the
// owner's P2TR — which IS a wallet address, so the DGB balance grows by it.
const REDEEM_FEE_SATS = 12_000_000n; // 0.12 DGB, above Core's DD fee floor

let pendingRedeem = null; // { position, ddUtxos, feeUtxo (keys inside!) } while confirming

function resetRedeem() {
  pendingRedeem = null;
  $('w-redeem-confirm').style.display = 'none';
}

$('w-positions').addEventListener('click', (e) => {
  const txid = e.target?.dataset?.redeem;
  if (!txid || !openPositions.has(txid)) return;
  busy(e.target, 'w-rd-err', async () => {
    $('w-rd-out').textContent = '';
    const p = openPositions.get(txid);
    const needCents = BigInt(p.ddCents);
    const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    // $500/tx beta cap (#54). Redemption is all-or-nothing, so an over-cap
    // position (minted outside this wallet) can't shrink to fit — point at
    // Core rather than stranding the funds without an explanation.
    const rdCapErr = betaCapError(chainState.netName, Number(needCents) / 100);
    if (rdCapErr) {
      throw new Error(`${rdCapErr} — this position redeems $${fmtDD(needCents)} at once; use DigiByte Core to redeem it during the beta`);
    }
    // burnable DD must sit on the position's own address (one signing key)
    const all = await ddUtxosWithKeys();
    const onAddr = all.filter((u) => u.address === p.address).sort((a, b) => (a.ddCents < b.ddCents ? 1 : -1));
    const burn = [];
    let got = 0n;
    for (const u of onAddr) { if (got >= needCents) break; burn.push(u); got += u.ddCents; }
    if (got < needCents) {
      const totalCents = all.reduce((s, u) => s + u.ddCents, 0n);
      throw new Error(totalCents >= needCents
        ? `redemption burns the full $${fmtDD(needCents)}, but only $${fmtDD(got)} sits on the position's address — transfer $${fmtDD(needCents - got)} to ${p.address} first`
        : `you no longer hold enough DigiDollar: redeeming burns $${fmtDD(needCents)}, you hold $${fmtDD(totalCents)} (some was transferred away)`);
    }
    // P2TR only: buildSignedRedeemTx signs the fee input key-path, not v0
    const feeUtxo = (await spendableUtxos())
      .filter((u) => u.type !== 'p2wpkh' && u.privKeyHex === burn[0].privKeyHex && u.valueSats >= REDEEM_FEE_SATS)
      .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
    if (!feeUtxo) {
      const msg = `no DGB for the fee on the position's address — send at least ${fmtSats(REDEEM_FEE_SATS)} DGB to ${p.address}, then retry`;
      // same rule as the transfer fee gate: consolidation only helps when the
      // position sits on the CURRENT receive address (where the merged coin lands)
      const cur = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index }).address;
      throw p.address === cur ? fragmentationError(msg) : new Error(msg);
    }
    pendingRedeem = { position: p, ddUtxos: burn, feeUtxo };
    $('w-rd-c-txid').textContent = p.txid.slice(0, 12) + '…';
    $('w-rd-c-dd').textContent = fmtDD(needCents);
    $('w-rd-c-coll').textContent = fmtSats(BigInt(p.collateralSats));
    $('w-rd-c-fee').textContent = fmtSats(REDEEM_FEE_SATS);
    $('w-redeem-confirm').style.display = 'block';
  });
});

$('w-rd-cancel').addEventListener('click', resetRedeem);

$('w-rd-go').addEventListener('click', (e) =>
  busy(e.target, 'w-rd-err', async () => {
    const { position: p, ddUtxos, feeUtxo } = pendingRedeem;
    if (!wallet.seed) throw new Error('wallet is locked');
    const { hex } = buildSignedRedeemTx({
      collateralUtxo: {
        txidHex: p.txid, vout: 0, valueSats: BigInt(p.collateralSats),
        lockHeight: p.unlockHeight, ddCents: BigInt(p.ddCents),
      },
      ddUtxos: ddUtxos.map((u) => ({ txidHex: u.txidHex, vout: u.vout, ddCents: u.ddCents })),
      feeUtxo: { txidHex: feeUtxo.txidHex, vout: feeUtxo.vout, valueSats: feeUtxo.valueSats },
      privKeyHex: ddUtxos[0].privKeyHex,
      feeSats: REDEEM_FEE_SATS,
      dgbChangeScriptHex: scriptPubKeyFromAddress(p.address), // keep change visible
    });
    const txid = await broadcastTx(hex);
    resetRedeem();
    const short = txid.slice(0, 16) + '…';
    const label = appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
      ? `<a href="${appConfig.explorerTxUrl}${txid}" target="_blank" rel="noopener" class="mono">${short}</a>`
      : `<span class="mono">${esc(short)}</span>`;
    $('w-rd-out').innerHTML = `Redeemed — tx ${label} The collateral returns to your DGB balance once confirmed.`;
    refreshMoney();
  }));

let moneyTimer = null;
function startMoneyPolling() {
  if (!appConfig.indexer) return;
  refreshMoney();
  clearInterval(moneyTimer);
  moneyTimer = setInterval(refreshMoney, 8000);
}

async function bootWallet() {
  try {
    // 'locked' covers both a v2 vault and a not-yet-migrated v1 record — the
    // unlock path migrates transparently on the first successful password.
    show(await vault.load() === 'none' ? 'none' : 'locked');
  } catch (e) {
    $('w-loading').textContent = 'wallet storage unavailable: ' + e.message;
  }
}

// Cross-wired backend (#64): blocking state — danger banner, CROSS-WIRED
// badge, wallet chrome hidden. Returns true when the deployment is
// cross-wired (the server refuses all RPC/indexer/faucet until fixed).
function renderCrossWire(cfg) {
  if (!cfg?.chainMismatch) return false;
  const bannerEl = $('net-banner');
  bannerEl.textContent = `SERVER MISCONFIGURED — this deployment expects ${cfg.expectedChain?.toUpperCase()} but its node is on ${cfg.chain?.toUpperCase()}. All operations are disabled; contact the operator.`;
  bannerEl.hidden = false;
  bannerEl.classList.add('danger');
  const badge = $('modeBadge');
  badge.className = 'badge mock';
  badge.textContent = 'CROSS-WIRED';
  $('w-loading').textContent = 'wallet disabled: the server refuses to serve a mismatched network';
  show('loading');
  return true;
}

// ---- Boot ----
async function boot() {
  initCalculator();
  // Stablecoin flows (mint/transfer/redeem) are always on, as one unit — the
  // release gate (#17) removed the feature flag per ADR-0002.
  initMintTiers();
  enhanceSelect('send-asset');
  // reflect the stored auto-lock choice (only ladder values — a garbage/stale
  // entry falls back to the markup's 5-minute default)
  try {
    const v = localStorage.getItem(AUTOLOCK_KEY);
    if (v !== null && [...$('w-autolock').options].some((o) => o.value === v)) $('w-autolock').value = v;
  } catch { /* private mode → default */ }
  enhanceSelect('w-autolock');
  loadPriceChart();
  setInterval(loadPriceChart, 60_000);
  try {
    const cfg = await (await fetch('/api/config')).json();
    appConfig = { ...cfg, loaded: true };
    const badge = $('modeBadge');
    if (cfg.mock) {
      badge.className = 'badge mock';
      badge.textContent = 'MOCK MODE';
    } else {
      badge.className = 'badge real';
      badge.textContent = 'LIVE NODE';
    }
    if (cfg.faucet) $('w-faucet').style.display = 'block';
    if (cfg.version) $('app-version').textContent = cfg.version; // which build this domain runs
    // Cross-wired backend (#64): the server refuses everything, so no flow
    // can work — say exactly why in the loudest chrome we have and stop.
    if (renderCrossWire(cfg)) return; // no wallet boot, no status/oracle loops
  } catch { /* ignore */ }
  bootWallet();
  // retry until the node names its chain: a transient boot failure must not
  // strand the UI network-unknown (no addresses, no testnet banner) forever.
  // The retry also re-checks the cross-wire flag — a page loaded before the
  // server's first chain probe must still lock up once the mismatch is known.
  (async function statusLoop() {
    await loadStatus();
    if (chainState.netKnown) return;
    const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => null);
    if (cfg?.chainMismatch) { appConfig = { ...appConfig, ...cfg }; renderCrossWire(cfg); return; }
    setTimeout(statusLoop, 5000);
  })();
  loadOracle();
  loadDca();
  // network health moves with the market — keep the non-binding previews
  // honest mid-session (the review step always re-fetches anyway)
  setInterval(loadDca, 60_000);
}

boot();
