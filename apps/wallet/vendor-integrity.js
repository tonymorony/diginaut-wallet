// Integrity check for the /vendor seam (dependency plan item 4).
//
// server.js serves the crypto dependencies straight out of node_modules under
// /vendor/, and the browser executes every byte of them. Pinning in
// package.json (#114) fixes which VERSIONS npm installs; it does not tell us
// that what is on disk at boot is still what npm installed. Anything that can
// write to node_modules — a postinstall script, a stale layer in a rebuilt
// image, an edit on the server — changes the code the wallet ships to users
// without changing a version number anywhere.
//
// vendor.lock is path → sha256 for every file the seam can serve. The server
// verifies it at boot and refuses to start on any mismatch: signing-key
// material passes through this code, so degraded-but-running is not an option.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

/** Every regular file under `dir`, as paths relative to it, POSIX-separated and sorted. */
function walk(dir) {
  const out = [];
  const recurse = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) recurse(abs);
      // Symlinks are deliberately NOT followed: a link is a redirect to bytes
      // outside the tree we are hashing, so honouring it would let the thing
      // this check exists to catch walk straight through it.
      else if (entry.isFile()) out.push(relative(dir, abs).split(sep).join('/'));
    }
  };
  recurse(dir);
  return out;
}

/**
 * Hash every file the /vendor seam can serve.
 * `roots` is { packageName: absoluteDir } — server.js's VENDOR_ROOTS verbatim.
 * Keys are the request paths the seam answers, minus the /vendor/ prefix.
 */
export function hashVendorTree(roots) {
  const tree = {};
  for (const pkg of Object.keys(roots).sort()) {
    for (const rel of walk(roots[pkg])) {
      tree[`${pkg}/${rel}`] = createHash('sha256').update(readFileSync(join(roots[pkg], rel))).digest('hex');
    }
  }
  return tree;
}

/**
 * Compare the tree on disk against a lock.
 * Returns { ok, changed, missing, unexpected } — `unexpected` matters as much as
 * the rest, because serveFrom will happily serve a file nobody recorded.
 */
export function verifyVendorTree(roots, lock) {
  const actual = hashVendorTree(roots);
  const changed = [];
  const missing = [];
  for (const [path, digest] of Object.entries(lock)) {
    if (!(path in actual)) missing.push(path);
    else if (actual[path] !== digest) changed.push(path);
  }
  const unexpected = Object.keys(actual).filter((p) => !(p in lock));
  return { ok: !changed.length && !missing.length && !unexpected.length, changed, missing, unexpected };
}

/** Human-readable summary of a failed verify, capped so a wholesale change stays readable. */
export function describeVendorFailure({ changed, missing, unexpected }) {
  const lines = [];
  const section = (label, paths) => {
    if (!paths.length) return;
    lines.push(`  ${paths.length} ${label}:`);
    for (const p of paths.slice(0, 10)) lines.push(`    ${p}`);
    if (paths.length > 10) lines.push(`    … and ${paths.length - 10} more`);
  };
  section('changed', changed);
  section('missing', missing);
  section('not in vendor.lock', unexpected);
  return lines.join('\n');
}
