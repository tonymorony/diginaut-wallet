// Browser storage protection + the "this browser used to hold a wallet"
// tombstone (#C2).
//
// The vault lives in IndexedDB, which every browser treats as EVICTABLE unless
// the origin is marked persistent: under storage pressure — or on a "clear site
// data" the user aimed at something else — it can be deleted with no warning
// and no trace. navigator.storage.persist() asks for the mark; persisted()
// reports whether it is already set. Both are absent on some browsers, so every
// answer here is honest about "unknown" rather than assuming protection.
//
// HONEST LIMIT of the tombstone: localStorage and IndexedDB are usually evicted
// TOGETHER, so a full "clear site data" takes the tombstone with the vault and
// the recovery hero never fires. What it does catch is partial eviction,
// IndexedDB corruption, and quota trimming that spares the (tiny) localStorage
// entry. Best-effort by construction — it can only ever add a true warning,
// never remove one.
//
// Dependencies are injected (the StorageManager, the Storage) so this module is
// pure and node-testable, following the netchrome.js/autolock.js/dca.js
// precedent, and so a private-mode throw is swallowed at one place.

export const HAD_VAULT_KEY = 'diginaut.hadVault';

/** Read the current protection state. NEVER prompts — safe on the boot path,
 * where a persist() with no user gesture fires Firefox's permission prompt on a
 * cold page load (and gets denied). */
export async function readPersistence(sm) {
  if (!sm || typeof sm.persisted !== 'function') return { supported: false, persisted: false, asked: false };
  try {
    return { supported: true, persisted: (await sm.persisted()) === true, asked: false };
  } catch {
    return { supported: false, persisted: false, asked: false };
  }
}

/** Ask for protection if it is not already granted. MAY prompt — call it only
 * from a real user gesture (vault create, unlock). Never rejects: it runs
 * un-awaited inside click handlers, where a rejection would be an unhandled one. */
export async function ensurePersistence(sm) {
  if (!sm || typeof sm.persisted !== 'function') return { supported: false, persisted: false, asked: false };
  const already = await sm.persisted().catch(() => false);
  if (already === true) return { supported: true, persisted: true, asked: false };
  if (typeof sm.persist !== 'function') return { supported: true, persisted: false, asked: false };
  let granted = false;
  try {
    granted = (await sm.persist()) === true;
  } catch {
    granted = false;
  }
  return { supported: true, persisted: granted, asked: true };
}

/** Network-modal copy for a state from the two functions above (null = not
 * probed yet). `level` maps 1:1 onto the existing .dot.good/.bad/.warn CSS. */
export function persistenceCopy(state) {
  if (state == null) return { level: 'warn', label: 'Checking…', detail: '' };
  if (!state.supported) {
    return {
      level: 'warn',
      label: 'Unknown',
      detail: 'This browser does not report whether it protects stored site data. Treat this wallet as evictable — your written seed phrase is the only guaranteed backup.',
    };
  }
  if (state.persisted) {
    return {
      level: 'good',
      label: 'Protected',
      detail: 'The browser marked this wallet\'s stored data as persistent — it will not be evicted to reclaim space. Clearing site data still erases it.',
    };
  }
  return {
    level: 'bad',
    label: 'Not protected',
    detail: 'The browser may evict this wallet\'s stored data under storage pressure or on "clear site data". If that happens, only your written seed phrase (or a backup file and its password) can restore the wallet.',
  };
}

// Tombstone helpers. Storage is injected so node:test can pass a Map-backed
// stub, and so a private-mode throw degrades to "no tombstone" instead of
// killing the boot path.
export function markHadVault(store) {
  try { store?.setItem(HAD_VAULT_KEY, '1'); } catch { /* private mode → no tombstone */ }
}
export function clearHadVault(store) {
  try { store?.removeItem(HAD_VAULT_KEY); } catch { /* private mode → nothing to clear */ }
}
export function hadVault(store) {
  try { return store?.getItem(HAD_VAULT_KEY) === '1'; } catch { return false; }
}
