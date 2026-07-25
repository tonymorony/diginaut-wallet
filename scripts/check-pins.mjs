// Guards the pinning decisions so they cannot quietly erode.
//
// The five external packages are served INTO THE PAGE through the /vendor seam
// and run with the seed in scope, and the base images run the process that
// signs transactions. A caret slipping back into a manifest, or a base image
// dropping back to a floating tag, would be invisible in review — so it fails
// the build instead.
//
//   node scripts/check-pins.mjs   # exit 0 = every pin intact
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const problems = [];

const MANIFESTS = [
  'package.json',
  'apps/wallet/package.json',
  'apps/indexer/package.json',
  'apps/faucet/package.json',
  'packages/digidollar-js/package.json',
];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

for (const file of MANIFESTS) {
  const pkg = JSON.parse(read(file));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!EXACT.test(range)) {
        problems.push(`${file}: ${field}.${name} is "${range}" — pin it exactly (a range is what npm install widens)`);
      }
    }
  }
}

const DOCKERFILES = ['deploy/node.Dockerfile', 'scripts/electrumx-regtest/Dockerfile'];
for (const file of DOCKERFILES) {
  for (const line of read(file).split('\n')) {
    const m = /^FROM\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    if (!/@sha256:[0-9a-f]{64}$/.test(m[1])) {
      problems.push(`${file}: FROM ${m[1]} is a floating tag — pin it by digest`);
    }
  }
}

// The lockfile is the thing npm ci actually installs from: every external
// package must carry an integrity hash, or nothing is being verified.
const lock = JSON.parse(read('package-lock.json'));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/')) continue;
  if (entry.link) continue; // workspace symlink, nothing to hash
  if (!entry.integrity) problems.push(`package-lock.json: ${path} has no integrity hash`);
  if (!EXACT.test(entry.version ?? '')) problems.push(`package-lock.json: ${path} version "${entry.version}" is not exact`);
}

if (problems.length) {
  console.error('pin check FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('pin check OK — manifests exact, base images digest-pinned, lockfile integrity complete');
