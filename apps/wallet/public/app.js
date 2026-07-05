// DigiDollar wallet — frontend logic.
// Consensus math comes from the digidollar-js protocol library (served at /lib/),
// which mirrors DigiByte Core v9.26.4 exactly — the same code the differential
// harness (M2) will verify against Core.
import {
  LOCK_TIERS, requiredCollateralSats,
  generateMnemonic, validateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS,
  planSpend, buildSignedSpendTx, decodeWitnessAddress, scriptPubKeyFromAddress,
  buildSignedMintTx, MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS,
  buildSignedTransferTx, buildSignedRedeemTx, DD_TX_LIMITS,
} from '/lib/index.js';
import { encryptMnemonic, decryptMnemonic, saveKeystore, loadKeystore, deleteKeystore } from '/keystore.js';

const $ = (id) => document.getElementById(id);

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

// ---- Mint calculator (pure client-side, exact Core arithmetic via digidollar-js) ----
function tierFor() {
  return LOCK_TIERS.find((t) => t.id === $('c-tier').value) || LOCK_TIERS[0];
}
function recalc() {
  const amount = Math.max(0, Number($('c-amount').value) || 0);
  const price = Math.max(0, Number($('c-price').value) || 0);
  const tier = tierFor();
  $('r-ratio').textContent = tier.ratioPercent + '%';
  $('r-usd').textContent = fmtUSD((amount * tier.ratioPercent) / 100);
  try {
    const sats = requiredCollateralSats({
      ddCents: BigInt(Math.round(amount * 100)),
      tierId: tier.id,
      oraclePriceMicroUsd: BigInt(Math.round(price * 1_000_000)),
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
  return `<span class="dot ${cls}"></span>${active ? textActive : textInactive}`;
}

// header dot = aggregate of softfork state + oracle freshness
const netHealth = { dd: null, oracle: null };
function renderNetDot() {
  const bad = netHealth.dd === false || netHealth.oracle === false;
  const ok = netHealth.dd === true && netHealth.oracle === true;
  $('net-dot').className = 'dot ' + (bad ? 'bad' : ok ? 'good' : 'warn');
}

async function loadStatus() {
  try {
    const info = await rpc('getblockchaininfo');
    $('s-chain').textContent = info.chain;
    $('s-height').textContent = Number(info.blocks).toLocaleString('en-US');
    // derive receive addresses for the chain the node is actually on
    const net = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain];
    if (net) {
      chainState.netName = net; // consensus DD limits are per-network
      wallet.network = HD_NETWORKS[net];
      if (wallet.seed) renderAddress();
    }
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
    $('o-hint').innerHTML = `<span class="err">oracle: ${e.message}</span>`;
  }
  renderNetDot();
  try {
    const list = await rpc('getoracles');
    if (Array.isArray(list) && list.length) {
      const { active_oracle_count: active, total_oracle_slots: slots, consensus_threshold: need } = list[0];
      const ok = active >= need;
      $('o-consensus').innerHTML = `<span class="dot ${ok ? 'good' : 'bad'}"></span>${active}/${slots} · need ${need}`;
      $('o-active').textContent = `${active} of ${slots}`;
      $('o-grid').innerHTML = list
        .map((o, i) => {
          const on = o.is_active !== false;
          const bg = on ? 'var(--good-bg)' : 'var(--bad-bg)';
          const col = on ? 'var(--good)' : 'var(--bad)';
          return `<div class="oracle" style="background:${bg};color:${col}" title="${o.name ?? ''} ${o.pubkey ?? ''}">${o.oracle_id ?? i}</div>`;
        })
        .join('');
    }
  } catch { /* grid is optional */ }
}

// mark price as user-touched so the oracle doesn't overwrite it
$('c-price').addEventListener('input', () => { $('c-price').dataset.touched = '1'; $('c-pricesrc').textContent = ''; });

// ---- Wallet (non-custodial: mnemonic + keys never leave this page) ----
let appConfig = { mock: true, faucet: false, indexer: false };
const chainState = { ddActive: null, netName: 'testnet' }; // refined from the node's chain
const wallet = {
  mnemonic: null, // set only while unlocked
  seed: null,
  index: 0,
  network: HD_NETWORKS.testnet, // refined from the node's `chain` once known
};

function show(state) {
  for (const s of ['loading', 'none', 'locked', 'open']) {
    $('w-' + s).style.display = s === state ? (s === 'open' ? 'grid' : 'block') : 'none';
  }
  // EVM-style corner control: Connect when idle, address chip when connected
  const open = state === 'open';
  $('hero-guest').style.display = state === 'none' || state === 'locked' ? 'block' : 'none';
  $('w-connect').style.display = open || state === 'loading' ? 'none' : 'inline-block';
  $('w-chip').style.display = open ? 'inline-flex' : 'none';
  $('wallet-open-card').style.display = open ? 'grid' : 'none';
  $('net-wallet-sec').style.display = open ? 'block' : 'none'; // seed/lock need an unlocked wallet
  if (open) {
    if (freshMnemonicBackup) showBackupView(); else closeConnectModal();
  } else {
    $('w-backup-view').style.display = 'none';
    $('w-backup-words').textContent = ''; // never leave a seed in the DOM
    document.querySelector('#w-connect-modal .modal-head h3').textContent = 'Connect wallet';
    // action modals must not survive a lock/disconnect
    for (const id of ['send-modal', 'receive-modal', 'mint-modal']) $(id).classList.remove('open');
  }
  dockPriceBlock(open);
  // loading veil covers the gap between unlock and the first indexer answer
  $('loading-veil').style.display =
    open && appConfig.indexer && $('w-money').style.display === 'none' ? 'block' : 'none';
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
  $('price-card').style.display = docked ? 'none' : 'block';
}

let freshMnemonicBackup = null; // set right after creating a NEW wallet, shown once

function connectFormMode(mode) { // 'choice' | 'create' | 'restore'
  // A failed create leaves a discarded mnemonic here; switching mode (e.g. to
  // restore) must drop it or the backup view would show the wrong seed.
  freshMnemonicBackup = null;
  $('w-choice').style.display = mode === 'choice' ? 'block' : 'none';
  $('w-form').style.display = mode === 'choice' ? 'none' : 'block';
  $('w-restore').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-create').style.display = mode === 'restore' ? 'none' : 'block';
  $('w-restore-go').style.display = mode === 'restore' ? 'block' : 'none';
  $('w-none-err').textContent = '';
}
function showBackupView() {
  for (const id of ['w-choice', 'w-form']) $(id).style.display = 'none';
  $('w-none').style.display = 'none';
  document.querySelector('#w-connect-modal .modal-head h3').textContent = 'Back up your seed phrase';
  $('w-backup-view').style.display = 'block';
  $('w-backup-words').textContent = freshMnemonicBackup;
  $('w-connect-modal').classList.add('open');
}
function openConnectModal() {
  connectFormMode('choice');
  document.querySelector('#w-connect-modal .modal-head h3').textContent = 'Connect wallet';
  $('w-connect-modal').classList.add('open');
}
function closeConnectModal() {
  $('w-connect-modal').classList.remove('open');
  $('w-backup-words').textContent = ''; // never leave the seed in the DOM
  freshMnemonicBackup = null;
  // the backup view retitles the modal; don't let that leak into the next open
  document.querySelector('#w-connect-modal .modal-head h3').textContent = 'Connect wallet';
}

// ---- v3 action modals: Send / Receive / Mint / Network ----
const openModal = (id) => $(id).classList.add('open');
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-backdrop').classList.remove('open')));
for (const id of ['send-modal', 'receive-modal', 'mint-modal', 'net-modal']) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.remove('open'); });
}
$('act-send').addEventListener('click', () => openModal('send-modal'));
$('act-receive').addEventListener('click', () => openModal('receive-modal'));
$('act-mint').addEventListener('click', () => { openModal('mint-modal'); updateMintEstimate(); });
$('dd-mint-open').addEventListener('click', () => { openModal('mint-modal'); updateMintEstimate(); });
$('net-btn').addEventListener('click', () => openModal('net-modal'));
$('hero-connect').addEventListener('click', () => openConnectModal());
// the asset dropdown decides which send form shows — via classes on the modal,
// never inline styles on w-send/w-transfer (drivers read their inline display)
$('send-asset').addEventListener('change', () => {
  const dgb = $('send-asset').value === 'dgb';
  $('send-modal').classList.toggle('asset-dgb', dgb);
  $('send-modal').classList.toggle('asset-dd', !dgb);
});
$('w-create-choice').addEventListener('click', () => { connectFormMode('create'); $('w-create-pass').focus(); });
$('w-form-back').addEventListener('click', () => connectFormMode('choice'));
$('w-backup-done').addEventListener('click', closeConnectModal);
$('w-connect').addEventListener('click', openConnectModal);
$('w-modal-close').addEventListener('click', closeConnectModal);
$('w-connect-modal').addEventListener('click', (e) => { if (e.target === $('w-connect-modal')) closeConnectModal(); });
$('w-disconnect').addEventListener('click', () => lockWallet());

