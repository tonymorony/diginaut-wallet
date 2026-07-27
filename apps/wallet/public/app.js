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
import { discoverProviders, connectAccount, deriveFromSource, deriveOnce, shortAddress } from '/connect.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { networkChrome, betaCapError, backupSkipAllowed } from '/netchrome.js';
import { dcaBpsFromMultiplier, describeDca } from '/dca.js';
import { MINT_FREEZE_EXPLANATION } from '/dderrors.js';
import { createBroadcastLog, txidFromSignedHex, classifyBroadcastError } from '/broadcastlog.js';
import { AUTOLOCK_KEY, AUTOLOCK_DEFAULT_MIN, autolockMinutes } from '/autolock.js';
import { ensurePersistence, readPersistence, persistenceCopy, markHadVault, clearHadVault, hadVault } from '/persistence.js';
import { NET_TIMEOUT_MS, isTimeoutError, timeoutMessage } from '/nettimeout.js';
import {
  validateUtxosResponse, validateHistoryResponse, validatePositionsResponse,
  validateDdUtxosResponse, validateTxDetail,
} from '/validate.js';
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

/** Markup for one sprite icon (#138). The shapes live in index.html's #ic-sprite,
 *  so a fix lands everywhere at once and app.js never carries path data.
 *  Both arguments are literals at every call site. The strip makes that
 *  structural rather than a convention someone has to remember: an id or class
 *  can only ever be [a-z0-9- ], so no future caller can turn this into an
 *  injection sink by threading a brand name or an indexer field through it.
 *  Decorative by default: every caller either sits next to a visible label or
 *  puts aria-label on the control. */
const safeIcName = (s) => String(s).replace(/[^a-z0-9- ]/g, '');
const icon = (name, cls = '') =>
  `<svg class="ic${cls ? ' ' + safeIcName(cls) : ''}" aria-hidden="true"><use href="#ic-${safeIcName(name)}"/></svg>`;

/** Every frontend fetch goes through here (#H1). A bare fetch against a stalled
 *  hop never settles: busy() only re-enables its button in `finally`, and every
 *  poll chain awaits before rescheduling — so one hung socket disables the UI
 *  and stops the wallet updating for the rest of the session.
 *  The ONLY mechanism is `AbortSignal.timeout` handed to fetch as init.signal —
 *  never a Promise.race wrapper, which would leave the socket open and would not
 *  survive the drivers that monkeypatch window.fetch and forward ...args. */
async function apiFetch(url, { budget = NET_TIMEOUT_MS.rpc, what = 'the wallet server', ...init } = {}) {
  try {
    // Defaulted above on purpose: AbortSignal.timeout(undefined) coerces to 0
    // and aborts the request instantly, so a forgotten budget would break the
    // call site rather than merely leaving it unbudgeted.
    return await fetch(url, { ...init, signal: AbortSignal.timeout(budget) });
  } catch (err) {
    // The flag, not the copy, is the machine-readable outcome: the broadcast
    // classifier keys off it, so a copy edit here can never silently reclassify
    // an ambiguous broadcast as a definite failure.
    if (isTimeoutError(err)) {
      const e = new Error(timeoutMessage(what));
      e.transport = 'timeout';
      throw e;
    }
    const e = new Error(`could not reach ${what} (${err.message})`);
    e.transport = 'network';
    throw e;
  }
}

async function rpc(method, params = []) {
  const res = await apiFetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    budget: NET_TIMEOUT_MS.rpc,
    what: 'the node',
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json.result;
}

const fmtDGB = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtUSD = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Records live in localStorage and outlive the tab: a crash between signing and
// the node's answer must still leave a trace of what was signed (#C1).
const broadcastLog = createBroadcastLog();

// sendrawtransaction with Core's consensus reject strings translated (#62) —
// "minting-frozen-volatility" is not an error a human can act on — and with the
// signed bytes journalled first (#C1). `meta` is display-only: { kind, summary }.
async function broadcastTx(hex, meta = { kind: 'send', summary: '' }) {
  let txid = null;
  try { txid = txidFromSignedHex(hex); } catch { /* never block a broadcast on the local txid */ }
  if (txid) {
    broadcastLog.record({
      txid, hex, kind: meta.kind, summary: String(meta.summary || ''),
      chain: chainState.netName, walletId: wallet.id, at: Date.now(),
      state: 'pending', attempts: 1, lastError: null,
    });
  }
  return await sendAndClassify(hex, txid);
}

/** Send, then decide whether the node actually answered. Shared with the
 *  recovery card's Rebroadcast, which re-sends the IDENTICAL bytes. */
