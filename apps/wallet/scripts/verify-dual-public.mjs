// Dual-stack public smoke (#64): both domains up, each on its OWN network,
// mainnet faucet-free, nothing cross-wired. Zero-dep; run post-deploy:
//   node apps/wallet/scripts/verify-dual-public.mjs \
//     https://testnet.diginaut.space https://diginaut.space
// Then run it a SECOND time against the legacy pair — those hosts are served by
// the same containers but are separate Caddy sites with their own certificates,
// and they are never redirected (ADR 0006), so a cert or vhost that broke on
// cutover is invisible from the canonical pair alone:
//   node apps/wallet/scripts/verify-dual-public.mjs \
//     https://dgb.ludere.space https://diginaut.ludere.space
// Exit 0 = all green. Pre-DD-activation the mainnet price series may be
// legitimately empty (getoracleprice inactive) — that is not a failure.
const [testnetBase, mainnetBase] = process.argv.slice(2);
if (!testnetBase || !mainnetBase) {
  console.error('usage: verify-dual-public.mjs <testnet-url> <mainnet-url>');
  process.exit(2);
}

let step = 0;
let failed = false;
const check = (cond, what) => {
  step++;
  console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`);
  if (!cond) failed = true;
};
const getJson = async (base, path) => {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rpc = (base, method) =>
  fetch(base + '/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: [] }),
    signal: AbortSignal.timeout(20_000),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function checkSide(base, { label, chain, faucet }) {
  console.log(`\n— ${label}: ${base}`);
  const cfg = await getJson(base, '/api/config');
  check(cfg.status === 200, `/api/config answers`);
  check(cfg.body?.mock === false, `live node (not mock)`);
  check(cfg.body?.chainMismatch === false, `no cross-wire flag`);
  check(cfg.body?.expectedChain === chain, `expected chain pinned to "${chain}" (got ${cfg.body?.expectedChain})`);
  check(cfg.body?.chain === chain, `node reports chain "${chain}" (got ${cfg.body?.chain})`);
  check(cfg.body?.faucet === faucet, faucet ? 'faucet present (testnet)' : 'NO faucet (mainnet)');
  check(cfg.body?.indexer === true, 'indexer wired');

  const info = await rpc(base, 'getblockchaininfo');
  check(info.status === 200 && info.body?.result?.chain === chain,
    `rpc proxy serves getblockchaininfo on "${chain}" (height ${info.body?.result?.blocks ?? '?'})`);

  // exercise the wallet→indexer→ElectrumX chain, not just the config flag.
  // The probe txid doesn't exist, so a healthy trio answers 404 `tx-not-found`:
  // the request went wallet→indexer→ElectrumX→node and came back. `upstream-error`
  // also proves the chain is wired (the backend answered, e.g. a warming
  // daemon); a `*-unreachable` cause means a link in the trio is down. Read
  // `cause` first — the servers no longer relay upstream text, so their copy
  // carries no verdict; `error` is the fallback for a server predating the token.
  const idx = await getJson(base, `/api/indexer/tx/${'0'.repeat(64)}`);
  const idxErr = String(idx.body?.cause ?? idx.body?.error ?? '');
  const answered = idx.status < 500 || /daemon error|no such|not found|upstream-error/i.test(idxErr);
  check(answered && !/econnrefused|etimedout|unreachable|socket/i.test(idxErr),
    `indexer chain answers (status ${idx.status}${idxErr ? `, ${idxErr.slice(0, 60)}` : ''})`);

  if (!faucet) {
    // the mainnet side must refuse a claim outright, not merely hide the button
    const claim = await fetch(base + '/api/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'probe' }),
      signal: AbortSignal.timeout(20_000),
    });
    check(claim.status === 503, `faucet claim refused with 503 (got ${claim.status})`);
  }

  const hist = await getJson(base, '/api/price-history');
  check(hist.status === 200 && hist.body?.mock === false, 'price-history endpoint live');
  console.log(`   (price series: ${hist.body?.series?.length ?? 0} points)`);

  const html = await (await fetch(base + '/', { signal: AbortSignal.timeout(20_000) })).text();
  check(/id="net-banner"/.test(html) && !/TESTNET ONLY/.test(html),
    'runtime-chrome HTML (no baked-in network banner)');
}

await checkSide(testnetBase, { label: 'TESTNET side', chain: 'test', faucet: true });
await checkSide(mainnetBase, { label: 'MAINNET side', chain: 'main', faucet: false });

console.log(failed ? '\nFAILED' : '\nall green');
process.exit(failed ? 1 : 0);
