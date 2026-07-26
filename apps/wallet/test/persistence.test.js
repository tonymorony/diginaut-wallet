import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HAD_VAULT_KEY, readPersistence, ensurePersistence, persistenceCopy,
  markHadVault, clearHadVault, hadVault,
} from '../public/persistence.js';

// Storage protection (#C2). Both probes take the StorageManager as an argument
// so they can be driven here without a browser; the contract that matters is
// that neither ever throws (they run un-awaited from click handlers) and that
// only ensurePersistence is allowed to prompt.

const spyPersist = () => {
  const calls = { n: 0 };
  return [calls, async () => { calls.n += 1; return true; }];
};

test('readPersistence: a browser without the API reports unknown, never throws', async () => {
  for (const sm of [undefined, null, {}, { persist: async () => true }]) {
    assert.deepEqual(await readPersistence(sm), { supported: false, persisted: false, asked: false });
  }
});

test('readPersistence: reports the browser answer and NEVER prompts', async () => {
  const [calls, persist] = spyPersist();
  assert.deepEqual(await readPersistence({ persisted: async () => true, persist }),
    { supported: true, persisted: true, asked: false });
  assert.deepEqual(await readPersistence({ persisted: async () => false, persist }),
    { supported: true, persisted: false, asked: false });
  assert.equal(calls.n, 0, 'the boot probe must never fire a permission prompt');
});

test('readPersistence: a throwing persisted() degrades to unknown, not a rejection', async () => {
  assert.deepEqual(await readPersistence({ persisted: async () => { throw new Error('x'); } }),
    { supported: false, persisted: false, asked: false });
});

test('ensurePersistence: asks and reports a grant', async () => {
  assert.deepEqual(await ensurePersistence({ persisted: async () => false, persist: async () => true }),
    { supported: true, persisted: true, asked: true });
});

test('ensurePersistence: asks and reports a refusal', async () => {
  assert.deepEqual(await ensurePersistence({ persisted: async () => false, persist: async () => false }),
    { supported: true, persisted: false, asked: true });
});

test('ensurePersistence: a rejected persist() does not propagate', async () => {
  assert.deepEqual(await ensurePersistence({ persisted: async () => false, persist: async () => { throw new Error('denied'); } }),
    { supported: true, persisted: false, asked: true });
});

test('ensurePersistence: already persistent → no second prompt', async () => {
  const [calls, persist] = spyPersist();
  assert.deepEqual(await ensurePersistence({ persisted: async () => true, persist }),
    { supported: true, persisted: true, asked: false });
  assert.equal(calls.n, 0);
});

test('ensurePersistence: persisted() but no persist() → supported, unprotected, unasked', async () => {
  assert.deepEqual(await ensurePersistence({ persisted: async () => false }),
    { supported: true, persisted: false, asked: false });
  assert.deepEqual(await ensurePersistence(null),
    { supported: false, persisted: false, asked: false });
});

test('persistenceCopy: the four states map onto the .dot classes', () => {
  assert.equal(persistenceCopy(null).level, 'warn');
  assert.equal(persistenceCopy(null).label, 'Checking…');
  assert.equal(persistenceCopy({ supported: false, persisted: false }).level, 'warn');
  assert.equal(persistenceCopy({ supported: false, persisted: false }).label, 'Unknown');
  assert.equal(persistenceCopy({ supported: true, persisted: true }).level, 'good');
  assert.equal(persistenceCopy({ supported: true, persisted: true }).label, 'Protected');
  assert.equal(persistenceCopy({ supported: true, persisted: false }).level, 'bad');
  assert.equal(persistenceCopy({ supported: true, persisted: false }).label, 'Not protected');
});

test('persistenceCopy: the unprotected detail names the risk and the real backup', () => {
  const bad = persistenceCopy({ supported: true, persisted: false }).detail;
  assert.match(bad, /evict/i);
  assert.match(bad, /seed phrase/);
  const unknown = persistenceCopy({ supported: false, persisted: false }).detail;
  assert.match(unknown, /evictable/i);
  assert.match(unknown, /seed phrase/);
});

// ---- tombstone ----

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('tombstone: mark → hadVault true; clear → false', () => {
  const s = memStore();
  assert.equal(hadVault(s), false);
  markHadVault(s);
  assert.equal(hadVault(s), true);
  assert.equal(s.getItem(HAD_VAULT_KEY), '1');
  clearHadVault(s);
  assert.equal(hadVault(s), false);
});

test('tombstone: a missing store is simply "no tombstone"', () => {
  assert.equal(hadVault(null), false);
  assert.equal(hadVault(undefined), false);
  markHadVault(null); // must not throw
  clearHadVault(undefined); // must not throw
});

test('tombstone: a private-mode store that throws must not break the boot path', () => {
  const boom = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  assert.equal(hadVault(boom), false);
  markHadVault(boom);
  clearHadVault(boom);
});

test('tombstone: a foreign value is not a tombstone (only the literal "1")', () => {
  const s = memStore();
  s.setItem(HAD_VAULT_KEY, 'true');
  assert.equal(hadVault(s), false);
  s.setItem(HAD_VAULT_KEY, '1');
  assert.equal(hadVault(s), true);
});

test('the tombstone key is pinned — renaming it silently disarms the recovery hero', () => {
  assert.equal(HAD_VAULT_KEY, 'diginaut.hadVault');
});
