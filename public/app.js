// DigiDollar Testnet UI — frontend logic.

// Real lock tiers from the DigiDollar Implementation Spec v5.0 (Taproot Enhanced).
// label → { days, ratio } where ratio is required collateral as a fraction (3.0 = 300%).
const TIERS = [
  { label: '30 days', days: 30, ratio: 3.0 },
  { label: '3 months', days: 90, ratio: 2.5 },
  { label: '6 months', days: 180, ratio: 2.0 },
  { label: '1 year', days: 365, ratio: 1.75 },
  { label: '3 years', days: 1095, ratio: 1.5 },
  { label: '5 years', days: 1825, ratio: 1.25 },
  { label: '10 years', days: 3650, ratio: 1.0 },
];

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

// ---- Mint calculator (pure client-side) ----
function tierFor() {
  return TIERS[Number($('c-tier').value)] || TIERS[0];
}
function recalc() {
  const amount = Math.max(0, Number($('c-amount').value) || 0);
  const price = Math.max(0, Number($('c-price').value) || 0);
  const tier = tierFor();
  const collUsd = amount * tier.ratio;
  const collDgb = price > 0 ? collUsd / price : 0;
  $('r-ratio').textContent = (tier.ratio * 100).toFixed(0) + '%';
  $('r-usd').textContent = fmtUSD(collUsd);
  $('r-dgb').textContent = price > 0 ? fmtDGB(collDgb) : '—';
}

function initCalculator() {
  const sel = $('c-tier');
  sel.innerHTML = TIERS.map((t, i) => `<option value="${i}">${t.label} — ${(t.ratio * 100).toFixed(0)}% collateral</option>`).join('');
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