async function sendAndClassify(hex, txid) {
  try {
    const nodeTxid = await rpc('sendrawtransaction', [hex]);
    // A 200 IS mempool acceptance: the ambiguity the record exists to hold is
    // gone. (The audit asked for records to clear only on confirmation or a
    // definite reject; keeping one here would park a warning card over every
    // successful send until it is mined.)
    if (txid) broadcastLog.drop(txid);
    renderRecoveryCard();
    return nodeTxid;
  } catch (err) {
    const c = classifyBroadcastError(err);
    if (c.kind === 'already') {
      // the node holds these exact bytes — that is the definition of sent
      if (txid) broadcastLog.drop(txid);
      renderRecoveryCard();
      return txid ?? '';
    }
    if (c.kind === 'reject') {
      // Nothing was broadcast, so nothing to recover. The message passes
      // through UNMODIFIED — dderrors.js already made it human, and prefixing
      // it would break the honest-quote contract on the mint freeze copy.
      if (txid) broadcastLog.drop(txid);
      renderRecoveryCard();
      throw new Error(c.message);
    }
    if (txid) broadcastLog.markAmbiguous(txid, c.message);
    renderRecoveryCard();
    // The panel can only be named if the journal actually holds the record:
    // record()/markAmbiguous are best-effort, and a quota-full or private-mode
    // storage keeps nothing. When it kept nothing, the error itself must carry
    // the one thing that still recovers the situation — the signed bytes.
    const journalled = txid !== null && broadcastLog.get(txid) !== null;
    const e = new Error('The node did not answer, so this transaction MAY ALREADY have been broadcast. '
      + 'Do not rebuild and send it again — that would create a second, conflicting transaction over the same '
      + 'coins. '
      + (journalled
        // names the #w-recovery <h2> verbatim — retitle both together
        ? 'Use “Check status” or “Rebroadcast” in the Broadcast not acknowledged panel above. '
        : 'This browser could not save a recovery record, so copy the raw transaction below and keep it: '
          + 'a block explorer’s broadcast form re-sends the identical bytes, and searching its ID there '
          + 'tells you whether it already confirmed. Raw transaction: ' + hex + ' ')
      + `(${c.message})`);
    e.ambiguousTxid = txid;
    e.ambiguous = true;
    throw e;
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
  trig.innerHTML = '<span class="dd-label"></span>' + icon('chevron-down', 'ic-s dd-caret');
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
      // option text is textContent (never innerHTML — it can carry a wallet
      // name); the tick is a separate node so the label stays untrusted-safe
      el.append(o.textContent);
      el.insertAdjacentHTML('beforeend', icon('check', 'ic-s dd-tick'));
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

/** Focus containment for the connect modal (#138). It carries aria-modal, which
 *  tells assistive tech the rest of the page is inert — so Tab must not walk out
 *  of it into the wallet behind, or the promise is a lie. Same shape as the
 *  mainnet-ack trap above, with two differences: this modal is dismissible, so
 *  Escape is NOT swallowed; and its close button can be hidden (a sealed backup
 *  ceremony), so focus snaps to the first VISIBLE control rather than a fixed id. */
document.addEventListener('focusin', (e) => {
  const modal = $('w-connect-modal');
  if (!modal.classList.contains('open') || modal.contains(e.target)) return;
  const focusable = [...modal.querySelectorAll('button, input, textarea, select, [tabindex]')]
    .find((el) => el.offsetParent !== null && !el.disabled);
  (focusable || modal.querySelector('.modal')).focus();
});

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

// Poll cadences for the three things the UI presents as live. 60s matches what
// loadDca already did; the status poll is slower because height and softfork
// state are cheap to be a minute stale and it is the heaviest of the three
// (two RPCs). PRICE_MAX_AGE_MS must stay a small multiple of ORACLE_POLL_MS so
// one dropped tick does not disable USD entry.
const ORACLE_POLL_MS = 60_000;
const STATUS_POLL_MS = 60_000;
const DCA_POLL_MS = 60_000;
// The money poll is the fast one and by far the most expensive: each tick costs
// 6 indexer requests per watched derivation.
const MONEY_POLL_MS = 8_000;
const PRICE_CHART_POLL_MS = 60_000;

async function loadStatus() {
  // Rebuilt from scratch each poll: line ~301 APPENDS the deployment error, so
  // a node that keeps failing would otherwise grow this string a clause a minute.
  $('s-err').textContent = '';
  try {
    const info = await rpc('getblockchaininfo');
    $('s-chain').textContent = info.chain;
    $('s-height').textContent = Number(info.blocks).toLocaleString('en-US');
    // keep the NUMBER too (#H5) — reading it back off the DOM would parse a
    // locale string with thousands separators
    if (Number.isInteger(Number(info.blocks))) lastNodeHeight = Number(info.blocks);
    // derive receive addresses for the chain the node is actually on
    const net = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain];
    if (net) {
      chainState.netName = net; // consensus DD limits are per-network
      chainState.netKnown = true; // safe to render addresses now
      wallet.network = HD_NETWORKS[net];
      // a wallet unlocked before the node named its chain has no addresses yet
      // — this is the first moment its chain can be scanned
      if (wallet.seed) { renderAddress(); syncReceiveIndex(); }
      // The ONLY place netKnown flips true, and the recovery card is chain-
      // scoped: an unconfirmed broadcast made on testnet must not be offered
      // for rebroadcast against whatever node happens to answer now (#C1).
      // Idempotent, so the 60s poll simply keeps it in step; never reached on a
      // cross-wired deployment, where every RPC is refused and the card stays
      // hidden — which is exactly right.
      renderRecoveryCard();
      // A ceremony opened before this answer landed is sealed (unknown fails
      // strict). Now that the chain has a name, re-decide: testnet/regtest get
      // their skip back, mainnet stays sealed (#C3). Idempotent, like the card.
      renderBackupSkipGate();
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
    // Sign-to-derive is TESTNET-ONLY (#126 destination, ADR 0005): the frozen
    // v1 message names the testnet, so the same bundle on a mainnet node must
    // not offer the door at all — hide it the moment the chain says main.
    // ONE node, not the button plus a .nextElementSibling walk: the sibling was
    // the hint line, and when #138 folded that copy into the door the walk hit
    // null — which threw, was swallowed by the catch below, and took
    // maybeShowMainnetAck() with it. A mainnet user then reached the wallet with
    // no risk interstitial at all. Never reach for a neighbour by DOM position.
    $('w-web3-group').style.display = info.chain === 'main' ? 'none' : '';
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
let lastPriceAt = null; // Date.now() of the quote above — see PRICE_MAX_AGE_MS

// Chain tips, from the two independent polls (#H5). The balance index can lag
// the node — initial sync, catch-up after an outage — and a UTXO set even one
// block behind can offer a coin that is already spent, so the confirm screens
// say so. CHAIN-scoped, not wallet-scoped: a lock or a wallet switch does not
// change which chain we are on, so resetWalletState leaves these alone.
let lastNodeHeight = null; // node `blocks`, 60s status poll
let lastIndexerTip = null; // indexer tipHeight, 8s money poll

async function loadOracle() {
  try {
    const price = await rpc('getoracleprice');
    if (price?.price_usd) {
      lastPriceAt = Date.now();
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
  // The rate just moved, and the ≈-line under the amount is the only place the
  // user sees what their USD figure is worth. It is otherwise repainted only on
  // typing, on the currency toggle and on Max — so without this a polled price
  // leaves "$1.00 ≈ 74.5 DGB" on screen while Review builds 294.1 DGB.
  updateSendEq();
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

// The chain to gate on: the node's answer, or null while it has not answered.
// NEVER pass chainState.netName raw — it defaults to the 'testnet' GUESS above,
// so a mainnet deployment with a dead node would read as testnet and hand the
// user a skip button for real money (#C3).
function gateChain() {
  return chainState.netKnown ? chainState.netName : null;
}

// The vault manager owns metadata + mnemonics (vault.js); keystore.js is its
// browser storage. One master password for every wallet on this device.
const vault = createVaultManager(keystore);

// Browser storage protection (#C2). IndexedDB is evictable; ask for persistence
// at the two moments a user gesture exists (vault create, unlock) and report
// the answer honestly in Network. null = not probed yet.
let persistState = null;
function renderStorageProtection() {
  const { level, label, detail } = persistenceCopy(persistState);
  $('s-persist').innerHTML = `<span class="dot ${level}"></span>${esc(label)}`;
  $('s-persist-hint').textContent = detail;
}
async function probePersistence({ request = false } = {}) {
  const sm = globalThis.navigator?.storage;
  persistState = request ? await ensurePersistence(sm) : await readPersistence(sm);
  renderStorageProtection();
  renderBackupStrip(); // the strip's urgency depends on this answer
}

let shownState = 'loading'; // what the app currently renders — cross-tab sync diffs against it
function show(state) {
  shownState = state;
  // the boot card is the whole wrapper: leaving it in the main grid while
  // empty would add a stray row gap under the header
  $('wallet-card').style.display = state === 'loading' ? 'block' : 'none';
  $('w-loading').style.display = state === 'loading' ? 'block' : 'none';
  $('w-open').style.display = state === 'open' ? 'grid' : 'none';
  // EVM-style corner control: Connect when idle, address chip when connected
  const open = state === 'open';
  $('hero-guest').style.display = state === 'none' || state === 'locked' ? 'block' : 'none';
  // Fresh install vs wiped vault (#C2). Keyed on 'none' ONLY — the same hero
  // serves 'locked', and "your data is gone" over a healthy locked vault is a
  // false alarm that pushes users to erase. The tombstone is read FRESH on every
  // transition: a cross-tab erase clears it and reconcileVaultUi() lands here.
  const wiped = state === 'none' && hadVault(globalThis.localStorage);
  $('hero-recovery').style.display = wiped ? 'block' : 'none';
  $('hero-guest-copy').style.display = wiped ? 'none' : 'block';
  // The CTA names the outcome of the click, and the click has three outcomes.
  // "Connect wallet" is the EVM phrase for GRANT THIS SITE ACCESS to a wallet
  // you already hold — the default door here grants nothing and generates a
  // keypair in this browser. Worse, the same label rode the 'locked' state, so
  // a returning user (and every autolock) was offered a "connect" over a wallet
  // already on the device, opening a sheet correctly titled "Unlock your
  // wallets". A label that names a different security model than the handler
  // implements is a defect — see design-system.md § UX copy.
  const [heroCta, chipCta] = state === 'locked' ? ['Unlock', 'Unlock']
    : wiped ? ['Restore a wallet', 'Restore']
      : ['Create or restore a wallet', 'Create or restore'];
  $('hero-connect').textContent = heroCta;
  $('w-connect').textContent = chipCta; // same promise, a header chip's worth of room
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
  // The recovery card is a sibling of every wallet surface on purpose (it must
  // outlive lock, autolock and switch), but its ROW TITLES depend on the lock
  // state — so the one funnel every state transition goes through has to
  // re-render it, or the summary stays on screen behind the lock.
  renderRecoveryCard();
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
  const card = $('price-card');
  const visible = open && !appConfig.indexer;
  const wasHidden = card.style.display === 'none';
  card.style.display = visible ? 'block' : 'none';
  // the card boots hidden, so its first chart was measured at zero width —
  // draw it again the moment it actually has a box
  if (visible && wasHidden) renderSparkline(lastPriceSeries);
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
  // sign-to-derive steps (#130): picker and ceremony are modal modes like any
  // other; leaving the ceremony drops the held mnemonic + resets the checkbox
  $('w-web3-pick').style.display = mode === 'web3-pick' ? 'block' : 'none';
  $('w-web3-sign').style.display = mode === 'web3-sign' ? 'block' : 'none';
  if (mode !== 'web3-sign') {
    web3Run += 1; // orphan any in-flight ceremony continuation (late popups)
    web3Pending = null; // plaintext mnemonic must not outlive the ceremony
    web3Entry = null;
    web3Address = null;
    web3ForceNew = false;
    $('w-web3-agree').checked = false;
    $('w-web3-go').disabled = true;
    $('w-web3-pass').value = '';
    $('w-web3-pass2').value = '';
    $('w-web3-steps').innerHTML = '';
    $('w-web3-disclose').style.display = 'none';
    $('w-web3-save').style.display = 'none';
    $('w-web3-mismatch').style.display = 'none';
    $('w-web3-err').textContent = '';
  }
  $('w-backup-view').style.display = mode === 'backup' ? 'block' : 'none';
  $('w-quiz-view').style.display = mode === 'quiz' ? 'block' : 'none';
  $('w-backup-success').style.display = mode === 'backup-done' ? 'block' : 'none';
  renderBackupSkipGate();
  // The sheet is not always a "connect": with a vault already open it is an ADD,
  // and it said "Connect wallet" over a connected wallet. The title has to name
  // the state the modal is actually in, or the header contradicts the chrome
  // behind it (#138).
  const [title, sub] = ['backup', 'quiz', 'backup-done'].includes(mode)
    ? ['Back up your seed phrase', 'Write the words down before you fund this wallet']
    : mode === 'erase' ? ['Erase all wallets', 'This cannot be undone']
      : mode === 'unlock' ? ['Unlock your wallets', 'One master password for every wallet on this device']
        // the one leg where "connect" is literally true. Without this arm the
        // sheet headed a MetaMask/Phantom picker with "Create or restore a
        // wallet", contradicting the door the user had just clicked — the same
        // header-vs-content mismatch #138 fixed everywhere else.
        : ['web3-pick', 'web3-sign'].includes(mode)
          // the sub must NOT restate the mechanism — #w-web3-pick's own body
          // already explains the fixed message and the derivation. It carries
          // the thing that body leaves out: this is the one door that touches
          // an outside key holder, and even here nothing is granted away.
          ? ['Connect a browser wallet', 'Experimental — the extension signs once and never gains access to this wallet']
          : vault.status === 'unlocked' ? ['Add a wallet', 'Your vault is unlocked — no password needed to add']
            : ['Create or restore a wallet', 'Non-custodial — the keys never leave this browser'];
  $('w-connect-title').textContent = title;
  $('w-connect-sub').textContent = sub;
  // real words live in the ceremony DOM only while its steps are open
  if (mode !== 'backup') $('w-backup-words').innerHTML = '';
  if (mode !== 'quiz') { $('w-quiz-slots').innerHTML = ''; $('w-quiz-chips').innerHTML = ''; $('w-quiz-err').textContent = ''; }
  // "Saved diginaut-wallet-1-….json" must not follow one wallet's success beat
  // into the next wallet's (#M1); closeConnectModal routes through here too.
  if (mode !== 'backup-done') { $('w-backup-file-saved').style.display = 'none'; $('w-backup-file-err').textContent = ''; }
  $('w-none-err').textContent = '';
}
function openConnectModal() {
  const locked = vault.status === 'locked';
  setConnectMode(locked ? 'unlock' : 'choice');
  $('w-connect-modal').classList.add('open');
  // Pull focus into the dialog so a keyboard user lands on the thing the modal
  // is asking for, not on whatever was behind it. Deferred a frame: the element
  // has to be laid out (display flipped by setConnectMode) before it can take
  // focus. Never throw here — a failed focus must not abort opening.
  requestAnimationFrame(() => {
    if (!$('w-connect-modal').classList.contains('open')) return;
    // re-read the status: an autolock landing inside this one frame flips the
    // sheet to 'unlock', and the captured value would aim at a hidden door
    const target = vault.status === 'locked' ? 'w-unlock-pass' : 'w-create-choice';
    try { $(target).focus(); } catch { /* not laid out */ }
  });
}
function closeConnectModal() {
  $('w-connect-modal').classList.remove('open');
  ceremony = null; // drop the plaintext words held for the reveal/quiz steps
  // resetting the mode wipes the ceremony word nodes and restores the title
  setConnectMode(vault.status === 'locked' ? 'unlock' : 'choice');
}

/** Skip/close visibility for the backup ceremony (#C3). Its own function, not
 * an inline branch in setConnectMode, because the answer changes on a second
 * clock: the node naming its chain. A ceremony opened before the first
 * getblockchaininfo lands is sealed (unknown fails strict) and must UNSEAL the
 * moment a testnet/regtest node answers — otherwise a slow node permanently
 * removes the frictionless skip loadStatus was about to allow. */
function renderBackupSkipGate() {
  // Remind-me-later is shared by both ceremony steps (id kept stable — drivers
  // dismiss the whole flow with one click on it). On mainnet — and on an
  // unknown chain, which fails strict — there is no skip at all.
  const skipOk = backupSkipAllowed(gateChain());
  const onCeremony = connectMode === 'backup' || connectMode === 'quiz';
  $('w-backup-done').style.display = skipOk && onCeremony ? 'block' : 'none';
  // A ceremony opened straight off wallet creation is the one moment the skip
  // protected; with no skip, Close must not be the skip in disguise.
  const sealed = !skipOk && ceremony?.mandatory === true && onCeremony;
  $('w-modal-close').style.display = sealed ? 'none' : '';
  $('w-backup-sealed').style.display = sealed ? 'block' : 'none';
}

/** User-initiated dismiss. closeConnectModal() itself stays unguarded — show()
 * and resetWalletState() call it as teardown on lock, switch and autolock, and
 * those must never be blocked (#C3). */
function requestCloseConnectModal() {
  if (!backupSkipAllowed(gateChain()) && ceremony?.mandatory === true
      && ['backup', 'quiz'].includes(connectMode)) return;
  closeConnectModal();
}

// ---- v3 action modals: Send / Receive / Mint / Network ----
const openModal = (id) => $(id).classList.add('open');
// Closing a modal abandons whatever draft it held. Anything armed out-of-band
// from the visible fields — "Max", a pending signed draft — has to go with it,
// or it silently applies to the next thing the user does.
function onModalClosed(id) {
  if (id === 'net-modal') hideSeed(); // a revealed seed must not outlive the modal (§5)
  // #L3: every draft holds per-UTXO private keys AND an armed confirm screen
  // the user could sign much later against a review-time quote — closing the
  // modal abandons both. Only send-modal was covered, so a closed mint,
  // transfer or consolidate kept its keys and its Confirm button alive.
  if (id === 'send-modal') { resetSend(); resetTransfer(); } // both forms live in this one modal
  if (id === 'mint-modal') resetMint();
  if (id === 'consolidate-modal') resetConsolidate();
}
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const modal = b.closest('.modal-backdrop');
    modal.classList.remove('open');
    onModalClosed(modal.id);
  }));
for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'net-modal', 'disclaimer-modal', 'wallet-modal', 'consolidate-modal']) {
  $(id).addEventListener('click', (e) => {
    if (e.target !== $(id)) return;
    $(id).classList.remove('open');
    onModalClosed(id);
  });
}
$('footer-disclaimer').addEventListener('click', () => openModal('disclaimer-modal'));
// #L3: re-arm from scratch on every open, so a close path the map above misses
// still cannot present a stale, still-armed confirm screen (the shape
// openConsolidateModal already uses).
$('act-send').addEventListener('click', () => { resetSend(); resetTransfer(); $('send-modal').classList.remove('success'); openModal('send-modal'); });
// both receive entry points go through the backup interception gate (spec §3)
$('act-receive').addEventListener('click', openReceiveModal);
$('w-no-indexer-receive').addEventListener('click', openReceiveModal);
$('act-mint').addEventListener('click', () => { resetMint(); $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
$('dd-mint-open').addEventListener('click', () => { resetMint(); $('mint-modal').classList.remove('success'); openModal('mint-modal'); updateMintEstimate(); });
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
$('w-modal-close').addEventListener('click', requestCloseConnectModal);
$('w-connect-modal').addEventListener('click', (e) => { if (e.target === $('w-connect-modal')) requestCloseConnectModal(); });
$('w-disconnect').addEventListener('click', () => lockWallet());

// Every script form this wallet will pay, by decodeAddress's `type` label.
// Deliberately an allow-list: witnessType() falls through to `witness_v<n>` for
// anything it does not recognise, and a future witness version is a script the
// user's coins would land in with no way back out.
const PAYABLE_ADDRESS_TYPES = new Set(['p2wpkh', 'p2wsh', 'p2tr', 'p2pkh', 'p2sh']);

function renderAddress() {
  // Never show an address for a guessed network: on a mainnet deployment with
  // an unreachable node the default would be testnet-encoded — confusing at
  // best. loadStatus retries until the node names its chain, then re-renders.
  const addressActions = [$('w-copy'), $('w-next'), $('w-faucet'), $('w-copy-dd'), $('w-compat-copy'),
    $('w-copy-icon'), $('w-copy-dd-icon'), $('w-prev-toggle')];
  if (!chainState.netKnown) {
    $('w-path').textContent = '';
    $('w-address').textContent = 'waiting for the node to report a supported network…';
    $('w-dd-address').textContent = '';
    $('w-compat-address').textContent = '';
    $('w-chip-addr').textContent = '…';
    $('w-qr').innerHTML = '';
    $('w-compat-qr').innerHTML = '';
    $('w-dd-qr').innerHTML = '';
    $('w-prev-list').innerHTML = '';
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
  renderPrevAddresses();
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
  // The DigiDollar form gets no amount: Core's senddigidollar takes an address,
  // not a URI, so a `digibyte:…?amount=` QR would be a request no DigiDollar
  // sender can act on. Bare address, always.
  if ($('rx-pane-dd').style.display !== 'none') drawAddressQr($('w-dd-qr'), $('w-dd-address').textContent, 0n);
}

// ---- Receive: DGB / DigiDollar form switch ----
// Not two addresses — one key in the two encodings the ecosystem needs. Core
// and mobile wallets reject dgb1p… for a DigiDollar send (#72) and this wallet
// would otherwise offer that form as a copy line with no QR to scan.
function setReceiveTab(tab) {
  const dd = tab === 'dd';
  $('rx-pane-dgb').style.display = dd ? 'none' : 'block';
  $('rx-pane-dd').style.display = dd ? 'block' : 'none';
  for (const [el, on] of [[$('rx-tab-dgb'), !dd], [$('rx-tab-dd'), dd]]) {
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', String(on));
  }
  if (dd) updateReceiveQr(); // the DD QR renders lazily, only when its pane is up
  renderPrevAddresses();     // the list re-encodes to match (no-op while collapsed)
}
$('rx-tab-dgb').addEventListener('click', () => setReceiveTab('dgb'));
$('rx-tab-dd').addEventListener('click', () => setReceiveTab('dd'));

// ---- Copy affordance on the address boxes ----
// data-copy names the element holding the text; data-copy-text carries it
// directly (the previous-address rows, which are built as markup).
const COPY_ICON = icon('copy', 'ic-s');
const DONE_ICON = icon('check', 'ic-s');
for (const el of document.querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
const copyTimers = new WeakMap(); // button → pending revert timer
const copyLabels = new WeakMap(); // button → its resting aria-label

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.icon-btn');
  if (!btn) return;
  const text = btn.dataset.copyText ?? $(btn.dataset.copy)?.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    $('w-open-err').textContent = surfaceError(err); // clipboard denied: say so, don't fake a tick
    return;
  }
  const label = copyLabels.get(btn) ?? btn.getAttribute('aria-label');
  copyLabels.set(btn, label); // a second tap mid-tick must not save "Copied" as the label
  btn.innerHTML = DONE_ICON;
  btn.classList.add('copied');
  btn.setAttribute('aria-label', 'Copied');
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.classList.remove('copied');
    btn.setAttribute('aria-label', label);
  }, 1400));
});

