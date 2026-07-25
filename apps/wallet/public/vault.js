// Vault manager — single source of truth for wallet metadata + mnemonics
// (docs/specs/wallet-management-v2.md §1). State machine over
// { record, key, secrets }:
//   none      record=null                    no vault stored
//   locked    record set, key=null           cleartext meta readable (names, badges)
//   unlocked  record + key + secrets         mutations re-encrypt under the held key
// Storage is injected so the logic runs under node --test with an in-memory
// stand-in; the browser passes the keystore.js module itself (same fn names).
// Crypto comes straight from keystore.js — pure WebCrypto, runs everywhere.
import {
  decryptMnemonic, encryptJson, decryptJson, encryptJsonWithKey, decryptJsonWithKey,
  VaultConflictError,
} from './keystore.js';

// Mnemonic identity for the duplicate-wallet guard: whitespace/case noise
// must not smuggle the same seed in twice.
const normMnemonic = (m) => String(m ?? '').trim().toLowerCase().split(/\s+/).join(' ');

// Wallet ids are 'w<epoch-ish counter>' — never reused, bumped past collisions.
function newWalletId(wallets) {
  const taken = new Set(wallets.map((w) => w.id));
  let n = Date.now();
  while (taken.has(`w${n}`)) n += 1;
  return `w${n}`;
}

