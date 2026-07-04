// DigiDollar wallet — frontend logic.
// Consensus math comes from the digidollar-js protocol library (served at /lib/),
// which mirrors DigiByte Core v9.26.4 exactly — the same code the differential
// harness (M2) will verify against Core.
import {
  LOCK_TIERS, requiredCollateralSats,
  generateMnemonic, validateMnemonic, mnemonicToSeed, deriveTaprootAddress, HD_NETWORKS,
  planSpend, buildSignedSpendTx, decodeWitnessAddress, scriptPubKeyFromAddress,
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
  recalc();
}

// ---- Status ----
function statusLine(active, textActive, textInactive) {
  const cls = active ? 'good' : 'warn';
  return `<span class="dot ${cls}"></span>${active ? textActive : textInactive}`;
}

async function loadStatus() {
  try {
    const info = await rpc('getblockchaininfo');
    $('s-chain').textContent = info.chain;
    $('s-height').textContent = Number(info.blocks).toLocaleString('en-US');
    // derive receive addresses for the chain the node is actually on
    const net = { main: 'mainnet', test: 'testnet', regtest: 'regtest' }[info.chain];
    if (net) {
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
    $('s-dd').innerHTML = statusLine(ddActive, 'active', dd?.bip9?.status || 'not active');
    $('s-tr').innerHTML = statusLine(tr?.active === true, 'active', tr?.bip9?.status || 'not active');
  } catch (e) {
    $('s-err').textContent += (e ? ' · deployment: ' + e.message : '');
  }
}

async function loadOracle() {
  try {
    const price = await rpc('getoracleprice');
    if (price?.price_usd) {
      // sub-cent DGB prices need more than fmtUSD's 2 decimals
      $('o-price').textContent = '$' + price.price_usd.toLocaleString('en-US', { maximumFractionDigits: 5 }) + (price.is_stale ? ' (stale)' : '');
      // seed the calculator price with the live oracle price
      const priceInput = $('c-price');
      if (priceInput && !priceInput.dataset.touched) {
        priceInput.value = price.price_usd;
        $('c-pricesrc').textContent = '(from oracle)';
        recalc();
      }
    }
  } catch (e) {
    $('o-hint').innerHTML = `<span class="err">oracle: ${e.message}</span>`;
  }
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
          const bg = on ? 'rgba(22,199,154,.18)' : 'rgba(255,92,114,.18)';
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
const wallet = {
  mnemonic: null, // set only while unlocked
  seed: null,
  index: 0,
  network: HD_NETWORKS.testnet, // refined from the node's `chain` once known
};

function show(state) {
  for (const s of ['loading', 'none', 'locked', 'open']) {
    $('w-' + s).style.display = s === state ? 'block' : 'none';
  }
}

function renderAddress() {
  const { path, address } = deriveTaprootAddress(wallet.seed, { ...wallet.network, index: wallet.index });
  $('w-path').textContent = path;
  $('w-address').textContent = address;
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
  $('w-send-out').textContent = '';
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
  busy(e.target, 'w-none-err', () => createOrRestore(generateMnemonic())));

$('w-show-restore').addEventListener('click', () => {
  const box = $('w-restore');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
});

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

/** Addresses the wallet watches: every derived index up to the current one, +2 lookahead. */
function watchedAddresses() {
  return Array.from({ length: wallet.index + 3 }, (_, i) =>
    deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }).address);
}

// DigiDollar positions (#13): locked mints are NOT part of the DGB balance —
// they render as their own list ($ amount, tier, collateral, expiry date).
const SECONDS_PER_BLOCK = 15;
function renderPositions(perAddr) {
  const seen = new Set();
  const positions = perAddr.flatMap((r) => r.positions.positions)
    .filter((p) => (seen.has(p.txid) ? false : seen.add(p.txid)));
  const tipHeight = Math.max(0, ...perAddr.map((r) => r.positions.tipHeight));
  const totalCents = positions.reduce((n, p) => n + Number(p.ddCents), 0);
  $('w-dd-total').textContent = positions.length ? fmtUSD(totalCents / 100) : '';
  if (!positions.length) {
    $('w-positions').textContent = 'No open positions.';
    return;
  }
  $('w-positions').innerHTML = positions.map((p) => {
    const blocksLeft = p.unlockHeight - tipHeight;
    const unlock = blocksLeft <= 0
      ? '<span style="color:var(--good)">unlockable now</span>'
      : `unlocks ≈ ${new Date(Date.now() + blocksLeft * SECONDS_PER_BLOCK * 1000).toLocaleDateString('en-CA')} (block ${p.unlockHeight.toLocaleString('en-US')})`;
    return `<div>${fmtUSD(Number(p.ddCents) / 100)} · ${p.tierLabel} · ` +
      `locked ${fmtSats(BigInt(p.collateralSats))} DGB · ${unlock}</div>`;
  }).join('');
}

async function refreshMoney() {
  if (!wallet.seed || !appConfig.indexer) return;
  try {
    const addrs = watchedAddresses();
    const perAddr = await Promise.all(addrs.map(async (a) => ({
      utxos: (await fetchIndexer(`/address/${a}/utxos`)).utxos,
      history: (await fetchIndexer(`/address/${a}/history`)).history,
      positions: await fetchIndexer(`/address/${a}/positions`),
    })));
    if (!wallet.seed) return; // locked while we were fetching
    const utxos = perAddr.flatMap((r) => r.utxos);
    const confirmed = utxos.filter((u) => u.height > 0).reduce((n, u) => n + Number(u.valueSats), 0);
    const pending = utxos.filter((u) => u.height === 0).reduce((n, u) => n + Number(u.valueSats), 0);
    $('w-balance').textContent = fmtDGB(confirmed / 1e8);
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
      return `<div class="mono">${h.txid.slice(0, 12)}… ${status}${amt}</div>`;
    }).join('') || 'No transactions yet.';
    renderPositions(perAddr);
    $('w-money').style.display = 'block';
  } catch (e) {
    $('w-open-err').textContent = 'indexer: ' + e.message;
  }
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

/** Every watched derivation (address + its key), spendable UTXOs attached. */
async function spendableUtxos() {
  const derived = Array.from({ length: wallet.index + 3 }, (_, i) =>
    deriveTaprootAddress(wallet.seed, { ...wallet.network, index: i }));
  const perAddr = await Promise.all(derived.map(async (d) => {
    const { utxos } = await fetchIndexer(`/address/${d.address}/utxos`);
    return utxos.map((u) => ({
      txidHex: u.txid, vout: u.vout, valueSats: BigInt(u.valueSats), privKeyHex: d.privKeyHex,
    }));
  }));
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