// ---- Previously used addresses ----
// The receive chain is a list, not a single address: "Next address" hands out
// another one and the old ones stay watched (see syncReceiveIndex). This shows
// what has been handed out, and — from the data the money poll already
// fetches, so no extra requests — which of them have actually been paid.
let addressUse = new Map(); // derivation index → { used, sats }

// Address strings only. deriveTaprootAddress also returns privKeyHex, and key
// material must not sit in a cache that outlives a lock — this holds neither.
const prevAddrCache = new Map(); // `${walletGen}:${net}:${index}` → address
function receiveAddressAt(index) {
  const key = `${walletGen}:${chainState.netName}:${index}`;
  let hit = prevAddrCache.get(key);
  if (!hit) {
    hit = deriveTaprootAddress(wallet.seed, { ...wallet.network, index }).address;
    prevAddrCache.set(key, hit);
  }
  return hit;
}

function renderPrevAddresses() {
  const list = $('w-prev-list');
  if (list.style.display === 'none' || !wallet.seed || !chainState.netKnown) return;
  // the list speaks whichever form the tab does: a row copied while the
  // DigiDollar pane is up must be a DD… address, not the dgb1p… a DigiDollar
  // sender would reject (#72)
  const asDD = $('rx-pane-dd').style.display !== 'none';
  const rows = [];
  for (let i = wallet.index; i >= 0; i--) {
    const derived = receiveAddressAt(i);
    const address = asDD
      ? encodeDDAddress(decodeDDAddress(derived).outputKeyHex, chainState.netName)
      : derived;
    const use = addressUse.get(i);
    // three states worth distinguishing: the one on display, one that has been
    // paid, and one handed out that nobody has used yet
    const tag = i === wallet.index
      ? '<span class="rx-tag now">showing</span>'
      : use?.used
        ? '<span class="rx-tag">received</span>'
        : `<span class="rx-tag idle">${appConfig.indexer ? 'unused' : 'handed out'}</span>`;
    rows.push(`<div class="rx-row"><span class="rx-i mono">#${i}</span>`
      + `<span class="rx-addr mono" title="${esc(address)}">${esc(address.slice(0, 14))}…${esc(address.slice(-6))}</span>`
      + `${tag}<button type="button" class="icon-btn" data-copy-text="${esc(address)}" title="Copy address" aria-label="Copy address #${i}"></button></div>`);
  }
  list.innerHTML = rows.join('');
  for (const el of list.querySelectorAll('.icon-btn')) el.innerHTML = COPY_ICON;
}

function setPrevShown(show) {
  $('w-prev-list').style.display = show ? 'block' : 'none';
  $('w-prev-toggle').textContent = show ? 'Hide previous addresses' : 'Previously used addresses';
  if (show) renderPrevAddresses();
}
$('w-prev-toggle').addEventListener('click', () => {
  setPrevShown($('w-prev-list').style.display === 'none');
});

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

// Bumped on every open. Async work started for one wallet must not land on the
// next one, and a wallet id is not enough to tell them apart: erasing the vault
// and restoring hands the same id ('w-1') to a completely different seed.
let walletGen = 0;

function openWallet(id, mnemonic) {
  walletGen += 1;
  wallet.id = id;
  wallet.mnemonic = mnemonic;
  wallet.seed = mnemonicToSeed(mnemonic);
  // An address handed out in an earlier session must stay watched: opening at
  // index 0 would narrow the watch window to 0…2 (watchedDerivations) and hide
  // — and make unspendable — anything received further down the chain. The
  // vault counter remembers this device's handouts even before anyone pays
  // them; syncReceiveIndex covers what the counter cannot know.
  wallet.index = vault.meta()?.wallets.find((w) => w.id === id)?.receiveIndex ?? 0;
  renderAddress();
  hideSeed();
  renderBackupCta();
  $('w-open-err').textContent = '';
  show('open');
  startMoneyPolling();
  syncReceiveIndex(); // ask the chain how far this seed has actually been used
  armAutolock(); // the inactivity countdown starts (only) with an unlocked wallet
}

// ---- Receive-chain rediscovery ----
// The vault counter is a per-device memory: a seed restored on another device
// (or in a re-created vault) knows nothing about the addresses it handed out.
// So on every open, ask the indexer how far down the chain this seed has been
// used, and open the watch window at least that wide. BIP44's gap limit is the
// stopping rule: 20 unused indices in a row means the chain ends there.
const RECEIVE_GAP = 20;
const RECEIVE_SCAN_BATCH = 5; // indices per round → 10 parallel history reads
let receiveScanGen = -1;      // walletGen whose scan COMPLETED (see walletGen: ids repeat, generations don't)
let receiveScanBusy = -1;     // walletGen whose scan is in flight
let receiveScanFailGen = -1;  // walletGen the failure count below belongs to
let receiveScanFails = 0;
// Backoff for a failing indexer. No ceiling on purpose: capping the retries
// reintroduces a slower version of the bug this replaces — a wallet that has
// silently stopped looking for its own coins — and the last step is a minute,
// so an indexer that stays down costs one request per minute per open wallet.
const RECEIVE_RETRY_MS = [2_000, 5_000, 15_000, 60_000];

/** Has either form of this derivation ever appeared on chain? The twin counts:
 * the compat flow (#103) hands out the P2WPKH form of an otherwise untouched
 * index, so a taproot-only scan would walk straight past a paid address. */
async function derivationUsed(d) {
  const [taproot, twin] = await Promise.all([
    fetchIndexer(`/address/${d.address}/history`),
    fetchIndexer(`/address/${d.p2wpkhAddress}/history`),
  ]);
  return taproot.history.length > 0 || twin.history.length > 0;
}

async function syncReceiveIndex() {
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown) return;
  const gen = walletGen;
  // One scan per open, not one per netKnown re-render — openWallet and
  // loadStatus both call this. Two flags, not one: marking the generation
  // SCANNED before the I/O (which is what this used to do) meant a single
  // indexer error retired rediscovery for the rest of the session, and the
  // catch swallowed it, so a restored wallet sat there showing a confidently
  // wrong balance and never looked again.
  if (receiveScanGen === gen || receiveScanBusy === gen) return;
  if (receiveScanFailGen !== gen) { receiveScanFailGen = gen; receiveScanFails = 0; }
  receiveScanBusy = gen;
  let highest = -1;
  try {
    for (let from = 0, gap = 0; gap < RECEIVE_GAP; from += RECEIVE_SCAN_BATCH) {
      const batch = Array.from({ length: RECEIVE_SCAN_BATCH }, (_, k) => from + k);
      const used = await Promise.all(batch.map((i) =>
        derivationUsed(deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }))));
      // locked or switched mid-scan: this answer belongs to a wallet that is
      // no longer on screen, and wallet.seed may already be gone
      // Deliberately leaves receiveScanBusy set to this generation: the wallet
      // it belonged to is gone, and every route back in (openWallet) bumps
      // walletGen, so nothing can be deadlocked by a flag naming a dead one.
      if (!wallet.seed || walletGen !== gen) return;
      used.forEach((isUsed, k) => { if (isUsed) { highest = batch[k]; gap = 0; } else gap += 1; });
    }
  } catch (e) {
    receiveScanBusy = -1;
    // Malformed data is not transient: re-asking every 2s cannot fix a bad
    // payload and is a self-DoS against the proxy's rate limit (#H2). Leave
    // receiveScanGen unset so the next openWallet (which bumps walletGen) still
    // re-scans — this only declines the automatic retry ladder.
    if (e.indexerData) { console.warn('receive-chain scan: ' + e.message); return; }
    // An indexer hiccup used to end rediscovery for the session. Retry with
    // backoff instead, and say so — the original complaint about this path was
    // as much that it failed invisibly as that it failed permanently.
    const wait = RECEIVE_RETRY_MS[Math.min(receiveScanFails, RECEIVE_RETRY_MS.length - 1)];
    receiveScanFails += 1;
    console.warn(`receive-chain scan failed (attempt ${receiveScanFails}), retrying in ${wait}ms:`, e.message);
    setTimeout(() => { if (walletGen === gen) syncReceiveIndex(); }, wait);
    return;
  }
  receiveScanGen = gen; // only now: the chain actually answered
  // One PAST the last index the chain has seen. `highest` was by definition
  // already paid, so offering it again on the receive screen re-uses an
  // address for no benefit; the watch window counts from 0, so moving one
  // further along stops nothing being watched.
  const next = highest + 1;
  if (next <= wallet.index) return;
  wallet.index = next;
  renderAddress();
  refreshMoney();
  rememberReceiveIndex(); // teach this device what the chain just taught us
}