function renderAddress() {
  const { path, address } = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
  $('w-path').textContent = path;
  $('w-address').textContent = address;
  $('w-chip-addr').textContent = address.slice(0, 10) + '…' + address.slice(-4);
}

function openWallet(mnemonic) {
  wallet.mnemonic = mnemonic;
  wallet.seed = mnemonicToSeed(mnemonic);
  wallet.index = 0;
  renderAddress();
  $('w-seed').style.display = 'none';
  $('w-open-err').textContent = '';
  show('open');
  startMoneyPolling();
}

function lockWallet() {
  wallet.mnemonic = null;
  wallet.seed = null;
  resetSend(); // pendingSend holds per-UTXO private keys — drop them with the seed
  resetMint(); // pendingMint holds the funding UTXO's private key — same
  resetTransfer(); // pendingTransfer holds DD + fee UTXO keys — same
  resetRedeem(); // pendingRedeem holds burn + fee UTXO keys — same
  $('w-send-out').textContent = '';
  $('w-mint-out').textContent = '';
  $('w-tr-out').textContent = '';
  $('w-rd-out').textContent = '';
  clearInterval(moneyTimer);
  $('w-money').style.display = 'none';
  $('w-seed-words').textContent = '';
  $('w-unlock-pass').value = '';
  $('w-locked-err').textContent = '';
  show('locked');
}

