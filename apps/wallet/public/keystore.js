// Encrypted wallet keystore.
// Crypto: PBKDF2-SHA256 (600k iterations, OWASP 2023 floor) → AES-256-GCM.
// Storage: one record in IndexedDB. v2 keeps a single `vault` record holding
// all wallets' mnemonics in one ciphertext (see docs/specs/wallet-management-v2.md);
// v1 kept one raw-string mnemonic in a `primary` record. Secrets are the only
// thing at rest; keys are re-derived on unlock and live only in page memory.
// TESTNET scope: optional backup, no hardware-grade hardening (see TODO.md).

const PBKDF2_ITERATIONS = 600_000;

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveAesKey(password, salt, iterations) {
  const material = await subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Core string crypto shared by the v1 mnemonic format, the v2 vault, and the
// keystore file envelope. Returns the derived key alongside the blob so the
// caller can keep mutating under it without re-prompting for the password —
// the key ALWAYS matches the salt in the blob it came with (key↔salt invariant).
async function encryptString(str, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(str));
  return {
    key,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) },
    cipher: { name: 'AES-256-GCM', iv: toB64(iv), data: toB64(ciphertext) },
  };
}

async function decryptString(blob, password) {
  const key = await deriveAesKey(password, fromB64(blob.kdf.salt), blob.kdf.iterations);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.cipher.iv) },
    key,
    fromB64(blob.cipher.data),
  );
  return { key, str: new TextDecoder().decode(plain) };
}

/** Encrypt a mnemonic under a password → plain-JSON blob for IndexedDB.
 * v1 format: the plaintext is the RAW UTF-8 mnemonic string, not JSON —
 * installed v1 records and exported keystore files depend on this. */
export async function encryptMnemonic(mnemonic, password) {
  const { kdf, cipher } = await encryptString(mnemonic, password);
  return { v: 1, kdf, cipher };
}

/** Decrypt a keystore blob. Throws on a wrong password (GCM auth failure). */
export async function decryptMnemonic(blob, password) {
  if (blob?.v !== 1) throw new Error(`unsupported keystore version: ${blob?.v}`);
  return (await decryptString(blob, password)).str;
}

/** Encrypt any JSON-able object under a password (fresh salt + IV).
 * Returns { blob: {kdf, cipher}, key } — hold the key to keep writing without
 * the password; it matches blob.kdf.salt by construction. */
export async function encryptJson(obj, password) {
  const { key, kdf, cipher } = await encryptString(JSON.stringify(obj), password);
  return { blob: { kdf, cipher }, key };
}

/** Decrypt a {kdf, cipher} blob and parse the JSON plaintext.
 * Returns { obj, key }; throws on a wrong password (GCM auth failure). */
export async function decryptJson(blob, password) {
  const { key, str } = await decryptString(blob, password);
  return { obj: JSON.parse(str), key };
}

/** Re-encrypt under an already-derived session key (fresh IV, same KDF).
 * kdf MUST be the stored record's kdf block — the salt AND iteration count the
 * held key was derived from are echoed verbatim so future password unlocks
 * re-derive the same key. Stamping the current PBKDF2_ITERATIONS constant here
 * instead would brick every pre-existing vault the day the constant is raised:
 * the first mutation would advertise iterations the ciphertext's key was never
 * derived with, and every later unlock would fail with the correct password. */
export async function encryptJsonWithKey(obj, key, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(JSON.stringify(obj)));
  return {
    kdf: { name: kdf.name, iterations: kdf.iterations, salt: kdf.salt },
    cipher: { name: 'AES-256-GCM', iv: toB64(iv), data: toB64(ciphertext) },
  };
}

/** Decrypt a {kdf, cipher} blob with a held session key (no KDF run). */
export async function decryptJsonWithKey(blob, key) {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.cipher.iv) },
    key,
    fromB64(blob.cipher.data),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- Keystore file export/import envelope (spec §4) ----
// A per-wallet encrypted export: ONE mnemonic under the master password with a
// fresh salt + IV (never the vault's). It only opens with that password — a
// convenience copy, NOT a replacement for the seed phrase.

export const KEYSTORE_FILE_FORMAT = 'diginaut-keystore';
export const KEYSTORE_FILE_VERSION = 1;

/** Build the export envelope for one wallet. network is 'mainnet'/'testnet'
 * or null when the node hasn't named its chain. */
export async function buildKeystoreFile({ name, network, mnemonic, password }) {
  const { kdf, cipher } = await encryptString(mnemonic, password);
  return {
    format: KEYSTORE_FILE_FORMAT,
    v: KEYSTORE_FILE_VERSION,
    name,
    network: network ?? null,
    exportedAt: new Date().toISOString(),
    kdf,
    cipher,
  };
}

/** Parse + validate a keystore file's JSON text. Throws a message the import
 * UI can show verbatim for a wrong format, version, or damaged file. */