/** Create a vault manager over the given storage (keystore.js in the browser). */
export function createVaultManager(storage) {
  let record = null; // stored vault record: { v:2, rev, kdf, cipher, meta }
  let key = null; // non-extractable AES session key; matches record.kdf.salt, dropped on lock
  let secrets = null; // { mnemonics: { [id]: mnemonic } } — plaintext, unlocked only
  let primary = null; // legacy v1 record if one still exists (migration pending)

  const status = () => (key ? 'unlocked' : record || primary ? 'locked' : 'none');
  const meta = () => (record ? structuredClone(record.meta) : null);

  function assertUnlocked() {
    if (!key) throw new Error('vault is locked');
  }

  function getWallet(id) {
    const w = record?.meta.wallets.find((x) => x.id === id);
    if (!w) throw new Error(`unknown wallet: ${id}`);
    return w;
  }

  function assertNameFree(name, selfId) {
    const clash = record.meta.wallets.some(
      (w) => w.id !== selfId && w.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (clash) throw new Error(`a wallet named "${name.trim()}" already exists`);
  }

  /** Read whatever storage holds (no decryption). Returns the status. */
  async function load() {
    const found = await storage.loadKeystoreAny();
    record = found.vault;
    primary = found.primary;
    return status();
  }

  /** Re-sync from storage after a cross-tab write (or a lost CAS race).
   * Stays unlocked while the held key still opens the stored record; drops to
   * locked/none otherwise (vault erased or re-created under a new salt). */
  async function refresh() {
    const found = await storage.loadKeystoreAny();
    record = found.vault;
    primary = found.primary;
    if (key) {
      try {
        secrets = record ? await decryptJsonWithKey(record, key) : null;
      } catch {
        secrets = null;
      }
      if (!secrets) lock();
    }
    return status();
  }

  // Other tabs post on BroadcastChannel after every successful write; refresh
  // so a stale base rev (→ VaultConflictError) is rare rather than routine.
  storage.onVaultChanged?.(() => {
    refresh().catch(() => {});
  });

  /** CAS write of meta+secrets re-encrypted under the held key (fresh IV).
   * On conflict: reload from storage, then RETHROW — the stale mutation is
   * gone for good; the caller must surface it, never silently retry. */
  async function commit(nextMeta, nextSecrets) {
    assertUnlocked();
    // Snapshot the CAS base BEFORE any await: a cross-tab refresh() can
    // reassign `record` while encrypt is suspended, and a base rev read after
    // the await would CAS against the ADVANCED rev — turning a genuine
    // conflict into a silent last-writer-wins overwrite of the other tab's
    // freshly written mnemonics.
    const { rev: baseRev, kdf: baseKdf } = record;
    const { kdf, cipher } = await encryptJsonWithKey(nextSecrets, key, baseKdf);
    try {
      record = await storage.saveVaultRecord({ v: 2, kdf, cipher, meta: nextMeta }, baseRev);
      secrets = nextSecrets;
    } catch (err) {
      if (err instanceof VaultConflictError) await refresh();
      throw err;
    }
  }

  /** First-ever vault: one wallet, one master password. Returns the wallet id. */
  async function createVault(password, { name, mnemonic, backedUp = false }) {
    if ((await load()) !== 'none') throw new Error('a vault already exists');
    const id = newWalletId([]);
    const newSecrets = { mnemonics: { [id]: mnemonic } };
    const newMeta = {
      activeId: id,
      wallets: [{ id, name: name.trim(), createdAt: Date.now(), backedUp: !!backedUp }],
    };
    // encryptJson hands back the key for the salt it just generated — the held
    // key must always match the salt in the record we store (key↔salt invariant).
    const { blob, key: newKey } = await encryptJson(newSecrets, password);
    record = await storage.saveVaultRecord({ v: 2, kdf: blob.kdf, cipher: blob.cipher, meta: newMeta }, 0);
    key = newKey;
    secrets = newSecrets;
    return id;
  }

  /** Unlock with the master password. Handles v1 migration (fresh or
   * interrupted) transparently. Returns the vault meta. */
  async function unlock(password) {
    await load();
    if (record) {
      try {
        const out = await decryptJson(record, password);
        key = out.key;
        secrets = out.obj;
      } catch (err) {
        // v2 won't decrypt. If an interrupted migration left the v1 record
        // behind, that copy is authoritative — redo the migration over the bad
        // v2. With no v1 fallback this is simply a wrong password.
        if (!primary) throw err;
        return migrateV1(primary, password);
      }
      if (primary) {
        // Interrupted migration that DID write a good v2: the v1 record is an
        // orphan — finish the job.
        await storage.deleteKeystore();
        primary = null;
      }
      return meta();
    }
    if (primary) return migrateV1(primary, password);
    throw new Error('no wallet stored');
  }

  /** v1 → v2: same password, one wallet, backedUp:false (existing users get
   * the quiz path via the badge). Loss-proof order: write v2, verify it
   * decrypts from storage, only then delete v1 — a crash at any step leaves
   * at least one decryptable record. */
  async function migrateV1(v1record, password) {
    const mnemonic = await decryptMnemonic(v1record, password); // raw string; throws on wrong password
    const id = newWalletId([]);
    const newSecrets = { mnemonics: { [id]: mnemonic } };
    const newMeta = {
      activeId: id,
      wallets: [{ id, name: 'Wallet 1', createdAt: Date.now(), backedUp: false }],
    };
    // Fresh salt + matching key from encryptJson — NEVER the v1 salt's key
    // (a mismatched key would brick every future write; see spec §1).
    const { blob, key: newKey } = await encryptJson(newSecrets, password);
    const saved = await storage.saveVaultRecord(
      { v: 2, kdf: blob.kdf, cipher: blob.cipher, meta: newMeta },
      record?.rev ?? 0, // overwrites a bad v2 left by an earlier attempt
    );
    await decryptJsonWithKey(saved, newKey); // verify before burning the v1 copy
    await storage.deleteKeystore();
    record = saved;
    key = newKey;
    secrets = newSecrets;
    primary = null;
    return meta();
  }

  /** Drop the session key + plaintext secrets; cleartext meta stays visible. */
  function lock() {
    key = null;
    secrets = null;
  }

  /** Add a wallet. Duplicate-mnemonic contract (restore + file import alike):
   * a seed already in the vault is never added twice — the existing wallet's
   * id comes back with existed:true. Does not change the active wallet. */
  async function addWallet({ name, mnemonic, backedUp = false }) {
    assertUnlocked();
    const dup = Object.entries(secrets.mnemonics).find(([, m]) => normMnemonic(m) === normMnemonic(mnemonic));
    if (dup) return { id: dup[0], existed: true };
    assertNameFree(name, null);
    const id = newWalletId(record.meta.wallets);
    const nextMeta = {
      ...record.meta,
      wallets: [...record.meta.wallets, { id, name: name.trim(), createdAt: Date.now(), backedUp: !!backedUp }],
    };
    await commit(nextMeta, { mnemonics: { ...secrets.mnemonics, [id]: mnemonic } });
    return { id, existed: false };
  }

  /** Rename a wallet (case-insensitive duplicate-name guard). */
  async function renameWallet(id, name) {
    assertUnlocked();
    getWallet(id);
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('wallet name must not be empty');
    assertNameFree(trimmed, id);
    const nextMeta = {
      ...record.meta,
      wallets: record.meta.wallets.map((w) => (w.id === id ? { ...w, name: trimmed } : w)),
    };
    await commit(nextMeta, secrets);
  }

  /** Remove a wallet. Removing the last one deletes the vault record entirely
   * (→ none); removing the active one hands active to the adjacent wallet in
   * display order. */
  async function removeWallet(id) {
    assertUnlocked();
    getWallet(id);
    const wallets = record.meta.wallets;
    const remaining = wallets.filter((w) => w.id !== id);
    if (remaining.length === 0) {
      // rev-CAS delete (same contract as commit): if another tab added a
      // wallet since this tab last synced, "last wallet" is a stale premise
      // and a blind delete would destroy that tab's mnemonic for good.
      try {
        await storage.deleteVaultRecord(record.rev);
      } catch (err) {
        if (err instanceof VaultConflictError) await refresh();
        throw err;
      }
      record = null;
      lock();
      return;
    }
    let activeId = record.meta.activeId;
    if (activeId === id) {
      const idx = wallets.findIndex((w) => w.id === id);
      activeId = (wallets[idx + 1] ?? wallets[idx - 1]).id;
    }
    const nextSecrets = { mnemonics: { ...secrets.mnemonics } };
    delete nextSecrets.mnemonics[id];
    await commit({ ...record.meta, activeId, wallets: remaining }, nextSecrets);
  }

  /** Make a wallet the active one (persisted so unlock reopens it). */
  async function setActive(id) {
    assertUnlocked();
    getWallet(id);
    if (record.meta.activeId === id) return;
    await commit({ ...record.meta, activeId: id }, secrets);
  }

  /** Mark a wallet backed up — set ONLY by a passed quiz, never cleared. */
  async function setBackedUp(id) {
    assertUnlocked();
    getWallet(id);
    const nextMeta = {
      ...record.meta,
      wallets: record.meta.wallets.map((w) => (w.id === id ? { ...w, backedUp: true } : w)),
    };
    await commit(nextMeta, secrets);
  }

  /** Remember how far down the receive chain this wallet has handed out
   * addresses. MONOTONIC on purpose: the counter is what keeps a handed-out
   * address watched before anyone has paid it, so a stale tab (or a
   * re-opened older session) must never walk it back and un-watch one.
   * Absent on wallets created before this existed → treated as 0. */
  async function setReceiveIndex(id, index) {
    assertUnlocked();
    const w = getWallet(id);
    const want = Number.isSafeInteger(index) && index > 0 ? index : 0;
    const next = Math.max(want, w.receiveIndex ?? 0);
    if (next === (w.receiveIndex ?? 0)) return; // no write, no rev churn
    const nextMeta = {
      ...record.meta,
      wallets: record.meta.wallets.map((x) => (x.id === id ? { ...x, receiveIndex: next } : x)),
    };
    await commit(nextMeta, secrets);
  }

  /** The one secret read. Only while unlocked; only inside a reveal ceremony. */
  function getMnemonic(id) {
    assertUnlocked();
    const m = secrets.mnemonics[id];
    if (!m) throw new Error(`unknown wallet: ${id}`);
    return m;
  }

  /** Re-auth probe (reveal / export / backup re-entry): a full decrypt attempt
   * against the stored record, no state change. */
  async function verifyPassword(password) {
    if (!record) return false;
    try {
      await decryptJson(record, password);
      return true;
    } catch {
      return false;
    }
  }

  return {
    load, refresh, unlock, lock, createVault, migrateV1,
    addWallet, renameWallet, removeWallet, setActive, setBackedUp, setReceiveIndex,
    getMnemonic, verifyPassword, meta,
    get status() { return status(); },
  };
}