/** Persist the handout counter. Best effort by design: losing it costs an
 * as-yet-unpaid address its watch until the next scan finds it funded — never
 * a coin — so it must not interrupt the receive flow with an error.
 *
 * Serialized: tapping "Next address" three times fires three vault writes, and
 * each one CAS-checks the rev it was computed from. Run in parallel, the later
 * two lose the race and get dropped — the wallet would come back at index 1
 * having handed out index 3. Queued behind each other, each write sees the
 * previous rev; one retry covers a conflict from another tab (the manager
 * re-synced before rethrowing, so the retry computes from fresh meta). */
let receivePersist = Promise.resolve();
function rememberReceiveIndex() {
  if (!wallet.id || vault.status !== 'unlocked') return;
  const gen = walletGen;
  // reads wallet.index when the write RUNS, not when it was queued: three fast
  // taps collapse into one landed write plus two no-ops (the vault skips a
  // write that wouldn't move the counter) instead of three serialized commits
  const write = () => (walletGen === gen && vault.status === 'unlocked'
    ? vault.setReceiveIndex(wallet.id, wallet.index)
    : Promise.resolve()); // switched or locked while queued — not our counter any more
  receivePersist = receivePersist.then(write).catch(write).catch(() => {});
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
  clearTimeout(moneyTimer); // the money poll is a setTimeout chain (#H1)
  $('w-money').style.display = 'none';
  // drop this wallet's Activity view so the next wallet doesn't inherit its
  // expanded page or see its rows flash before the first refresh (#69).
  allHistory = []; historyLimit = 8; myAddrSet = new Set(); $('w-history').innerHTML = '';
  // the outgoing wallet's used-address markers must not label the next one's
  addressUse = new Map(); $('w-prev-list').innerHTML = '';
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
 * fields), later ones ride the unlocked session key — no password re-prompt.
 * The web3 ceremony has its own password fields, so the ids are pluggable. */
async function createWalletEntry({ name, mnemonic, backedUp = false, source = null },
  { passId = 'w-create-pass', pass2Id = 'w-create-pass2' } = {}) {
  if (vault.status === 'unlocked') {
    // duplicate-mnemonic contract: an existing seed comes back existed:true
    const { id, existed } = await vault.addWallet({ name, mnemonic, backedUp, source });
    await vault.setActive(id); // new or duplicate, it becomes the active wallet
    markHadVault(globalThis.localStorage); // #C2: keep the tombstone true
    return { id, existed };
  }
  const pass = $(passId).value;
  if (pass.length < 8) throw new Error('password must be at least 8 characters');
  if (pass !== $(pass2Id).value) throw new Error('passwords do not match');
  const id = await vault.createVault(pass, { name, mnemonic, backedUp, source });
  markHadVault(globalThis.localStorage); // #C2: this browser now holds a vault
  // Fire-and-forget: persist() can prompt, and awaiting a possibly-denied or
  // slow browser prompt inside busy() would freeze the create button (#C2).
  probePersistence({ request: true });
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
    beginBackupCeremony(id, mnemonic, { mandatory: true });
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

// ---- Sign-to-derive: connect a web3 wallet (#130, experimental) ----
// Variant A of the charted flow: co-equal choice → picker → step-wizard
// ceremony → save. Protocol per docs/discovery/sign-to-derive.md; custody
// semantics per #129. web3Pending holds the derived mnemonic ONLY between the
// verify and save steps — setConnectMode clears it on every exit path.
let web3Found = []; // last discovery result, indexed by the picker rows
let web3Entry = null; // the picked provider entry while the ceremony is open
let web3Pending = null; // { mnemonic, source } between verify and save
let web3Address = null; // the connected signing account for this ceremony
let web3ForceNew = false; // set by the explicit "save as NEW wallet" path
let web3Run = 0; // ceremony token: a bumped counter orphans in-flight awaits

function renderWeb3Steps(stage) {
  const brand = esc(web3Entry?.brand ?? '');
  const idx = { disclose: 0, sign1: 1, sign2: 2, verify: 3, done: 4 }[stage] ?? 0;
  const rows = [
    ['Acknowledge the risk', ''],
    ['Signature 1 of 2', ` — check the ${brand} popup…`],
    ['Signature 2 of 2', ' — same message, proves determinism…'],
    [stage === 'done' ? 'Signatures match — wallet derived' : 'Compare the two signatures', ''],
  ];
  $('w-web3-steps').innerHTML = rows.map(([label, active], i) => {
    const ok = i < idx;
    const on = !ok && i === idx && stage !== 'disclose';
    const body = on ? `<span class="w3-wait">${label}${active}</span>` : `<span>${label}</span>`;
    return `<div class="w3-step${on ? ' on' : ''}${ok ? ' ok' : ''}"><span class="n">${ok ? icon('check', 'ic-s') : i + 1}</span>${body}</div>`;
  }).join('');
}

// The two-step display for the one-signature reconnect verification.
function renderWeb3VerifySteps(stage) {
  const brand = esc(web3Entry?.brand ?? '');
  const done = stage === 'done';
  const tick = icon('check', 'ic-s');
  $('w-web3-steps').innerHTML =
    `<div class="w3-step${done ? ' ok' : ' on'}"><span class="n">${done ? tick : '1'}</span>`
    + (done ? '<span>Signature received</span>' : `<span class="w3-wait">Known account — one signature to verify, check the ${brand} popup…</span>`)
    + '</div>'
    + `<div class="w3-step${done ? ' ok' : ''}"><span class="n">${done ? tick : '2'}</span><span>Compare with the stored fingerprint</span></div>`;
}

async function openWeb3Picker() {
  // belt for the boot race: the button is hidden on mainnet, but a click that
  // lands before the chain poll resolves must still refuse (ADR 0005)
  if (chainState.netName === 'mainnet') {
    setConnectMode('choice');
    $('w-none-err').textContent = 'Connecting a web3 wallet is testnet-only for now.';
    return;
  }
  setConnectMode('web3-pick');
  const listEl = $('w-web3-list');
  listEl.innerHTML = '<p class="hint">Looking for wallet extensions…</p>';
  const found = await discoverProviders();
  if (connectMode !== 'web3-pick') return; // user navigated away while we listened
  web3Found = found;
  if (!found.length) {
    listEl.innerHTML = `<div class="w3-row" style="opacity:.65"><span class="w3-fallback-ic">${icon('puzzle', 'ic-s')}</span>`
      + '<span><span class="w3-name">No wallet extensions detected</span><br/>'
      + '<span class="w3-sub">Install MetaMask, Phantom, OKX or any EIP-6963 wallet extension, then reload this page.</span></span></div>';
    return;
  }
  listEl.innerHTML = found.map((w, i) => {
    // EIP-6963 icons are wallet-supplied — admit data:image URIs only.
    // Named brandIcon, not icon: a local `icon` here would shadow the sprite
    // helper for the whole callback.
    const brandIcon = typeof w.icon === 'string' && /^data:image\//.test(w.icon)
      ? `<img src="${esc(w.icon)}" alt="" />`
      : `<span class="w3-fallback-ic">${esc((w.brand || '?').slice(0, 1).toUpperCase())}</span>`;
    // symmetric copy: the old EVM row said "detected extension", which named the
    // discovery mechanism rather than the curve the signature will use
    const sol = w.kind === 'sol';
    const sub = sol ? 'Solana signature (Ed25519)' : 'EVM signature (secp256k1)';
    return `<button type="button" class="w3-row" data-web3-pick="${i}">${brandIcon}`
      + `<span class="w3-txt"><span class="w3-name">${esc(w.brand)}</span><br/><span class="w3-sub">${sub}</span></span>`
      + `<span class="chainpill">${sol ? 'SOL' : 'EVM'}</span></button>`;
  }).join('');
}

$('w-web3-choice').addEventListener('click', () => { openWeb3Picker(); });
$('w-web3-back').addEventListener('click', () => setConnectMode('choice'));
$('w-web3-sign-back').addEventListener('click', () => { openWeb3Picker(); });
// Picking a wallet connects it FIRST: a known (kind, account) routes to the
// one-signature reconnect verification (#129: reconnects never re-ask the
// checkbox); an unknown one gets the full first-derive ceremony.
$('w-web3-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-web3-pick]');
  const entry = btn && web3Found[Number(btn.dataset.web3Pick)];
  if (!entry) return;
  setConnectMode('web3-sign'); // clears any stale ceremony (and bumps web3Run)
  const run = web3Run;
  web3Entry = entry;
  try {
    const address = await connectAccount(entry);
    if (run !== web3Run) return; // ceremony abandoned while the popup was open
    web3Address = address;
    const known = vault.status === 'unlocked' ? vault.findSource(entry.kind, address) : null;
    if (known) { await verifyReconnect(entry, address, run); return; }
    renderWeb3Steps('disclose');
    $('w-web3-disclose').style.display = 'block';
  } catch (err) {
    if (run !== web3Run) return;
    $('w-web3-err').textContent = surfaceError(err);
  }
});

// One signature, re-derive, compare the stored fingerprint (spec §8). Match →
// verified switch. Mismatch → hard stop; the explicit new-wallet path must
// then run the FULL ceremony — one signature has not proven determinism.
async function verifyReconnect(entry, address, run) {
  renderWeb3VerifySteps('sign');
  const derived = await deriveOnce(entry, address);
  if (run !== web3Run) return;
  renderWeb3VerifySteps('done');
  const exact = vault.findSource(derived.source.kind, derived.source.address, derived.source.fp);
  if (exact) {
    const name = vault.meta().wallets.find((w) => w.id === exact.id)?.name ?? '';
    await vault.setActive(exact.id);
    switchToWallet(exact.id); // full reset closes the modal
    openWalletModal(`Re-derived and verified — switched to ${name}.`);
    return;
  }
  showWeb3Mismatch(derived.source.brand);
}
$('w-web3-agree').addEventListener('change', (e) => { $('w-web3-go').disabled = !e.target.checked; });

function showWeb3Mismatch(brand) {
  $('w-web3-mismatch-text').textContent =
    `${brand} no longer produces the signature that created your existing derived wallet. `
    + 'Your funds are safe at that wallet’s addresses, but this extension can no longer re-derive them — '
    + 'restore from its 24-word phrase if you ever lose this browser. '
    + 'You can still save today’s signature as a separate, NEW wallet.';
  $('w-web3-mismatch').style.display = 'block';
}

$('w-web3-go').addEventListener('click', (e) =>
  busy(e.target, 'w-web3-err', async () => {
    const entry = web3Entry;
    const run = web3Run;
    $('w-web3-disclose').style.display = 'none';
    let derived;
    try {
      derived = await deriveFromSource(entry, { onStep: renderWeb3Steps, address: web3Address });
    } catch (err) {
      if (run !== web3Run) return; // ceremony abandoned — a late popup must not resurface it
      // refusal or user-rejected popup: back to the armed disclosure, error below
      renderWeb3Steps('disclose');
      $('w-web3-disclose').style.display = 'block';
      throw err;
    }
    if (run !== web3Run) return;
    renderWeb3Steps('done');
    // A full ceremony can still land on a known source (vault unlocked mid-way
    // or the sanctioned re-derive): exact fingerprint → verified switch;
    // same account with no exact match → hard stop, never a silent save.
    if (vault.status === 'unlocked' && !web3ForceNew) {
      const exact = vault.findSource(derived.source.kind, derived.source.address, derived.source.fp);
      if (exact) {
        const name = vault.meta().wallets.find((w) => w.id === exact.id)?.name ?? '';
        await vault.setActive(exact.id);
        switchToWallet(exact.id); // full reset closes the modal
        openWalletModal(`Re-derived and verified — switched to ${name}.`);
        return;
      }
      if (vault.findSource(derived.source.kind, derived.source.address)) {
        web3Pending = derived; // double-signed already — "new wallet" may save it directly
        showWeb3Mismatch(derived.source.brand);
        return;
      }
    }
    web3Pending = derived;
    showWeb3Save();
  }));

