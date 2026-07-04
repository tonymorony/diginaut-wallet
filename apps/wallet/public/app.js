// DigiDollar wallet — frontend logic.
// Consensus math comes from the digidollar-js protocol library (served at /lib/),
// which mirrors DigiByte Core v9.26.4 exactly — the same code the differential
// harness (M2) will verify against Core.
import { LOCK_TIERS, requiredCollateralSats } from '/lib/index.js';

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
    const st = await rpc('getoraclestatus');
    if (st?.lastPrice) {
      $('o-price').textContent = fmtUSD(st.lastPrice);
      // seed the calculator price with the live oracle price
      const priceInput = $('c-price');
      if (priceInput && !priceInput.dataset.touched) {
        priceInput.value = st.lastPrice;
        $('c-pricesrc').textContent = '(from oracle)';
        recalc();
      }
    }
    $('o-consensus').innerHTML = `<span class="dot ${st.active ? 'good' : 'bad'}"></span>${st.activeOracles}/${st.threshold ? st.activeOracles : '?'} · need ${st.threshold ?? '?'}`;
    $('o-active').textContent = `${st.activeOracles ?? '?'} of 15`;
  } catch (e) {
    $('o-hint').innerHTML = `<span class="err">oracle: ${e.message}</span>`;
  }
  try {
    const list = await rpc('listoracles');
    if (Array.isArray(list)) {
      $('o-grid').innerHTML = list
        .map((o, i) => {
          const ok = o.active !== false;
          const bg = ok ? 'rgba(22,199,154,.18)' : 'rgba(255,92,114,.18)';
          const col = ok ? 'var(--good)' : 'var(--bad)';
          return `<div class="oracle" style="background:${bg};color:${col}" title="${o.pubkey || ''} reliability ${o.reliability ?? '?'}">${o.id ?? i + 1}</div>`;
        })
        .join('');
    }
  } catch { /* grid is optional */ }
}

// mark price as user-touched so the oracle doesn't overwrite it
$('c-price').addEventListener('input', () => { $('c-price').dataset.touched = '1'; $('c-pricesrc').textContent = ''; });

// ---- Address generation ----
$('genBtn').addEventListener('click', async () => {
  const btn = $('genBtn');
  $('addrErr').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const addr = await rpc('getnewdigidollaraddress');
    const out = $('addrOut');
    out.style.display = 'block';
    out.textContent = typeof addr === 'string' ? addr : JSON.stringify(addr);
  } catch (e) {
    $('addrErr').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate testnet address';
  }
});

// ---- Boot ----
async function boot() {
  initCalculator();
  try {
    const cfg = await (await fetch('/api/config')).json();
    const badge = $('modeBadge');
    if (cfg.mock) {
      badge.className = 'badge mock';
      badge.textContent = 'MOCK MODE';
    } else {
      badge.className = 'badge real';
      badge.textContent = 'LIVE NODE';
    }
  } catch { /* ignore */ }
  loadStatus();
  loadOracle();
}

boot();