async function createOrRestore(mnemonic) {
  const pass = $('w-create-pass').value;
  if (pass.length < 8) throw new Error('password must be at least 8 characters');
  if (pass !== $('w-create-pass2').value) throw new Error('passwords do not match');
  await saveKeystore(await encryptMnemonic(mnemonic, pass));
  openWallet(mnemonic);
}

async function busy(btn, errId, fn) {
  const el = $(errId);
  el.textContent = '';
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    el.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

$('w-create').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', () => {
    const mnemonic = generateMnemonic();
    freshMnemonicBackup = mnemonic; // shown once in the backup view, then wiped
    return createOrRestore(mnemonic);
  }));

$('w-show-restore').addEventListener('click', () => { connectFormMode('restore'); $('w-restore-seed').focus(); });

$('w-restore-go').addEventListener('click', (e) =>
  busy(e.target, 'w-none-err', async () => {
    const words = $('w-restore-seed').value.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(words)) throw new Error('not a valid BIP39 seed phrase (check the words and their order)');
    await createOrRestore(words);
  }));

$('w-unlock').addEventListener('click', (e) =>
  busy(e.target, 'w-locked-err', async () => {
    const blob = await loadKeystore();
    let mnemonic;
    try {
      mnemonic = await decryptMnemonic(blob, $('w-unlock-pass').value);
    } catch {
      throw new Error('wrong password');
    }
    openWallet(mnemonic);
  }));
