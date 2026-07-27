// Regression guard for the driver screenshot-path fix.
//
// `new URL('.', import.meta.url).pathname` is a URL path, not a filesystem
// path: on Windows it comes back as "/C:/dev/wallet/scripts/" — a leading slash
// no fs call can resolve — and on every platform it keeps percent-encoding, so
// a checkout under a directory with a space writes to "…/My%20Repo/…". The
// drivers all use fileURLToPath() now. This exists because the idiom spreads by
// copy-paste: each new driver is written by cloning its neighbour, so one
// surviving instance would quietly reseed the whole directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const BROKEN = /import\.meta\.url\)\.pathname/;

test('no driver treats a URL pathname as a filesystem path', () => {
  const drivers = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));
  // A scan that passes because it scanned nothing is worse than no scan: pin a
  // floor, so a moved/renamed scripts dir fails here instead of going green.
  assert.ok(drivers.length > 10, `expected the driver set in ${SCRIPTS}, found ${drivers.length} .mjs files`);
  const offenders = drivers.filter((f) => BROKEN.test(readFileSync(join(SCRIPTS, f), 'utf8')));
  assert.deepEqual(offenders, [],
    `use fileURLToPath(new URL('.', import.meta.url)) instead of .pathname: ${offenders.join(', ')}`);
});
