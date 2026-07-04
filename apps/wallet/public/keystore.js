// Encrypted wallet keystore.
// Crypto: PBKDF2-SHA256 (600k iterations, OWASP 2023 floor) → AES-256-GCM.
// Storage: one record in IndexedDB. The mnemonic is the only secret at rest;
// keys are re-derived from it on unlock and live only in page memory.
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

/** Encrypt a mnemonic under a password → plain-JSON blob for IndexedDB. */
export async function encryptMnemonic(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(mnemonic));
  return {
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) },
    cipher: { name: 'AES-256-GCM', iv: toB64(iv), data: toB64(ciphertext) },
  };
}

/** Decrypt a keystore blob. Throws on a wrong password (GCM auth failure). */
export async function decryptMnemonic(blob, password) {
  if (blob?.v !== 1) throw new Error(`unsupported keystore version: ${blob?.v}`);
  const key = await deriveAesKey(password, fromB64(blob.kdf.salt), blob.kdf.iterations);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.cipher.iv) },
    key,
    fromB64(blob.cipher.data),
  );
  return new TextDecoder().decode(plain);
}

// ---- IndexedDB persistence (browser only) ----

const DB_NAME = 'dd-wallet';
const STORE = 'keystore';
const RECORD_ID = 'primary';

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
