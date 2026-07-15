// Vault manager: v2 multi-wallet keystore over injected storage.
// Crypto is the real WebCrypto path (PBKDF2 600k → AES-GCM); storage is an
// in-memory CAS stand-in mirroring keystore.js's IndexedDB layer, so every
// round-trip here exercises exactly what the browser persists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultManager } from '../public/vault.js';
import { encryptMnemonic, decryptMnemonic, decryptJson, VaultConflictError } from '../public/keystore.js';

const M1 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const M3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const PW = 'correct horse battery staple';

// In-memory storage with the same surface (and the same CAS semantics) as
// keystore.js. JSON-clones on the way in and out, like structured clone does.
function memStorage() {
  const db = new Map();
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
  return {
    db,
    async loadKeystoreAny() {
      return { vault: clone(db.get('vault')), primary: clone(db.get('primary')) };
    },
    async saveVaultRecord(record, baseRev) {
      const cur = db.get('vault');
      if ((cur?.rev ?? 0) !== baseRev) throw new VaultConflictError();
      const next = { ...clone(record), id: 'vault', rev: baseRev + 1 };
      db.set('vault', next);
      return clone(next);
    },
    async deleteVaultRecord() {
      db.delete('vault');
    },
    async deleteKeystore() {
      db.delete('primary');
    },
  };
}

// Seed a legacy v1 record the way the old app wrote it.
async function seedV1(store, mnemonic, password) {
  const blob = await encryptMnemonic(mnemonic, password);
  store.db.set('primary', { id: 'primary', ...blob });
}

test('create → lock → unlock round-trips wallets and secrets', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  assert.equal(await vm.load(), 'none');

  const id = await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  assert.equal(vm.status, 'unlocked');
  assert.equal(vm.getMnemonic(id), M1);

  vm.lock();
  assert.equal(vm.status, 'locked');
  assert.throws(() => vm.getMnemonic(id), /locked/);
  // cleartext meta stays readable while locked (locked screen shows names)
  assert.equal(vm.meta().wallets[0].name, 'Wallet 1');
  assert.equal(vm.meta().wallets[0].backedUp, false);

  // a fresh manager (new tab / reload) unlocks from storage alone
  const vm2 = createVaultManager(store);
  const meta = await vm2.unlock(PW);
  assert.equal(meta.activeId, id);
  assert.equal(vm2.getMnemonic(id), M1);
});

test('wrong password is rejected and the vault stays locked', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  vm.lock();
  await assert.rejects(() => vm.unlock('wrong password'));
  assert.equal(vm.status, 'locked');
});

test('mutations persist via re-encryption with the held key (no re-prompt)', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  const id1 = await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  const { id: id2, existed } = await vm.addWallet({ name: 'Trading', mnemonic: M2 });
  assert.equal(existed, false);
  await vm.renameWallet(id2, 'Trading Desk');
  await vm.setActive(id2);
  await vm.setBackedUp(id1);

  // every write above used the session key; a cold unlock sees all of it
  const vm2 = createVaultManager(store);
  const meta = await vm2.unlock(PW);
  assert.equal(meta.activeId, id2);
  assert.deepEqual(
    meta.wallets.map((w) => [w.name, w.backedUp]),
    [['Wallet 1', true], ['Trading Desk', false]],
  );
  assert.equal(vm2.getMnemonic(id1), M1);
  assert.equal(vm2.getMnemonic(id2), M2);
});

test('rename and add enforce the duplicate-name guard', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  const { id: id2 } = await vm.addWallet({ name: 'Trading', mnemonic: M2 });
  await assert.rejects(() => vm.renameWallet(id2, ' wallet 1 '), /already exists/);
  await assert.rejects(() => vm.addWallet({ name: 'TRADING', mnemonic: M3 }), /already exists/);
  await assert.rejects(() => vm.renameWallet(id2, '   '), /empty/);
  // renaming a wallet to its own name is fine (self is excluded from the guard)
  await vm.renameWallet(id2, 'Trading');
});

test('adding a mnemonic already in the vault returns the existing id', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  const id1 = await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  // whitespace/case noise must not smuggle the same seed in twice
  const r = await vm.addWallet({ name: 'Sneaky Copy', mnemonic: `  ${M1.toUpperCase()}  ` });
  assert.deepEqual(r, { id: id1, existed: true });
  assert.equal(vm.meta().wallets.length, 1);
});

test('removeWallet hands active to the adjacent wallet; last removal deletes the record', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  const id1 = await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  const { id: id2 } = await vm.addWallet({ name: 'Trading', mnemonic: M2 });

  await vm.removeWallet(id1); // active + first → adjacent (id2) takes over
  assert.equal(vm.meta().activeId, id2);
  assert.throws(() => vm.getMnemonic(id1), /unknown wallet/);

  await vm.removeWallet(id2); // last wallet → the vault record itself goes
  assert.equal(vm.status, 'none');
  assert.equal(store.db.has('vault'), false);
  const vm2 = createVaultManager(store);
  assert.equal(await vm2.load(), 'none');
});

test('verifyPassword is a pure probe — no state change either way', async () => {
  const store = memStorage();
  const vm = createVaultManager(store);
  const id = await vm.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  assert.equal(await vm.verifyPassword(PW), true);
  assert.equal(await vm.verifyPassword('nope'), false);
  assert.equal(vm.status, 'unlocked');
  assert.equal(vm.getMnemonic(id), M1);
  vm.lock();
  assert.equal(await vm.verifyPassword(PW), true); // works while locked too
  assert.equal(vm.status, 'locked');
});