export function parseKeystoreFile(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('this is not a keystore file (not valid JSON)');
  }
  if (obj?.format !== KEYSTORE_FILE_FORMAT) throw new Error('this is not a diginaut keystore file');
  if (obj.v !== KEYSTORE_FILE_VERSION) {
    throw new Error(`unsupported keystore file version: ${obj.v} (this app reads v${KEYSTORE_FILE_VERSION})`);
  }
  if (typeof obj.kdf?.salt !== 'string' || typeof obj.cipher?.iv !== 'string' || typeof obj.cipher?.data !== 'string') {
    throw new Error('keystore file is damaged — its crypto fields are missing');
  }
  return obj;
}

/** Decrypt an envelope's mnemonic with the FILE's password (raw string, like
 * v1 blobs). Throws on a wrong password (GCM auth failure). */
export async function decryptKeystoreFile(envelope, password) {
  return (await decryptString(envelope, password)).str;
}

/** Filename convention: diginaut-<name-slug>-<yyyymmdd>.keystore.json */
export function keystoreFileName(name, when = new Date()) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wallet';
  return `diginaut-${slug}-${when.toISOString().slice(0, 10).replace(/-/g, '')}.keystore.json`;
}

// ---- IndexedDB persistence (browser only) ----

const DB_NAME = 'dd-wallet';
const STORE = 'keystore';
const RECORD_ID = 'primary'; // legacy v1 single-wallet record
const VAULT_ID = 'vault'; // v2 multi-wallet record
const CHANNEL = 'diginaut-vault'; // cross-tab write notifications

/** Thrown by saveVaultRecord when another tab wrote the vault first (the
 * stored rev no longer matches the base the mutation was computed from). */
export class VaultConflictError extends Error {
  constructor() {
    super('vault was modified concurrently (another tab?)');
    this.name = 'VaultConflictError';
  }
}

// Tell other tabs the vault changed so they refresh before their next write.
// A throwaway channel per post: nothing held open, works in browser and Node.
function broadcastVaultChange(msg) {
  if (typeof BroadcastChannel !== 'function') return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(msg);
  ch.close();
}

/** Subscribe to vault writes from OTHER tabs. Returns an unsubscribe fn. */
export function onVaultChanged(fn) {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => fn(e.data);
  ch.unref?.(); // Node only: never keep the process alive
  return () => ch.close();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

/** Persist the encrypted blob (single wallet per browser profile). */
export function saveKeystore(blob) {
  return withStore('readwrite', (store) => requestDone(store.put({ id: RECORD_ID, ...blob })));
}

/** Load the stored blob, or null if no wallet exists yet. */
export async function loadKeystore() {
  const rec = await withStore('readonly', (store) => requestDone(store.get(RECORD_ID)));
  return rec ?? null;
}

/** Forget the wallet (used by restore-over). Irreversible without the seed. */
export function deleteKeystore() {
  return withStore('readwrite', (store) => requestDone(store.delete(RECORD_ID)));
}

// ---- v2 vault persistence ----

/** Load whatever exists: { vault, primary } (either may be null). Both being
 * non-null means an interrupted v1→v2 migration — the vault manager decides
 * which one wins on the next unlock. */
export async function loadKeystoreAny() {
  return withStore('readonly', async (store) => ({
    vault: (await requestDone(store.get(VAULT_ID))) ?? null,
    primary: (await requestDone(store.get(RECORD_ID))) ?? null,
  }));
}

/** Compare-and-set write of the single vault record. Re-reads the stored rev
 * inside the same readwrite transaction; if it no longer matches baseRev
 * (another tab wrote first) nothing is written and VaultConflictError is
 * thrown — a blind overwrite could silently drop that tab's new mnemonic.
 * baseRev is 0 for the initial create. Returns the saved record (rev+1). */
export async function saveVaultRecord(record, baseRev) {
  const saved = await withStore('readwrite', async (store) => {
    const current = await requestDone(store.get(VAULT_ID));
    if ((current?.rev ?? 0) !== baseRev) throw new VaultConflictError();
    const next = { ...record, id: VAULT_ID, rev: baseRev + 1 };
    await requestDone(store.put(next));
    return next;
  });
  broadcastVaultChange({ type: 'write', rev: saved.rev });
  return saved;
}

/** Delete the vault record (removing the last wallet). CAS-guarded like
 * saveVaultRecord: re-reads the stored rev inside the same readwrite
 * transaction and throws VaultConflictError if it moved past baseRev — a blind
 * delete could wipe a wallet another tab just added to the vault. */
export async function deleteVaultRecord(baseRev) {
  await withStore('readwrite', async (store) => {
    const current = await requestDone(store.get(VAULT_ID));
    if ((current?.rev ?? 0) !== baseRev) throw new VaultConflictError();
    await requestDone(store.delete(VAULT_ID));
  });
  broadcastVaultChange({ type: 'delete' });
}

/** Global reset: wipe every record (v1 and v2). Irreversible without seeds. */
export async function deleteAllRecords() {
  await withStore('readwrite', (store) => requestDone(store.clear()));
  broadcastVaultChange({ type: 'delete' });
}
