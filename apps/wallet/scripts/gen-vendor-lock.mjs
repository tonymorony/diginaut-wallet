// Regenerate apps/wallet/vendor.lock from what is currently in node_modules.
//
//   npm run vendor:lock            # from apps/wallet, or the repo root
//
// Run this ONLY after a deliberate dependency change, and read the diff: it is
// the one moment anyone looks at what the /vendor seam is about to ship. A lock
// regenerated reflexively to make a failing boot go away defeats the check.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VENDOR_ROOTS } from '../server.js';
import { hashVendorTree } from '../vendor-integrity.js';

const lockPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor.lock');
const tree = hashVendorTree(VENDOR_ROOTS);

writeFileSync(lockPath, JSON.stringify(tree, null, 2) + '\n');
console.log(`vendor.lock: ${Object.keys(tree).length} files across ${Object.keys(VENDOR_ROOTS).length} packages`);