test('v1 → v2 migration on unlock: same password, backedUp:false, v1 deleted', async () => {
  const store = memStorage();
  await seedV1(store, M2, PW);
  const vm = createVaultManager(store);
  assert.equal(await vm.load(), 'locked');

  // a wrong password migrates nothing
  await assert.rejects(() => vm.unlock('wrong password'));
  assert.equal(store.db.has('primary'), true);
  assert.equal(store.db.has('vault'), false);

  const meta = await vm.unlock(PW);
  assert.equal(meta.wallets.length, 1);
  assert.equal(meta.wallets[0].name, 'Wallet 1');
  assert.equal(meta.wallets[0].backedUp, false); // migrated users get the quiz path
  assert.equal(vm.getMnemonic(meta.activeId), M2);
  assert.equal(store.db.has('primary'), false);
  assert.equal(store.db.get('vault').v, 2);
});

test('migration dies mid-way → store stays decryptable, next unlock finishes the job', async () => {
  const store = memStorage();
  await seedV1(store, M1, PW);

  // death BEFORE the v2 write: v1 untouched (methods close over db, so
  // spreading the store and overriding one of them is safe)
  const dieOnWrite = { ...store, saveVaultRecord: async () => { throw new Error('simulated crash'); } };
  await assert.rejects(() => createVaultManager(dieOnWrite).unlock(PW), /simulated crash/);
  assert.equal(store.db.has('primary'), true);
  assert.equal(store.db.has('vault'), false);

  // death AFTER write+verify but BEFORE deleting v1: both records remain
  const dieOnDelete = { ...store, deleteKeystore: async () => { throw new Error('simulated crash'); } };
  await assert.rejects(() => createVaultManager(dieOnDelete).unlock(PW), /simulated crash/);
  assert.equal(store.db.has('primary'), true);
  assert.equal(store.db.has('vault'), true);

  // interrupted-migration GC: v2 probe-decrypts → the orphan v1 is deleted
  const vm = createVaultManager(store);
  const meta = await vm.unlock(PW);
  assert.equal(vm.getMnemonic(meta.activeId), M1);
  assert.equal(store.db.has('primary'), false);
  assert.equal(store.db.get('vault').v, 2);
});

test('bad v2 next to a live v1 → unlock falls back to v1 and redoes the migration', async () => {
  const store = memStorage();
  await seedV1(store, M2, PW);
  // a structurally valid vault record whose ciphertext never decrypts
  const junk = (n) => Buffer.alloc(n, 7).toString('base64');
  store.db.set('vault', {
    id: 'vault', v: 2, rev: 3,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: junk(16) },
    cipher: { name: 'AES-256-GCM', iv: junk(12), data: junk(48) },
    meta: { activeId: 'w0', wallets: [] },
  });

  const vm = createVaultManager(store);
  const meta = await vm.unlock(PW);
  assert.equal(vm.getMnemonic(meta.activeId), M2);
  assert.equal(store.db.has('primary'), false);
  assert.equal(store.db.get('vault').rev, 4); // overwrote the bad record via CAS
  // and the overwrite is durable: a cold unlock decrypts
  const vm2 = createVaultManager(store);
  assert.equal((await vm2.unlock(PW)).wallets.length, 1);
});

test('key↔salt invariant: migrate v1 → mutate with held key → cold unlock decrypts', async () => {
  const store = memStorage();
  await seedV1(store, M1, PW);
  const vm = createVaultManager(store);
  await vm.unlock(PW); // migrates; the held key MUST match the new salt
  const { id: id2 } = await vm.addWallet({ name: 'Second', mnemonic: M2 });
  await vm.setBackedUp(id2);

  const vm2 = createVaultManager(store);
  const meta = await vm2.unlock(PW); // would be a GCM auth failure if the v1-salt key leaked through
  assert.equal(meta.wallets.length, 2);
  assert.equal(vm2.getMnemonic(id2), M2);
});

test('two tabs: the stale write throws VaultConflictError and loses nothing', async () => {
  const store = memStorage();
  const a = createVaultManager(store);
  const b = createVaultManager(store);
  await a.createVault(PW, { name: 'Wallet 1', mnemonic: M1 });
  await b.unlock(PW);

  const { id: fromA } = await a.addWallet({ name: 'From tab A', mnemonic: M2 }); // rev 1 → 2
  // b still holds base rev 1 — its write must abort, not clobber A's wallet
  await assert.rejects(() => b.addWallet({ name: 'From tab B', mnemonic: M3 }), VaultConflictError);

  // on conflict b reloaded: same key (same salt) still opens the record
  assert.equal(b.status, 'unlocked');
  assert.equal(b.getMnemonic(fromA), M2);
  // and the stored ciphertext holds exactly A's wallets — nothing lost, nothing stale
  const { obj } = await decryptJson(store.db.get('vault'), PW);
  assert.deepEqual(Object.values(obj.mnemonics).sort(), [M1, M2].sort());
});

// FROZEN v1 fixture captured from keystore.js output on 2026-07-15 — do NOT
// regenerate. Real installed v1 blobs encrypt the mnemonic as a raw UTF-8
// string (not JSON); a same-code round-trip test cannot catch a re-encoding
// regression in decryptMnemonic, this fixture can.
test('frozen v1 fixture blob decrypts to the raw mnemonic string', async () => {
  const FIXTURE = {
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 600000, salt: 'RnqhpVYC5286ekZdN444lw==' },
    cipher: {
      name: 'AES-256-GCM',
      iv: 'NXgkaXW3QfPePCDa',
      data: 'U2O4joGCk14tFUCQsUJ1RpBDGM1Q4MtKN9QBb9Q/KOzww6o/s+hq+Fre85eJI0g1G8QdxCYcF3pYV7cKHv0DdKafd5EH/rhmL8aHBgPLlbjiEr6XkqR4RjoLPg==',
    },
  };
  assert.equal(await decryptMnemonic(FIXTURE, 'fixture-password-1'), M2);
});