function showWeb3Save() {
  const base = `${web3Entry.brand} wallet`;
  const taken = new Set((vault.meta()?.wallets ?? []).map((w) => w.name.trim().toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
  $('w-web3-name').value = name;
  $('w-web3-pass-fields').style.display = vault.status === 'none' ? 'block' : 'none';
  $('w-web3-save').style.display = 'block';
}

$('w-web3-newwallet').addEventListener('click', () => {
  $('w-web3-mismatch').style.display = 'none';
  web3ForceNew = true;
  if (web3Pending) { showWeb3Save(); return; } // already double-sign-proven
  // the mismatch came from the one-signature reconnect check: a NEW wallet
  // needs the full ceremony — one signature has not proven determinism
  renderWeb3Steps('disclose');
  $('w-web3-disclose').style.display = 'block';
});

$('w-web3-save-go').addEventListener('click', (e) =>
  busy(e.target, 'w-web3-err', async () => {
    if (!web3Pending) throw new Error('the ceremony expired — start again');
    const brand = web3Pending.source.brand;
    const name = $('w-web3-name').value.trim() || `${brand} wallet`;
    const { id, existed } = await createWalletEntry(
      { name, mnemonic: web3Pending.mnemonic, backedUp: false, source: web3Pending.source },
      { passId: 'w-web3-pass', pass2Id: 'w-web3-pass2' },
    );
    web3Pending = null;
    switchToWallet(id); // full reset closes the modal
    if (existed) {
      const w = vault.meta().wallets.find((x) => x.id === id);
      openWalletModal(`You already have this wallet (${w.name}) — switched to it.`);
    } else {
      // no forced reveal (#129): the badge + strip carry the backup pressure
      openWalletModal(`Derived from ${brand}. Back up its 24 words when you’re ready — the badge will remind you.`);
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
    // #C2: an unlock is a user gesture, so this is one of the two moments the
    // browser will honour a persist() request. Fire-and-forget — a denied or
    // slow prompt must not sit on the unlock path.
    markHadVault(globalThis.localStorage);
    probePersistence({ request: true });
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
    // #C2: a deliberate erase is not an eviction. Clear BEFORE show(), or the
    // recovery hero flashes at the user who just chose to erase.
    clearHadVault(globalThis.localStorage);
    await vault.load();
    show('none'); // back to the guest hero; the modal drops to choice mode
  }));

$('w-lock').addEventListener('click', lockWallet);
$('w-next').addEventListener('click', () => {
  wallet.index += 1;
  renderAddress();
  refreshMoney();
  rememberReceiveIndex(); // this address is now out in the world — keep watching it
});
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
      const res = await apiFetch('/api/faucet/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: $('w-address').textContent }),
        budget: NET_TIMEOUT_MS.faucet, // outlives the server's own 30s upstream budget
        what: 'the faucet',
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
function autolockDelayMs() {
  // #L10: `mock` DEFAULTS to true (appConfig is a placeholder until /api/config
  // answers) and boot's catch leaves that default in place when the fetch fails
  // — so on a live deployment with a flaky config request, a crafted
  // ?autolockSecs=86400 link used to stretch the lock to a day. Require a LOADED
  // config that says mock, exactly like the #w-no-indexer gate in show(). The
  // cap keeps even a mock-mode link from disabling the lock outright.
  if (appConfig.loaded && appConfig.mock) {
    const secs = Number(new URLSearchParams(location.search).get('autolockSecs'));
    if (Number.isFinite(secs) && secs > 0 && secs <= 600) return secs * 1000;
  }
  let raw = null;
  try { raw = localStorage.getItem(AUTOLOCK_KEY); } catch { /* private mode → default */ }
  return autolockMinutes(raw) * 60_000; // 0 = Never
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
/** Open the reveal → quiz flow over the (already open) wallet.
 * `mandatory` marks the ONE ceremony that opens straight off wallet creation:
 * on mainnet (or an unknown chain) that one cannot be dismissed at all (#C3).
 * Re-entries stay dismissible — see reenterBackupCeremony. */
function beginBackupCeremony(id, mnemonic, { mandatory = false } = {}) {
  ceremony = { id, words: mnemonic.trim().split(/\s+/), quiz: null, mandatory };
  renderBackupGrid(false);
  setConnectMode('backup');
  $('w-connect-modal').classList.add('open');
}
$('w-backup-show').addEventListener('click', () => { renderBackupGrid(true); armSeedHide(); });
$('w-backup-continue').addEventListener('click', () => { buildQuiz(); setConnectMode('quiz'); });
// The only route back out of the quiz on a sealed ceremony (#C3): mode + regrid
// is the established re-entry pair (setConnectMode wipes the word nodes but not
// `ceremony`, so the words are still there to re-render, blurred).
$('w-quiz-back').addEventListener('click', () => { setConnectMode('backup'); renderBackupGrid(false); });

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

// #M1: the encrypted backup file at the success beat, not only buried in the
// switcher's ⋯ menu. Re-auth gated exactly like the switcher export: the typed
// password IS the file's KDF input, so the prompt doubles as proof the user can
// open what they are about to save. It does NOT set backedUp (spec §4) — the
// quiz already did, and a file must never be what flips that flag.
$('w-backup-file').addEventListener('click', (e) =>
  busy(e.target, 'w-backup-file-err', async () => {
    const id = ceremony?.id;
    if (!id) throw new Error('this backup ceremony is no longer open');
    const pass = await requireReauth('Confirm your password to save an encrypted copy of this wallet.');
    if (!pass) return; // cancelled — no error, no file
    // The await above is a real gap: autolock, a cross-tab erase or a wallet
    // switch can have torn the vault down while the prompt was open. Re-check
    // the ceremony id too — a cross-tab setActive must not export the wrong seed.
    if (vault.status !== 'unlocked' || ceremony?.id !== id) throw new Error('the wallet was locked — unlock and try again');
    const w = vault.meta().wallets.find((x) => x.id === id);
    if (!w) throw new Error('this wallet is no longer in the vault');
    downloadKeystoreFile(await keystore.buildKeystoreFile({
      name: w.name,
      network: chainState.netKnown ? chainState.netName : null,
      mnemonic: vault.getMnemonic(id),
      password: pass,
    }));
    const saved = $('w-backup-file-saved');
    saved.textContent = `Saved ${keystore.keystoreFileName(w.name)} — it only opens with your master password.`;
    saved.style.display = 'block';
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
  // inline-FLEX, not inline-block: the badge carries an icon beside its label
  // now, and an inline style beats the stylesheet's display (#138)
  $('w-backup-badge').style.display = nag ? 'inline-flex' : 'none';
  renderBackupStrip();
}

/** Every backup re-entry surface (badge, strip, receive guard, net-modal
 * button) funnels here — re-auth gated like any other seed access (§5). */
async function reenterBackupCeremony() {
  if (!wallet.id) return;
  if (!(await requireReauth('Confirm your password to back up this wallet.'))) return;
  $('net-modal').classList.remove('open');
  // NOT mandatory (#C3): cancelling a re-entry returns the user to the state
  // they were already in, so sealing it is pure friction with no custody gain —
  // and it would trap anyone who taps the "Not backed up" badge just to look.
  // The create-time seal is what removes the one-click "skip your only backup".
  beginBackupCeremony(wallet.id, vault.getMnemonic(wallet.id));
}
$('w-backup-now').addEventListener('click', reenterBackupCeremony);
$('w-backup-badge').addEventListener('click', reenterBackupCeremony);

// Warning strip: the active wallet is not backed up AND either holds something
// the indexer can see (confirmed DGB, spendable DD, a locked position) OR sits
// in a store the browser has not marked persistent (#C2 — at zero balance the
// eviction risk is the whole argument). Dismiss is per wallet, per page load —
// the nag comes back next session by design. A no-indexer deployment never
// learns the balance, so the receive interception below is the only
// funds-arriving guard there.
const stripDismissed = new Set(); // wallet ids dismissed this session
function renderBackupStrip() {
  const m = vault.status === 'unlocked' ? vault.meta() : null;
  const active = m?.wallets.find((w) => w.id === wallet.id); // the wallet on display
  const funds = (lastConfirmedDgb ?? 0) > 0 || lastDdUsd > 0 || openPositions.size > 0;
  // #C2: an unprotected (evictable) store makes the missing backup urgent even
  // at zero balance — the coins that arrive tomorrow die with the vault.
  // Unknown/unsupported counts as unprotected: this nag is dismissible, a
  // silently-evicted wallet is not.
  const evictable = persistState?.persisted !== true;
  const nag = Boolean(active && !active.backedUp && (funds || evictable) && !stripDismissed.has(active.id));
  if (nag) {
    // derived-aware copy (#129): the source wallet is a convenience door, not
    // a guaranteed backup — say so where the money pressure is.
    let brand = null;
    if (active.derived) { try { brand = vault.getSource(active.id)?.brand ?? null; } catch { /* mid-lock */ } }
    const evictLine = evictable
      ? ' This browser has not marked the wallet\'s storage as protected — it can be evicted without warning.'
      : '';
    $('w-backup-strip-text').textContent = active.derived
      ? `This wallet is protected only by ${brand ?? 'your web3 wallet'} re-signing — back up the 24 words in case ${brand ?? 'it'} ever changes how it signs.${evictLine}`
      : (funds
        ? `This wallet holds funds but has no backup — if this browser data is lost, the funds are gone.${evictLine}`
        : `This wallet has no backup.${evictLine} Back it up before any funds arrive.`);
  }
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
  setReceiveTab('dgb'); // DGB is the default form; DigiDollar is a deliberate switch
  setPrevShown(false);  // the current address is the answer to "receive" — history is opt-in
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
    // derived wallets carry their origin on the row (#128 variant A); the
    // source record is encrypted, so the detail only renders while unlocked
    let via = '';
    if (w.derived) {
      let src = null;
      try { src = vault.getSource(w.id); } catch { /* locked mid-render */ }
      via = src
        ? `<div class="wal-sub">via ${esc(src.brand)} · <span class="mono">${esc(shortAddress(src.address))}</span> · <span class="badge exp">EXPERIMENTAL</span></div>`
        : '<div class="wal-sub">derived from a web3 wallet · <span class="badge exp">EXPERIMENTAL</span></div>';
    }
    return `<div class="wal-row">` +
      `<button type="button" class="wal-pick" data-switch="${esc(w.id)}">` +
      `<span><span class="wal-name">${esc(w.name)}</span>${dot}${via}${sub}</span>` +
      (active ? `<span class="wal-check">${icon('check', 'ic-s')}</span>` : '') +
      `</button>` +
      `<button type="button" class="wal-manage secondary" data-manage="${esc(w.id)}" title="Rename or remove" aria-label="Rename or remove">${icon('more', 'ic-s')}</button>` +
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
    rederiveHint(w) +
    `</div>`;
}

// #129 (ratified): the erase/manage surface advertises re-derivability — the
// one recovery property a derived wallet has that a native one doesn't.
function rederiveHint(w) {
  if (!w.derived) return '';
  let src = null;
  try { src = vault.getSource(w.id); } catch { /* locked mid-render */ }
  return src
    ? `<p class="hint" style="margin:6px 0 0">Derived wallet: you can re-create it any time by reconnecting ${esc(src.brand)} with the account ${esc(shortAddress(src.address))} and signing again.</p>`
    : '';
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
  // #129 (ratified): a derived wallet's remove warning advertises the one
  // recovery door a native wallet doesn't have — reconnect + re-sign.
  let rederive = null;
  if (w.derived) { try { rederive = vault.getSource(id); } catch { /* locked mid-render */ } }
  lines.push(w.backedUp
    ? 'You verified its seed phrase backup — that phrase can restore it later.'
    : rederive
      ? `This wallet is NOT backed up, but it is derived: reconnecting ${rederive.brand} with the account ${shortAddress(rederive.address)} and signing again re-creates it — unless ${rederive.brand} ever changes how it signs.`
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
      clearHadVault(globalThis.localStorage); // #C2: deliberate erase, not an eviction (before show)
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

// Shape rules per endpoint (#H2). Strict-vs-tolerant is a property of the
// SHAPE, not of the caller: /utxos and /dd-utxos each have a display caller and
// a signing caller, and threading a `strict` flag from callers would guarantee
// one gets missed. The path patterns deliberately mirror the proxy's own
// allow-list in server.js so client and server cannot drift.
const INDEXER_SHAPES = [
  [/^\/address\/([a-z0-9]+)\/utxos$/, validateUtxosResponse],
  [/^\/address\/([a-z0-9]+)\/history$/, validateHistoryResponse],
  [/^\/address\/([a-z0-9]+)\/positions$/, validatePositionsResponse],
  [/^\/address\/([a-z0-9]+)\/dd-utxos$/, validateDdUtxosResponse],
  [/^\/tx\/([0-9a-f]{64})$/, (json) => validateTxDetail(json)],
];

async function fetchIndexer(path) {
  const res = await apiFetch('/api/indexer' + path, { budget: NET_TIMEOUT_MS.indexer, what: 'the balance index' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  for (const [re, validate] of INDEXER_SHAPES) {
    const m = re.exec(path);
    if (m) return validate(json, m[1]);
  }
  throw new Error(`unrouted indexer path: ${path}`); // unreachable — the proxy path-restricts first
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
  // the retained tip (#H5), same value this poll just installed. `?? 0` is not
  // decoration: without it blocksLeft becomes NaN, NaN > 0 is false, and every
  // still-locked position silently swaps its "locked until…" line for a Redeem
  // button that consensus (CLTV) would reject.
  const tipHeight = lastIndexerTip ?? 0;
  const totalCents = positions.reduce((n, p) => n + Number(p.ddCents), 0);
  $('w-dd-total').textContent = positions.length ? fmtUSD(totalCents / 100) : '';
  if (!positions.length) {
    $('w-positions').textContent = 'No open positions.';
    return;
  }
  // unlockHeight is an integer height by the time it gets here — validate.js
  // enforces it at the fetch boundary, which is also the gate the redeem SIGNER
  // depends on (it becomes the tx's nLockTime). Validating only for the render
  // would have been half a fix (#L5).
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

// The node height comes from the 60s status poll and the indexer tip from the
// 8s money poll, so the two readings are skewed by up to one block at a block
// boundary. Two or more blocks of lag is real lag, not poll skew (#H5).
const STALE_TIP_LAG_BLOCKS = 2;

function indexerLagBlocks() {
  if (!Number.isInteger(lastNodeHeight) || !Number.isInteger(lastIndexerTip)) return null;
  return lastNodeHeight - lastIndexerTip;
}

/** Warn on a confirm screen when the balance index is behind the node. Written
 *  at REVIEW time from the retained poll state — never re-read inside the
 *  confirm handler, which must sign exactly what was reviewed. Advisory only:
 *  it never gates the Confirm button, or a permanently-behind index would
 *  strand the user's funds. */
function renderStaleTipWarning(id) {
  const el = $(id);
  const lag = indexerLagBlocks();
  const stale = lag != null && lag >= STALE_TIP_LAG_BLOCKS;
  el.textContent = stale
    ? `The balance index is ${lag.toLocaleString('en-US')} blocks behind the node. Your DGB balance and `
      + 'DigiDollar positions may be out of date — wait for it to catch up and re-check before confirming.'
    : '';
  el.style.display = stale ? 'block' : 'none';
}

async function refreshMoney() {
  // netKnown gate: querying the indexer with addresses derived for a GUESSED
  // network would render a confident zero balance — wait for the real chain
  // (the 8s poll picks up automatically once loadStatus succeeds).
  if (!wallet.seed || !appConfig.indexer || !chainState.netKnown) return;
  // Which wallet this poll belongs to. clearInterval on switch stops FUTURE
  // ticks; it cannot cancel one already in flight, and the seed check below is
  // not enough on its own — a switch REPLACES wallet.seed rather than nulling
  // it, so the outgoing poll sails through and paints the previous wallet's
  // balance, history and positions onto the wallet now on screen.
  const gen = walletGen;
  try {
    // Each derivation is watched at TWO addresses: its P2TR (receive address,
    // carries DD positions/tokens) and its P2WPKH twin — mint change lands
    // there by consensus (#38), so it must count toward balance and history.
    // DD lives on P2TR only; the twin contributes plain DGB.
    const addrs = watchedDerivations().flatMap((d, index) => [
      { address: d.address, dd: true, index },
      { address: d.p2wpkhAddress, dd: false, index },
    ]);
    const perAddr = await Promise.all(addrs.map(async ({ address: a, dd }) => ({
      utxos: (await fetchIndexer(`/address/${a}/utxos`)).utxos,
      history: (await fetchIndexer(`/address/${a}/history`)).history,
      positions: dd ? await fetchIndexer(`/address/${a}/positions`) : { address: a, positions: [], tipHeight: 0 },
      ddCents: dd ? BigInt((await fetchIndexer(`/address/${a}/dd-utxos`)).totalCents) : 0n,
    })));
    // locked (seed nulled, generation unchanged) or switched (generation bumped)
    // while we were fetching — either way this answer is not about the wallet
    // the user is looking at
    if (!wallet.seed || walletGen !== gen) return;
    // AFTER the guard on purpose (#H5): a switched-away wallet's in-flight poll
    // must not install a tip. The `h > 0` filter drops the non-DD stubs above,
    // which carry tipHeight 0 — same effect as the old Math.max(0, …).
    const tips = perAddr.map((r) => r.positions?.tipHeight).filter((h) => Number.isInteger(h) && h > 0);
    if (tips.length) lastIndexerTip = Math.max(...tips);
    // Which derivations have actually seen money — for the receive view's
    // address list. Both forms of an index count as that index: a payer who
    // used the compat twin paid the same address as far as the user is
    // concerned. History, not UTXOs: a spent-clean address was still used.
    addressUse = new Map();
    perAddr.forEach((r, i) => {
      const { index } = addrs[i];
      const at = addressUse.get(index) ?? { used: false, sats: 0 };
      at.used = at.used || r.history.length > 0;
      at.sats += r.utxos.reduce((n, u) => n + Number(u.valueSats), 0);
      addressUse.set(index, at);
    });
    renderPrevAddresses(); // no-op unless the list is open
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
    // a transient indexer hiccup shouldn't leave a stale error after recovery —
    // 'indexer' (not 'indexer:') so the malformed-data copy clears too (#H2)
    if ($('w-open-err').textContent.startsWith('indexer')) $('w-open-err').textContent = '';
    const firstShow = $('w-money').style.display === 'none';
    $('loading-veil').style.display = 'none';
    $('w-money').style.display = 'grid';
    if (firstShow) renderSparkline(lastPriceSeries); // real width only now
  } catch (e) {
    // Same reasoning as the success path: the outgoing wallet's indexer error
    // is not the incoming wallet's, and tearing down the veil here would
    // uncover a panel the new wallet has not painted yet. Dropping this is
    // safe because the incoming wallet always has its own poll running
    // (openWallet → startMoneyPolling), which hides the veil on either outcome.
    if (walletGen !== gen) return;
    $('loading-veil').style.display = 'none';
    // Malformed data is neither a hiccup nor a sync lag, and the message already
    // names the problem — don't prefix it again (#H2).
    if (e.indexerData) { $('w-open-err').textContent = e.message; return; }
    // transport-level failures mean the index isn't serving yet (e.g. initial
    // ElectrumX sync after a deployment) — say that, not ECONNREFUSED. The regex
    // only ever matched errors the SERVER produced; e.transport covers the
    // client-side timeout/dead-hop cases, whose copy matches none of these (#H1).
    $('w-open-err').textContent = e.transport || /ECONNREFUSED|ETIMEDOUT|unreachable|socket|502|503/i.test(e.message)
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
  // esc() as well as the boundary scheme filter (#L5): the prefix is operator
  // config, but it lands inside a double-quoted href, where an unescaped " ends
  // the attribute. A falsy prefix degrades to a plain txid — regtest behaviour.
  return appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
    ? `<a href="${esc(appConfig.explorerTxUrl)}${txid}" target="_blank" rel="noopener">${short}</a>`
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
    // 'more', not a '·' glyph: direction is unknown until enrichment lands, and
    // .tx-icon no longer carries the font-size/weight a bare character needs
    return `<div class="tx"><div class="tx-icon out">${icon('more')}</div>` +
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

  let title, iconCls, glyph, cp = '', amt;
  if (detail.type !== 'dgb') {
    // The DGB shown for a DD tx is the collateral movement: a mint locks it
    // (out), a redeem frees it (back to us); a DD-only transfer is DGB-neutral
    // (just the fee), so no DGB amount — the label carries the meaning.
    title = DD_LABEL[detail.type] || 'DigiDollar';
    iconCls = 'dd'; glyph = icon('diamond');
    amt = detail.type === 'mint' ? -toOthers : detail.type === 'redeem' ? toMine : 0n;
    cp = sent && extOut ? `to ${truncAddr(extOut.address)}` : (extIn ? `from ${truncAddr(extIn.address)}` : '');
  } else if (sent) {
    title = toOthers > 0n ? 'Sent' : 'Sent to self';
    iconCls = 'out'; glyph = icon('tx-out'); amt = -toOthers;
    cp = extOut ? `to ${truncAddr(extOut.address)}` : '';
  } else {
    title = coinbase ? 'Mined' : 'Received';
    iconCls = 'in'; glyph = icon('tx-in'); amt = toMine;
    cp = !coinbase && extIn ? `from ${truncAddr(extIn.address)}` : '';
  }

  const amtCls = amt > 0n ? 'in' : 'out';
  const sign = amt > 0n ? '+' : amt < 0n ? '−' : '';
  const amtStr = amt === 0n ? '' : `${sign}${fmtDgb8(amt < 0n ? -amt : amt)} DGB`; // no misleading "0 DGB"
  const c = Number(detail.confirmations) || 0; // coerce: a number never carries markup
  const conf = (c <= 0 || h.height === 0)
    ? '<span class="tx-conf pending">pending</span>'
    : c >= FINAL_CONF ? `<span class="tx-conf final">${icon('check', 'ic-s')}final</span>`
      : `<span class="tx-conf partial">${c} conf</span>`;
  const feeStr = sent && detail.feeSats != null ? `fee ${fmtDgb8(sat(detail.feeSats))} DGB` : '';
  const time = Number(detail.time) || 0;
  const sub = [cp, relTime(time), feeStr].filter(Boolean).join(' · ');

  return `<div class="tx">` +
    `<div class="tx-icon ${iconCls}">${glyph}</div>` +
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
    const { series } = await (await apiFetch('/api/price-history', {
      budget: NET_TIMEOUT_MS.priceHistory, what: 'the price history',
    })).json();
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
  // "Max" is armed out-of-band from the field it filled, so it has to be
  // disarmed by every path that abandons a draft — cancel, modal close, lock,
  // and WALLET SWITCH (resetWalletState calls this). Left armed, the next
  // Review re-plans a full drain against whatever wallet is open by then,
  // silently turning "send 10" into "send everything I now hold".
  sendMaxArmed = false;
  $('w-send-amount').value = '';
  $('w-send-c-stale').style.display = 'none'; // a re-opened confirm must not flash stale copy (#H5)
  updateSendEq();
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
    // BIP21 amounts are DGB by definition, and sendCcy is STICKY — it survives
    // from an earlier USD send in the same session. Writing a DGB figure while
    // the field is read as USD (sendAmountSats) meant a `?amount=200` request
    // was reviewed as $200: at $0.01/DGB that is 75x what the payee asked for.
    // Switch the field to the currency the number is actually in.
    if (sendCcy === 'USD') setSendCcy('DGB');
    // satsToDgbString (not the locale-formatted satsToDgb): no thousands commas,
    // so the value stays parseable by dgbToSats at review for amounts ≥ 1000 DGB.
    $('w-send-amount').value = satsToDgbString(parsed.amountSats);
    sendMaxArmed = false; // a requested amount is not a drain
    updateSendEq();       // the ≈-line is the only on-screen cue; it must not lag
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
// The node's own is_stale flag is the primary gate, but it only arrives with a
// poll. A tab that was throttled or a laptop that was asleep can hold a fresh
// -looking quote that is hours old, so the local age of the last answer is a
// second, independent conjunct. Kept at several times the poll cadence so one
// dropped tick does not disable USD entry.
const PRICE_MAX_AGE_MS = 180_000;
const priceUsable = () => lastPriceMicroUsd != null && lastPriceMicroUsd > 0n
  && netHealth.oracle === true
  && lastPriceAt != null && Date.now() - lastPriceAt < PRICE_MAX_AGE_MS;

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
    if (sendCcy === 'USD') {
      // Demoting USD→DGB re-reads the SAME digits in a different currency —
      // the #116 bug class, now fired by a timer instead of a paste. So the
      // number goes, and Max goes with it: the Max handler arms sendMaxArmed
      // and then leaves the field on USD, and review checks sendMaxArmed
      // FIRST. Left armed behind a blanked field, the next Review would plan a
      // drain of the whole spendable balance that the user never asked for —
      // triggered by nothing more than one stale or failed getoracleprice.
      $('w-send-amount').value = '';
      sendMaxArmed = false;
      setSendCcy('DGB'); // refreshes the ≈-line last, so it describes the cleared field
    }
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
    // Allow-list the script type instead of paying whatever decodeAddress
    // produced. The decoder rejects out-of-range witness versions now, but this
    // side must not depend on that: `type` was previously computed and never
    // read, so a decoder that ever admits a new form would silently become a
    // scriptPubKey the user pays. Anything not on this list is a bug, not a
    // recipient.
    if (!PAYABLE_ADDRESS_TYPES.has(decoded.type)) {
      throw new Error(`unsupported address type (${decoded.type}) — refusing to pay it`);
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
    renderStaleTipWarning('w-send-c-stale'); // #H5 — the coins this plan spends may already be gone
    $('w-send-confirm').style.display = 'block';
    $('w-send-review').disabled = true;
  }));

$('w-send-cancel').addEventListener('click', resetSend);

$('w-send-go').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    const { plan, recipientScriptHex, amountSats, address } = pendingSend;
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
    // formatted strings only: a BigInt in the record would make JSON.stringify
    // throw and the journal entry would be silently lost (#C1)
    const txid = await broadcastTx(hex, { kind: 'send', summary: `${satsToDgb(amountSats)} DGB to ${address}` });
    resetSend(); // clears the amount, disarms Max, refreshes the ≈-line
    $('w-send-to').value = '';
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
  $('w-cons-c-stale').style.display = 'none'; // a re-opened confirm must not flash stale copy (#H5)
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
    renderStaleTipWarning('w-cons-c-stale'); // #H5
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
    const txid = await broadcastTx(hex, {
      kind: 'consolidate',
      summary: `consolidate ${plan.inputs.length} coins into ${satsToDgb(plan.amountSats)} DGB`,
    });
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
  $('w-mint-c-stale').style.display = 'none'; // a re-opened confirm must not flash stale copy (#H5)
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
    // free freshness for the staleness warning below — this flow already pays
    // for the RPC, so its node height is the newest one in the app (#H5)
    if (Number.isInteger(tipHeight)) lastNodeHeight = tipHeight;
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
    renderStaleTipWarning('w-mint-c-stale'); // #H5
    $('w-mint-confirm').style.display = 'block';
    $('w-mint-review').disabled = true;
  }));

$('w-mint-cancel').addEventListener('click', resetMint);

$('w-mint-go').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    const { utxo, ddCents, tierId, priceMicroUsd, dcaMultiplierBps } = pendingMint;
    if (!wallet.seed) throw new Error('wallet is locked');
    const { blocks: tipHeight } = await rpc('getblockchaininfo'); // fresh height at sign time
    if (Number.isInteger(tipHeight)) lastNodeHeight = tipHeight; // #H5
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
    const txid = await broadcastTx(hex, {
      kind: 'mint',
      summary: `mint $${(Number(ddCents) / 100).toFixed(2)} DigiDollar`,
    });
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
  $('w-tr-c-stale').style.display = 'none'; // a re-opened confirm must not flash stale copy (#H5)
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
    // Smallest coin that covers the amount AND leaves legal change. Consensus
    // checks every DD output of a transfer against the $1 minimum, change
    // included, so a coin that would leave 1..99c of change cannot be spent for
    // this amount at all — picking it anyway builds a transaction the network
    // refuses. Spending the coin whole leaves no change output, so that is fine
    // at any size. Without this clause the old smallest-first pick would take
    // the $10.50 coin to send $10.00 and fail, while an untouched $20.00 coin
    // sitting right beside it would have worked.
    const leavesLegalChange = (u) => u.ddCents === cents || u.ddCents - cents >= trLimits.minOutputCents;
    const covering = ddUtxos.filter((u) => u.ddCents >= cents);
    const ddUtxo = covering.filter(leavesLegalChange).sort((a, b) => (a.ddCents < b.ddCents ? -1 : 1))[0];
    if (!ddUtxo) {
      const fmtDD = (c) => (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      const minDD = `$${(Number(trLimits.minOutputCents) / 100).toFixed(2)}`;
      throw new Error(covering.length
        // every coin big enough would leave illegal change — name the way out,
        // which is an amount, not a different coin
        ? `no single DigiDollar coin can send $${fmtDD(cents)} and leave legal change: the coins that cover it would each leave under ${minDD}, which consensus rejects. Send the whole coin ($${fmtDD(covering.sort((a, b) => (a.ddCents < b.ddCents ? -1 : 1))[0].ddCents)}) or at least ${minDD} less.`
        : totalCents >= cents
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
    renderStaleTipWarning('w-tr-c-stale'); // #H5
    $('w-tr-confirm').style.display = 'block';
    $('w-tr-review').disabled = true;
  }));

$('w-tr-cancel').addEventListener('click', resetTransfer);

$('w-tr-go').addEventListener('click', (e) =>
  busy(e.target, 'w-tr-err', async () => {
    const { ddUtxo, feeUtxo, cents, outputKeyHex, address } = pendingTransfer;
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
    const txid = await broadcastTx(hex, {
      kind: 'transfer',
      summary: `transfer $${(Number(cents) / 100).toFixed(2)} DigiDollar to ${address}`,
    });
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
  $('w-rd-c-stale').style.display = 'none'; // a re-opened confirm must not flash stale copy (#H5)
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
    // #H5 — a stale index is exactly the case where this position may already
    // have been spent, and the redeem builder consumes the same payload
    renderStaleTipWarning('w-rd-c-stale');
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
    const txid = await broadcastTx(hex, {
      kind: 'redeem',
      summary: `redeem $${(Number(p.ddCents) / 100).toFixed(2)} DigiDollar (position ${p.txid.slice(0, 12)}…)`,
    });
    resetRedeem();
    const short = txid.slice(0, 16) + '…';
    // the prefix is scheme-filtered at the /api/config boundary and escaped
    // here — an href sink gets both, never one (#L5)
    const label = appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(txid)
      ? `<a href="${esc(appConfig.explorerTxUrl)}${txid}" target="_blank" rel="noopener" class="mono">${short}</a>`
      : `<span class="mono">${esc(short)}</span>`;
    $('w-rd-out').innerHTML = `Redeemed — tx ${label} The collateral returns to your DGB balance once confirmed.`;
    refreshMoney();
  }));

let moneyTimer = null;
// A self-rescheduling chain, not setInterval (#H1): a tick can now take up to
// the indexer budget, and an interval would stack concurrent generations of the
// heaviest poll in the app on a slow index. A chain cannot overlap itself.
function startMoneyPolling() {
  if (!appConfig.indexer) return;
  clearTimeout(moneyTimer);
  // Which wallet this chain belongs to: without the guard a switch would leave
  // the outgoing wallet's chain polling forever beside the incoming one (#122).
  const gen = walletGen;
  (async function moneyLoop() {
    await refreshMoney(); // never rejects — its try/catch spans the whole body
    if (walletGen !== gen || !wallet.seed) return; // switched or locked: this chain ends
    moneyTimer = setTimeout(moneyLoop, MONEY_POLL_MS);
  })();
}

// The boot card doubles as the fatal-boot surface. A dead boot is not a wait,
// so the clip goes and only the reason stays — a looping animation over a
// wallet that will never open is a lie. (The reason stays inside #w-loading:
// verify-crosswire.mjs reads it off the card.)
function bootStuck(msg) {
  $('w-loading-msg').textContent = msg;
  $('w-loading').querySelector('.loading-clip')?.remove();
}

async function bootWallet() {
  try {
    // 'locked' covers both a v2 vault and a not-yet-migrated v1 record — the
    // unlock path migrates transparently on the first successful password.
    const st = await vault.load();
    // #C2: stamp the tombstone BEFORE show(), so the hero decision is made
    // against the fresh value. A locked vault counts — it is a vault.
    if (st !== 'none') markHadVault(globalThis.localStorage);
    show(st === 'none' ? 'none' : 'locked');
  } catch (e) {
    bootStuck('wallet storage unavailable: ' + e.message);
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
  bootStuck('wallet disabled: the server refuses to serve a mismatched network');
  show('loading');
  return true;
}

/** The explorer prefix is operator config (EXPLORER_TX_URL), but it lands in an
 *  href — including one built by property assignment (showTxSuccess), where no
 *  amount of escaping helps and a `javascript:` value would execute on click
 *  with no CSP involvement. Admit only an absolute http(s) URL and drop anything
 *  else rather than trusting the env var (#L5). NOT encodeURIComponent: the
 *  prefix legitimately contains `://` and `/`. Applied at EVERY point /api/config
 *  is absorbed — boot and the status-loop recovery (#H1) both install a fresh
 *  cfg, so a single boot-time filter would no longer cover it. */
function withSafeExplorer(cfg) {
  const url = String(cfg?.explorerTxUrl ?? '');
  return { ...cfg, explorerTxUrl: /^https?:\/\/[^\s"'<>]+$/.test(url) ? url : '' };
}

/** Chrome that only /api/config can decide. Factored out because it runs twice:
 *  at boot, and again if boot's fetch timed out and the status loop recovered
 *  the config later (#H1) — a wallet stuck on the "loading…" badge with no
 *  faucet button is exactly the silent degradation that fix is about. */
function applyConfigChrome(cfg) {
  const badge = $('modeBadge');
  badge.className = cfg.mock ? 'badge mock' : 'badge real';
  badge.textContent = cfg.mock ? 'MOCK MODE' : 'LIVE NODE';
  if (cfg.faucet) $('w-faucet').style.display = 'block';
  if (cfg.version) $('app-version').textContent = cfg.version; // which build this domain runs
}

// ---- Unconfirmed-broadcast recovery card (#C1) ----
// The card is a SIBLING of every wallet state surface, so show(), lockWallet()
// and resetWalletState() never touch it: a signed transaction whose fate is
// unknown outlives the session it was signed in, and the record needs only the
// hex and the txid — not wallet.seed.
// txid → { line, summary }: the answer the user's last click produced. It has
// to outlive the RECORD, not just the re-render — resolving the ambiguity
// (Check status finds the tx, or a Rebroadcast is accepted) deletes the record,
// and rendering only live records would take the verdict off screen in the same
// frame it was written, leaving a user who clicked "Check status" watching the
// row vanish with no answer at all.
const recoveryStatus = new Map();

/** One row. `rec` is null for a verdict whose record is already gone: nothing
 *  is left to check, rebroadcast or copy, so only the dismiss button remains.
 *
 *  That is also why the dismiss button is labelled twice. On a resolved row it
 *  closes a verdict and "Dismiss" is true. On a LIVE row the same click runs
 *  broadcastLog.drop(), which permanently deletes the signed hex — the only
 *  artifact Rebroadcast and Copy raw transaction can work from, for a
 *  transaction whose fate is by definition still unknown. "Dismiss" there reads
 *  as "close this notice" and names the wrong consequence, so the live row says
 *  what the handler does instead. */
function recoveryRowHtml(txid, title, line, rec) {
  // every interpolation through esc(); the bare data-rec-* values are the
  // txid, regex-validated by the caller, so they cannot carry markup
  const actions = rec
    ? `<button class="secondary" data-rec-check="${txid}">Check status</button>
       <button class="secondary" data-rec-resend="${txid}">Rebroadcast</button>
       <button class="secondary" data-rec-copy="${txid}">Copy raw transaction</button>`
    : '';
  return `
    <div style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px">
      <div class="row"><span class="k">${esc(title)}</span><span class="v mono">${esc(txid.slice(0, 16))}…</span></div>
      <div class="hint">${esc(line)}</div>
      <div class="grid">${actions}
        <button class="secondary" data-rec-dismiss="${txid}">${rec ? 'Delete saved transaction' : 'Dismiss'}</button>
      </div>
    </div>`;
}

/** The card deliberately outlives lock, autolock and wallet switch — but the
 *  summary carries the amount and the counterparty ("1,234.5 DGB to dgb1q…"),
 *  and locking used to take every balance and every address off screen. Behind
 *  the lock the row falls back to the bare kind: still enough to know WHICH
 *  transaction is unresolved and to act on it, without the shoulder-surfable
 *  detail. (The signed hex sits in localStorage either way — this is a
 *  lock-screen regression to close, not a new secret.) */
const recoveryTitle = (r) => (vault.status === 'unlocked' ? (r.summary || r.kind) : r.kind);

function renderRecoveryCard() {
  const card = $('w-recovery');
  // netKnown gate: the record is chain-scoped, and before the node names its
  // chain we cannot say whether a testnet record belongs on screen — nor could
  // Check-status query the right indexer.
  if (!chainState.netKnown) { card.style.display = 'none'; return; }
  const recs = broadcastLog.list().filter((r) => r.chain === chainState.netName && /^[0-9a-f]{64}$/.test(r.txid));
  const live = new Set(recs.map((r) => r.txid));
  const resolved = [...recoveryStatus].filter(([txid]) => !live.has(txid));
  if (!recs.length && !resolved.length) {
    card.style.display = 'none';
    $('w-recovery-list').innerHTML = '';
    return;
  }
  $('w-recovery-list').innerHTML = [
    ...recs.map((r) => recoveryRowHtml(r.txid, recoveryTitle(r), recoveryStatus.get(r.txid)?.line ?? r.lastError ?? '', r)),
    // a verdict captured while unlocked must not put the summary back on screen
    // once the wallet locks, so the resolved row keeps both titles and picks
    ...resolved.map(([txid, s]) => recoveryRowHtml(txid, recoveryTitle(s), s.line, null)),
  ].join('');
  card.style.display = 'block';
}

$('w-recovery-list').addEventListener('click', (e) => {
  const d = e.target?.dataset ?? {};
  const txid = d.recCheck || d.recResend || d.recCopy || d.recDismiss;
  if (!txid) return;
  // Dismiss is the ONLY action a resolved row still offers, so it must work
  // without a record — that is exactly the row whose record is already gone.
  if (d.recDismiss) { broadcastLog.drop(txid); recoveryStatus.delete(txid); renderRecoveryCard(); return; }
  const rec = broadcastLog.get(txid);
  if (!rec) { renderRecoveryCard(); return; } // another tab resolved it
  // both titles, because the verdict outlives the record AND the unlocked
  // session that produced it — renderRecoveryCard picks per lock state
  const note = (line) => recoveryStatus.set(txid, { line, summary: rec.summary, kind: rec.kind });
  if (d.recCopy) {
    // the way out when this deployment's node is the broken hop: the signed
    // bytes are self-contained and any explorer's broadcast form will take them
    navigator.clipboard?.writeText(rec.hex);
    note('Raw transaction copied — you can paste it into a block explorer’s broadcast form.');
    renderRecoveryCard();
    return;
  }
  if (d.recCheck) {
    busy(e.target, 'w-recovery-err', async () => {
      if (!appConfig.indexer) {
        throw new Error('this deployment has no indexer — look the transaction up in a block explorer before doing anything else');
      }
      try {
        const tx = await fetchIndexer(`/tx/${txid}`);
        const c = Number(tx.confirmations) || 0;
        note(c > 0
          ? `Confirmed on chain (${c} confirmation${c === 1 ? '' : 's'}) — it went through.`
          : 'In the mempool, waiting for a block — it WAS broadcast. Do not send it again.');
        // The ambiguity is resolved: the transaction exists. The record goes,
        // the verdict stays on screen until the user dismisses it.
        broadcastLog.drop(txid);
      } catch (err) {
        if (/No such mempool or blockchain transaction|unknown path|HTTP 404/i.test(err.message)) {
          note('The indexer has never seen this transaction — it most likely never reached the network. Rebroadcast is safe.');
        } else {
          throw err; // a real indexer outage answers nothing — keep the record
        }
      }
      renderRecoveryCard();
    });
    return;
  }
  if (d.recResend) {
    busy(e.target, 'w-recovery-err', async () => {
      broadcastLog.bumpAttempt(txid);
      try {
        // The IDENTICAL bytes, never a rebuild: Core re-relays a transaction it
        // already holds, and isAlreadyBroadcast() covers the relays that error
        // instead — so a duplicate send is a no-op, not a second conflicting tx.
        const nodeTxid = await sendAndClassify(rec.hex, txid);
        note(`Accepted by the node — tx ${String(nodeTxid || txid).slice(0, 16)}…`);
        refreshMoney();
      } catch (err) {
        // Deliberately not rethrown. busy() would paint this into
        // #w-recovery-err, which lives INSIDE the card — and a definite reject
        // has just dropped the record, so the card would be hidden by the time
        // the text landed. The row is the surface that is always still there:
        // a verdict when the record is gone, r.lastError when it survived
        // (the ambiguous case, where markAmbiguous already stored the reason).
        if (!broadcastLog.get(txid)) note(err.message);
      }
      renderRecoveryCard();
    });
  }
});

// ---- Boot ----
async function boot() {
  initCalculator();
  // Stablecoin flows (mint/transfer/redeem) are always on, as one unit — the
  // release gate (#17) removed the feature flag per ADR-0002.
  initMintTiers();
  enhanceSelect('send-asset');
  // Reflect the auto-lock choice, and reflect it from the SAME source the timer
  // reads: showing the markup's selected option while autolockDelayMs() had
  // resolved something else is how "5 minutes" stayed on screen for users whose
  // lock never armed. A garbage/stale entry falls back to the real default.
  try {
    const v = localStorage.getItem(AUTOLOCK_KEY);
    const ladder = [...$('w-autolock').options].map((o) => o.value);
    const choice = ladder.includes(v) ? v : String(autolockMinutes(v) ?? AUTOLOCK_DEFAULT_MIN);
    if (ladder.includes(choice)) $('w-autolock').value = choice;
  } catch { /* private mode → default */ }
  enhanceSelect('w-autolock');
  // chain, not setInterval (#H1): loadPriceChart now awaits a budgeted fetch
  (async function chartLoop() {
    await loadPriceChart();
    setTimeout(chartLoop, PRICE_CHART_POLL_MS);
  })();
  try {
    const cfg = await (await apiFetch('/api/config', {
      budget: NET_TIMEOUT_MS.config, what: 'the wallet server',
    })).json();
    appConfig = withSafeExplorer({ ...cfg, loaded: true });
    applyConfigChrome(cfg);
    // Cross-wired backend (#64): the server refuses everything, so no flow
    // can work — say exactly why in the loudest chrome we have and stop.
    if (renderCrossWire(cfg)) return; // no wallet boot, no status/oracle loops
  } catch (e) {
    // Never fatal — the wallet still opens (bootStuck is for a dead vault and
    // for the cross-wire refusal, not for a degraded config). But a swallowed
    // config leaves appConfig.loaded false, which hides #w-no-indexer and makes
    // startMoneyPolling return early: an open wallet with a blank money panel
    // and no stated reason. Say it on the Network card's error line, which
    // loadStatus rebuilds each poll, so this cannot accumulate (#H1).
    $('s-err').textContent = 'config: ' + e.message;
  }
  bootWallet();
  // #C2: READ-ONLY at boot. ensurePersistence() here would fire Firefox's
  // persistent-storage permission prompt on a cold page load with no gesture —
  // user-hostile, and a denial would permanently escalate the backup strip.
  // Not awaited: boot must not block on it.
  probePersistence();
  // retry until the node names its chain: a transient boot failure must not
  // strand the UI network-unknown (no addresses, no testnet banner) forever.
  // The retry also re-checks the cross-wire flag — a page loaded before the
  // server's first chain probe must still lock up once the mismatch is known.
  (async function statusLoop() {
    await loadStatus();
    // Re-fetch /api/config while EITHER answer is still missing: the chain (the
    // cross-wire re-check this loop was written for) or the config itself — a
    // boot whose config fetch timed out leaves a wallet that can never show
    // money, because appConfig.indexer gates startMoneyPolling (#H1).
    if (chainState.netKnown && appConfig.loaded) {
      // The chain is known, but height, softfork state and node reachability
      // all keep moving, and the header presents them as live. Keep polling —
      // slower, since this is no longer the boot retry.
      setTimeout(statusLoop, STATUS_POLL_MS);
      return;
    }
    const cfg = await apiFetch('/api/config', { budget: NET_TIMEOUT_MS.config, what: 'the wallet server' })
      .then((r) => r.json()).catch(() => null);
    if (cfg?.chainMismatch) { appConfig = withSafeExplorer({ ...appConfig, ...cfg }); renderCrossWire(cfg); return; }
    if (cfg && !appConfig.loaded) {
      appConfig = withSafeExplorer({ ...cfg, loaded: true });
      applyConfigChrome(cfg);
      // Only an OPEN wallet renders anything appConfig-gated (#w-no-indexer and
      // the loading veil), and repainting the other states would reset the
      // connect modal under a user who is mid-unlock.
      if (shownState === 'open') {
        show('open');
        // the poll appConfig.indexer refused at openWallet; nothing is running
        // yet (that early return is the only way here), so this starts one chain
        if (wallet.seed) startMoneyPolling();
      }
    } else if (!appConfig.loaded) {
      // loadStatus rebuilds this line every poll, so an un-restated reason
      // vanishes after one tick — append (never accumulate) instead.
      $('s-err').textContent += ($('s-err').textContent ? ' · ' : '')
        + 'config: the wallet server did not answer — balances stay hidden until it does';
    }
    setTimeout(statusLoop, chainState.netKnown ? STATUS_POLL_MS : 5000);
  })();
  // The oracle price was fetched once here and then presented as live for the
  // rest of the session. Everything downstream trusted it: the header figure,
  // the fiat equivalents, the mint estimate, and — worst — usdToSats, the
  // divisor a USD-denominated send is actually built from. The staleness gate
  // that should demote USD entry ran once too, so a quote could go stale and
  // nothing on screen would say so.
  //
  // A self-rescheduling timeout, not setInterval: rpc() uses bare fetch with no
  // timeout, so an interval against a stalled node stacks concurrent calls, and
  // whichever lands last wins — which can install an OLDER price than the one
  // already held. A chain cannot overlap with itself.
  (async function oracleLoop() {
    await loadOracle();
    setTimeout(oracleLoop, ORACLE_POLL_MS);
  })();
  // network health moves with the market — keep the non-binding previews
  // honest mid-session (the review step always re-fetches anyway)
  (async function dcaLoop() {
    await loadDca();
    setTimeout(dcaLoop, DCA_POLL_MS);
  })();
}

boot();