$('w-unlock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('w-unlock').click(); });

$('w-forget').addEventListener('click', async (e) => {
  e.preventDefault();
  await deleteKeystore();
  show('none');
});

$('w-lock').addEventListener('click', lockWallet);
$('w-next').addEventListener('click', () => { wallet.index += 1; renderAddress(); refreshMoney(); });
$('w-copy').addEventListener('click', async (e) =>
  busy(e.target, 'w-open-err', () => navigator.clipboard.writeText($('w-address').textContent)));
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

$('w-backup').addEventListener('click', () => {
  const box = $('w-seed');
  const showing = box.style.display !== 'none';
  box.style.display = showing ? 'none' : 'block';
  $('w-seed-words').textContent = showing ? '' : wallet.mnemonic;
  $('w-backup').textContent = showing ? 'Show seed phrase' : 'Hide seed phrase';
});

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
      : `<button class="secondary" data-redeem="${p.txid}" style="width:auto;padding:1px 10px;margin:0">Redeem</button>`;
    return `<div>${fmtUSD(Number(p.ddCents) / 100)} · ${p.tierLabel} · ` +
      `locked ${fmtSats(BigInt(p.collateralSats))} DGB · ${state}</div>`;
  }).join('');
}

async function refreshMoney() {
  if (!wallet.seed || !appConfig.indexer) return;
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

    const receivedByTx = {};
    for (const u of utxos) receivedByTx[u.txid] = (receivedByTx[u.txid] ?? 0) + Number(u.valueSats);
    const seen = new Set();
    const entries = perAddr.flatMap((r) => r.history)
      .filter((h) => (seen.has(h.txid) ? false : seen.add(h.txid)))
      .sort((a, b) => (a.height === 0 ? Infinity : a.height) < (b.height === 0 ? Infinity : b.height) ? 1 : -1)
      .slice(0, 8);
    $('w-history').innerHTML = entries.map((h) => {
      const status = h.height === 0
        ? '<span class="warn-text">pending</span>'
        : `<span style="color:var(--good)">confirmed</span>`;
      const amt = receivedByTx[h.txid] ? ` · +${fmtSats(receivedByTx[h.txid])} DGB` : '';
      // txids link out to the configured block explorer (EXPLORER_TX_URL)
      const short = h.txid.slice(0, 12) + '…';
      const label = appConfig.explorerTxUrl && /^[0-9a-f]{64}$/.test(h.txid)
        ? `<a href="${appConfig.explorerTxUrl}${h.txid}" target="_blank" rel="noopener">${short}</a>`
        : short;
      return `<div class="mono">${label} ${status}${amt}</div>`;
    }).join('') || 'No transactions yet.';
    const ddCents = perAddr.reduce((s, r) => s + r.ddCents, 0n);
    $('w-dd-balance').textContent = (Number(ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    renderPositions(perAddr);
    // a transient indexer hiccup shouldn't leave a stale error after recovery
    if ($('w-open-err').textContent.startsWith('indexer:')) $('w-open-err').textContent = '';
    const firstShow = $('w-money').style.display === 'none';
    $('loading-veil').style.display = 'none';
    $('w-money').style.display = 'grid';
    if (firstShow) renderSparkline(lastPriceSeries); // real width only now
  } catch (e) {
    $('loading-veil').style.display = 'none';
    $('w-open-err').textContent = 'indexer: ' + e.message;
  }
}

// fiat equivalents (hero + asset row) from the latest oracle price
let lastConfirmedDgb = null;
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
    const sats = requiredCollateralSats({ ddCents: cents, tierId: tier.id, oraclePriceMicroUsd: lastPriceMicroUsd });
    el.textContent = `≈ ${fmtSats(sats)} DGB collateral (${tier.ratioPercent}% · ${tier.label} lock)`;
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
      txidHex: u.txid, vout: u.vout, valueSats: BigInt(u.valueSats), privKeyHex, ...(type && { type }),
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

$('w-send-review').addEventListener('click', (e) =>
  busy(e.target, 'w-send-err', async () => {
    $('w-send-out').textContent = '';
    const address = $('w-send-to').value.trim();
    const { hrp } = decodeWitnessAddress(address); // throws on malformed input
    if (hrp !== wallet.network.hrp) throw new Error(`address is not for this network (expected ${wallet.network.hrp}…)`);
    const amountSats = dgbToSats($('w-send-amount').value);
    if (amountSats <= 0n) throw new Error('amount must be positive');
    const plan = planSpend({ utxos: await spendableUtxos(), amountSats });
    pendingSend = { plan, recipientScriptHex: scriptPubKeyFromAddress(address), amountSats, address };
    $('w-send-c-to').textContent = address;
    $('w-send-c-amount').textContent = satsToDgb(amountSats);
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
    const txid = await rpc('sendrawtransaction', [hex]);
    resetSend();
    $('w-send-to').value = '';
    $('w-send-amount').value = '';
    $('w-send-out').textContent = `Sent — tx ${txid.slice(0, 16)}…`;
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
    $('tier-ratio').textContent = tier.ratioPercent + '% collateral';
    const p = (i / (LOCK_TIERS.length - 1)) * 100;
    slider.style.background = `linear-gradient(90deg, var(--accent) ${p}%, var(--gray-200) ${p}%)`;
  };
  slider.addEventListener('input', () => {
    $('w-mint-tier').value = LOCK_TIERS[Number(slider.value)].id;
    $('w-mint-tier').dispatchEvent(new Event('change', { bubbles: true }));
  });
  $('w-mint-tier').addEventListener('change', syncFromSelect);
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
    const tierId = $('w-mint-tier').value;
    const tier = LOCK_TIERS.find((t) => t.id === tierId);
    // 2. oracle gate — a stale quote would be rejected by mempool policy anyway
    const price = await rpc('getoracleprice');
    if (!price?.price_micro_usd) throw new Error('oracle price unavailable — the node returned no quote');
    if (price.is_stale) {
      throw new Error('the oracle price is stale — the network has not published a fresh quote; try again in a few minutes');
    }
    const priceMicroUsd = BigInt(price.price_micro_usd);
    const collateralSats = requiredCollateralSats({ ddCents, tierId, oraclePriceMicroUsd: priceMicroUsd });
    const needSats = collateralSats + MINT_FEE_SATS;
    // 3. funding gate — the mint spends ONE UTXO, so it must cover everything.
    // Only P2TR coins qualify: buildSignedMintTx signs key-path taproot (a
    // p2wpkh coin — earlier mint change — is consolidated via Send first).
    const utxos = await spendableUtxos();
    const totalSats = utxos.reduce((s, u) => s + u.valueSats, 0n);
    const utxo = utxos.filter((u) => u.type !== 'p2wpkh' && u.valueSats >= needSats)
      .sort((a, b) => (a.valueSats < b.valueSats ? -1 : 1))[0];
    if (!utxo) {
      throw new Error(totalSats >= needSats
        ? `your balance covers it, but no single coin is large enough (a mint spends one coin). Send ${fmtSats(needSats)} DGB to your own address to consolidate, then retry.`
        : `insufficient funds: this mint needs ${fmtSats(needSats)} DGB (collateral + fee), you have ${fmtSats(totalSats)} DGB`);
    }
    const { blocks: tipHeight } = await rpc('getblockchaininfo');
    const unlockHeight = tipHeight + 1 + MINT_LOCK_CONFIRMATION_BUFFER_BLOCKS + tier.lockBlocks;
    pendingMint = { utxo, ddCents, tierId, priceMicroUsd };
    $('w-mint-c-dd').textContent = (Number(ddCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    $('w-mint-c-coll').textContent = fmtSats(collateralSats);
    $('w-mint-c-price').textContent = '$' + (Number(priceMicroUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 5 }) + ' / DGB';
    $('w-mint-c-fee').textContent = fmtSats(MINT_FEE_SATS);
    $('w-mint-c-unlock').textContent = `≈ ${blocksToDate(unlockHeight - tipHeight)} (block ${unlockHeight.toLocaleString('en-US')})`;
    $('w-mint-confirm').style.display = 'block';
    $('w-mint-review').disabled = true;
  }));

$('w-mint-cancel').addEventListener('click', resetMint);

$('w-mint-go').addEventListener('click', (e) =>
  busy(e.target, 'w-mint-err', async () => {
    const { utxo, ddCents, tierId, priceMicroUsd } = pendingMint;
    if (!wallet.seed) throw new Error('wallet is locked');
    const { blocks: tipHeight } = await rpc('getblockchaininfo'); // fresh height at sign time
    const { hex } = buildSignedMintTx({
      utxo,
      privKeyHex: utxo.privKeyHex,
      ddCents,
      tierId,
      oraclePriceMicroUsd: priceMicroUsd,
      tipHeight,
      feeSats: MINT_FEE_SATS,
    });
    const txid = await rpc('sendrawtransaction', [hex]);
    resetMint();
    $('w-mint-amount').value = '';
    $('w-mint-out').textContent = `Minted — tx ${txid.slice(0, 16)}… The position appears below once confirmed.`;
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
    // recipient must be a taproot (witness v1) address on this network —
    // a DigiDollar address IS the recipient's key-path P2TR
    const address = $('w-tr-to').value.trim();
    let decoded;
    try {
      decoded = decodeWitnessAddress(address);
    } catch (err) {
      throw new Error(`invalid address: ${err.message}`);
    }
    if (decoded.hrp !== wallet.network.hrp) throw new Error(`address is not for this network (expected ${wallet.network.hrp}…)`);
    if (decoded.version !== 1 || decoded.programHex.length !== 64) {
      throw new Error('not a DigiDollar-capable address — DigiDollar goes to taproot addresses (…1p…), this one is a different type');
    }
    const cents = ddToCents($('w-tr-amount').value);
    if (cents <= 0n) throw new Error('amount must be positive');
    const trLimits = DD_TX_LIMITS[chainState.netName];
    if (cents < trLimits.minOutputCents) {
      throw new Error(`consensus forbids DigiDollar outputs below $${(Number(trLimits.minOutputCents) / 100).toFixed(2)} — send at least that`);
    }
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
      throw new Error(`no DGB for the fee on the address holding this DigiDollar — send at least ${fmtSats(TRANSFER_FEE_SATS)} DGB to ${ddUtxo.address}, then retry`);
    }
    pendingTransfer = { ddUtxo, feeUtxo, cents, outputKeyHex: decoded.programHex, address };
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
    const txid = await rpc('sendrawtransaction', [hex]);
    resetTransfer();
    $('w-tr-to').value = '';
    $('w-tr-amount').value = '';
    $('w-tr-out').textContent = `Transferred — tx ${txid.slice(0, 16)}…`;
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
      throw new Error(`no DGB for the fee on the position's address — send at least ${fmtSats(REDEEM_FEE_SATS)} DGB to ${p.address}, then retry`);
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
    const txid = await rpc('sendrawtransaction', [hex]);
    resetRedeem();
    $('w-rd-out').textContent = `Redeemed — tx ${txid.slice(0, 16)}… The collateral returns to your DGB balance once confirmed.`;
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
    const blob = await loadKeystore();
    show(blob ? 'locked' : 'none');
  } catch (e) {
    $('w-loading').textContent = 'wallet storage unavailable: ' + e.message;
  }
}

// ---- Boot ----
async function boot() {
  initCalculator();
  // Stablecoin flows (mint/transfer/redeem) are always on, as one unit — the
  // release gate (#17) removed the feature flag per ADR-0002.
  initMintTiers();
  enhanceSelect('send-asset');
  loadPriceChart();
  setInterval(loadPriceChart, 60_000);
  try {
    const cfg = await (await fetch('/api/config')).json();
    appConfig = cfg;
    const badge = $('modeBadge');
    if (cfg.mock) {
      badge.className = 'badge mock';
      badge.textContent = 'MOCK MODE';
    } else {
      badge.className = 'badge real';
      badge.textContent = 'LIVE NODE';
    }
    if (cfg.faucet) $('w-faucet').style.display = 'block';
  } catch { /* ignore */ }
  bootWallet();
  loadStatus();
  loadOracle();
}

boot();
