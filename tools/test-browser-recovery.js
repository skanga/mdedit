const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentModel } = require('../src/document-model');
const { BROWSER_RECOVERY_PREFIX, createBrowserRecoveryIo, createBrowserRecoveryEnvironment } = require('../src/browser-recovery');

function memoryStorage() {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
function snapshot(id, revision) {
  return JSON.stringify(new DocumentModel({ id, displayName: `${id}.md`, content: `body:${revision}`,
    snapshotRevision: revision, savedContentSha256: 'saved' }).toSnapshot());
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const key = (id, slot) => `${BROWSER_RECOVERY_PREFIX}document:${encodeURIComponent(id)}:${slot}`;

async function seed(storage) {
  await createBrowserRecoveryIo(storage).writeRecoveryDocument('a', 1, snapshot('a', 1));
}

function manifest(revision, generation = revision) {
  return JSON.stringify({ schemaVersion: 1, generation, activeDocumentId: 'a', nextUntitledNumber: 1,
    tabs: [{ documentId: 'a', displayName: 'a.md', canonicalPath: null, snapshotRevision: revision }] });
}
async function committed(storage) {
  const io = createBrowserRecoveryIo(storage);
  await io.writeRecoveryDocument('a', 1, snapshot('a', 1));
  await io.writeRecoveryManifest(1, manifest(1));
  return io;
}

test('repeated unpublished writes across adapter restart retain the manifest-referenced snapshot', async () => {
  const storage = memoryStorage(), first = await committed(storage);
  await first.writeRecoveryDocument('a', 2, snapshot('a', 2));
  const restarted = createBrowserRecoveryIo(storage);
  assert.equal(await restarted.loadRecoveryDocument('a', 1), snapshot('a', 1));
  const replacement = JSON.parse(snapshot('a', 2)); replacement.content = 'new edit after restart reuses unpublished revision 2';
  await restarted.writeRecoveryDocument('a', 2, JSON.stringify(replacement));
  assert.equal(await restarted.loadRecoveryDocument('a', 2), JSON.stringify(replacement));
  for (let revision = 3; revision <= 5; revision++) await restarted.writeRecoveryDocument('a', revision, snapshot('a', revision));
  assert.equal(await restarted.loadRecoveryManifest(), manifest(1));
  assert.equal(await restarted.loadRecoveryDocument('a', 1), snapshot('a', 1));
  assert.equal(await restarted.loadRecoveryDocument('a', 5), snapshot('a', 5));
  assert.equal(storage.getItem(key('a', 'temp')), null);
  assert.equal([...storage.values.keys()].filter(name => name.includes('document:a:')).length, 2);
});

test('revision zero is a real manifest pin, not an absent reference', async () => {
  const storage = memoryStorage(), io = createBrowserRecoveryIo(storage);
  await io.writeRecoveryDocument('a', 0, snapshot('a', 0));
  await io.writeRecoveryManifest(1, manifest(0, 1));
  await io.writeRecoveryDocument('a', 1, snapshot('a', 1));
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  assert.equal(await io.loadRecoveryDocument('a', 0), snapshot('a', 0));
});

for (const corrupt of ['broken JSON', snapshot('wrong', 99)]) {
  test(`a pinned previous copy survives an invalid current slot (${corrupt === 'broken JSON' ? 'syntax' : 'identity'})`, async () => {
    const storage = memoryStorage(), io = await committed(storage);
    await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
    storage.setItem(key('a', 'current'), corrupt);
    await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
    assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
    assert.equal(await io.loadRecoveryDocument('a', 3), snapshot('a', 3));
  });
}

test('failed manifest publication followed by a new snapshot cannot evict the committed draft', async () => {
  const storage = memoryStorage(), io = await committed(storage), setItem = storage.setItem;
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  storage.setItem = (name, value) => {
    if (name === `${BROWSER_RECOVERY_PREFIX}manifest:current`) throw new Error('publish quota');
    setItem(name, value);
  };
  await assert.rejects(io.writeRecoveryManifest(2, manifest(2)), /publish quota/);
  await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
  assert.equal(await io.loadRecoveryManifest(), manifest(1));
});

test('successful manifest publication advances the pinned revision and obsolete copies can rotate out', async () => {
  const storage = memoryStorage(), io = await committed(storage);
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  await io.writeRecoveryManifest(2, manifest(2));
  await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  await io.writeRecoveryDocument('a', 4, snapshot('a', 4));
  assert.equal(await io.loadRecoveryDocument('a', 2), snapshot('a', 2));
  assert.equal(await io.loadRecoveryDocument('a', 1), null);
  await io.deleteRecoveryDocument('a');
  assert.equal([...storage.values.keys()].some(name => name.includes('document:a:')), false);
});

test('manifest fallback remains coherent when an unpublished write retires older snapshot data', async () => {
  const storage = memoryStorage(), io = await committed(storage);
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  await io.writeRecoveryManifest(2, manifest(2));
  await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  storage.setItem(`${BROWSER_RECOVERY_PREFIX}manifest:current`, 'broken manifest');
  assert.equal(await io.loadRecoveryManifest(), manifest(2));
  assert.equal(await io.loadRecoveryDocument('a', 2), snapshot('a', 2));
});

test('failure backing up the selected manifest cannot begin snapshot rotation', async () => {
  const storage = memoryStorage(), io = await committed(storage), setItem = storage.setItem;
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  await io.writeRecoveryManifest(2, manifest(2));
  const before = [...storage.values];
  storage.setItem = (name, value) => {
    if (name === `${BROWSER_RECOVERY_PREFIX}manifest:previous`) throw new Error('manifest backup quota');
    setItem(name, value);
  };
  await assert.rejects(io.writeRecoveryDocument('a', 3, snapshot('a', 3)), /manifest backup quota/);
  assert.deepEqual([...storage.values], before);
  storage.setItem = setItem;
  await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  assert.equal(await io.loadRecoveryDocument('a', 2), snapshot('a', 2));
});

for (const failBackup of [false, true]) {
  test(`closing-document cleanup retires obsolete manifest references${failBackup ? ' after a backup quota failure' : ''}`, async () => {
    const storage = memoryStorage(), io = createBrowserRecoveryIo(storage);
    await io.writeRecoveryDocument('a', 1, snapshot('a', 1));
    await io.writeRecoveryDocument('b', 1, snapshot('b', 1));
    const both = JSON.parse(manifest(1));
    both.tabs.push({ documentId: 'b', displayName: 'b.md', snapshotRevision: 1 });
    await io.writeRecoveryManifest(1, JSON.stringify(both));
    const onlyB = { ...both, generation: 2, activeDocumentId: 'b', tabs: [both.tabs[1]] };
    await io.writeRecoveryManifest(2, JSON.stringify(onlyB));
    if (failBackup) {
      const before = [...storage.values], setItem = storage.setItem;
      storage.setItem = (name, value) => {
        if (name === `${BROWSER_RECOVERY_PREFIX}manifest:previous`) throw new Error('delete backup quota');
        setItem(name, value);
      };
      await assert.rejects(io.deleteRecoveryDocument('a'), /delete backup quota/);
      assert.deepEqual([...storage.values], before);
      storage.setItem = setItem;
    }
    await io.deleteRecoveryDocument('a');
    const afterDelete = [...storage.values];
    await io.deleteRecoveryDocument('a');
    assert.deepEqual([...storage.values], afterDelete);
    storage.setItem(`${BROWSER_RECOVERY_PREFIX}manifest:current`, 'broken manifest');
    assert.equal(await io.loadRecoveryManifest(), JSON.stringify(onlyB));
    assert.equal(await io.loadRecoveryDocument('b', 1), snapshot('b', 1));
    assert.equal(await io.loadRecoveryDocument('a', 1), null);
  });
}

test('invalid current manifest pins the previous valid manifest rather than an unpublished snapshot', async () => {
  const storage = memoryStorage(), io = await committed(storage);
  await io.writeRecoveryManifest(2, manifest(1, 2));
  storage.setItem(`${BROWSER_RECOVERY_PREFIX}manifest:current`, 'broken manifest');
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  assert.equal(await io.loadRecoveryManifest(), manifest(1));
  assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
});

for (const slot of ['temp', 'previous', 'current']) {
  test(`quota failure at ${slot} leaves the manifest-referenced copy readable after retry`, async () => {
    const storage = memoryStorage(), io = await committed(storage), setItem = storage.setItem;
    await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
    storage.setItem = (name, value) => {
      if (name === key('a', slot)) throw new Error('slot quota');
      setItem(name, value);
    };
    await assert.rejects(io.writeRecoveryDocument('a', 3, snapshot('a', 3)), /slot quota/);
    assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
    storage.setItem = setItem;
    await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
    assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
    assert.equal(storage.getItem(key('a', 'temp')), null);
  });
}

test('worker failure validating a pinned previous copy leaves every slot untouched', async () => {
  const storage = memoryStorage(), original = await committed(storage);
  await original.writeRecoveryDocument('a', 2, snapshot('a', 2));
  const before = [...storage.values];
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw === snapshot('a', 1)) return Promise.reject(new Error('pinned validation worker failed'));
    return JSON.parse(raw);
  } });
  await assert.rejects(io.writeRecoveryDocument('a', 3, snapshot('a', 3)), /pinned validation worker failed/);
  assert.deepEqual([...storage.values], before);
});

test('manifest changes during pinned-copy validation recompute which revision to preserve', async () => {
  const storage = memoryStorage(), original = await committed(storage), gate = deferred();
  await original.writeRecoveryDocument('a', 2, snapshot('a', 2));
  let held = false;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw === snapshot('a', 1) && !held) { held = true; return gate.promise; }
    return JSON.parse(raw);
  } });
  const writing = io.writeRecoveryDocument('a', 3, snapshot('a', 3));
  await settle();
  assert.equal(held, true);
  await original.writeRecoveryManifest(2, manifest(2));
  gate.resolve(JSON.parse(snapshot('a', 1)));
  await writing;
  assert.equal(await io.loadRecoveryDocument('a', 2), snapshot('a', 2));
});

test('committed revision bytes cannot be replaced, while exact retries remain idempotent', async () => {
  const storage = memoryStorage(), io = await committed(storage);
  const changed = JSON.parse(snapshot('a', 1)); changed.content = 'different bytes at a committed revision';
  const before = [...storage.values];
  await assert.rejects(io.writeRecoveryDocument('a', 1, JSON.stringify(changed)), /committed revision/);
  assert.deepEqual([...storage.values], before);
  await io.writeRecoveryDocument('a', 1, snapshot('a', 1));
  assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
  assert.deepEqual([...storage.values], before);
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  await io.writeRecoveryManifest(2, manifest(2));
  const twoCopies = [...storage.values];
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  assert.deepEqual([...storage.values], twoCopies);
  assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
});

test('incoming and current snapshot validation await the injected parser before any storage mutation', async () => {
  const storage = memoryStorage(), gate = deferred(), parsed = [];
  await seed(storage);
  const before = [...storage.values];
  const next = snapshot('a', 2);
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    parsed.push(raw);
    return raw === next ? gate.promise : JSON.parse(raw);
  } });
  const pending = io.writeRecoveryDocument('a', 2, next);
  await settle();
  assert.deepEqual(parsed, [next]);
  assert.deepEqual([...storage.values], before);
  gate.resolve(JSON.parse(next));
  await pending;
  assert.deepEqual(parsed, [next, snapshot('a', 1)]);
  assert.equal(storage.getItem(key('a', 'previous')), snapshot('a', 1));
  assert.equal(storage.getItem(key('a', 'temp')), null);
});

test('concurrent writes and a following read retain per-document call ordering', async () => {
  const storage = memoryStorage(), gate = deferred();
  const first = snapshot('a', 1), second = snapshot('a', 2);
  let held = false;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw === first && !held) { held = true; return gate.promise; }
    return JSON.parse(raw);
  } });
  const writingFirst = io.writeRecoveryDocument('a', 1, first);
  const writingSecond = io.writeRecoveryDocument('a', 2, second);
  const reading = io.loadRecoveryDocument('a', 2);
  await settle();
  assert.equal(storage.getItem(key('a', 'current')), null);
  gate.resolve(JSON.parse(first));
  await Promise.all([writingFirst, writingSecond]);
  assert.equal(await reading, second);
  assert.equal(await io.loadRecoveryDocument('a', 1), first);
});

test('deletion waits for validation and cannot be undone by a late write', async () => {
  const storage = memoryStorage(), gate = deferred();
  let entered = false;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) { entered = true; return gate.promise; } });
  const writing = io.writeRecoveryDocument('a', 1, snapshot('a', 1));
  const deleting = io.deleteRecoveryDocument('a');
  await settle();
  assert.equal(entered, true);
  gate.resolve(JSON.parse(snapshot('a', 1)));
  await Promise.all([writing, deleting]);
  assert.equal(storage.values.size, 0);
});

test('held validation for one document does not block another document', async () => {
  const storage = memoryStorage(), gate = deferred();
  let entered = false;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw === snapshot('a', 1)) { entered = true; return gate.promise; }
    return JSON.parse(raw);
  } });
  const writing = io.writeRecoveryDocument('a', 1, snapshot('a', 1));
  await settle();
  assert.equal(entered, true);
  await io.writeRecoveryDocument('b', 1, snapshot('b', 1));
  assert.equal(await io.loadRecoveryDocument('b', 1), snapshot('b', 1));
  gate.resolve(JSON.parse(snapshot('a', 1)));
  await writing;
});

test('a changed current slot is revalidated rather than replaced by a stale previous copy', async () => {
  const storage = memoryStorage(), gate = deferred(), parsed = [];
  await seed(storage);
  const first = snapshot('a', 1), second = snapshot('a', 2), third = snapshot('a', 3);
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    parsed.push(raw);
    return raw === first ? gate.promise : JSON.parse(raw);
  } });
  const writing = io.writeRecoveryDocument('a', 3, third);
  await settle();
  assert.deepEqual(parsed, [third, first]);
  storage.setItem(key('a', 'current'), second); // Another adapter/window published while validation awaited.
  gate.resolve(JSON.parse(first));
  await writing;
  assert.deepEqual(parsed, [third, first, second]);
  assert.equal(await io.loadRecoveryDocument('a', 2), second);
  assert.equal(await io.loadRecoveryDocument('a', 3), third);
});

test('repeated current-slot churn fails closed instead of retrying validation indefinitely', async () => {
  const storage = memoryStorage();
  await seed(storage);
  const incoming = snapshot('a', 9);
  let currentValidations = 0;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw !== incoming) {
      currentValidations++;
      if (currentValidations > 2) throw new Error('unexpected third validation');
      storage.setItem(key('a', 'current'), snapshot('a', currentValidations + 1));
    }
    return JSON.parse(raw);
  } });
  await assert.rejects(io.writeRecoveryDocument('a', 9, incoming), /changed during validation/);
  assert.equal(currentValidations, 2);
  assert.equal(storage.getItem(key('a', 'current')), snapshot('a', 3));
  assert.equal(storage.getItem(key('a', 'previous')), null);
  assert.equal(storage.getItem(key('a', 'temp')), null);
});

test('parser failure leaves all copies untouched, does not prevent reads, and permits retry', async () => {
  const storage = memoryStorage();
  await seed(storage);
  const before = [...storage.values];
  let failed = true, calls = 0;
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    calls++;
    if (failed) return Promise.reject(new Error('worker unavailable'));
    return JSON.parse(raw);
  } });
  await assert.rejects(io.writeRecoveryDocument('a', 2, snapshot('a', 2)), /worker unavailable/);
  assert.deepEqual([...storage.values], before);
  assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
  assert.equal(calls, 1); // Restore reads deliberately do not depend on the write parser.
  failed = false;
  await io.writeRecoveryDocument('a', 2, snapshot('a', 2));
  assert.equal(await io.loadRecoveryDocument('a', 2), snapshot('a', 2));
});

test('failure validating an existing current slot cannot evict it or its previous copy', async () => {
  const storage = memoryStorage();
  await seed(storage);
  const first = snapshot('a', 1), second = snapshot('a', 2);
  const before = [...storage.values];
  const io = createBrowserRecoveryIo(storage, { snapshotParser(raw) {
    if (raw === first) return Promise.reject(new Error('worker crashed'));
    return JSON.parse(raw);
  } });
  await assert.rejects(io.writeRecoveryDocument('a', 2, second), /worker crashed/);
  assert.deepEqual([...storage.values], before);
});

for (const corrupt of ['broken JSON', snapshot('wrong-document', 8)]) {
  test(`invalid current data preserves the valid previous slot (${corrupt === 'broken JSON' ? 'syntax' : 'identity'})`, async () => {
    const storage = memoryStorage();
    await seed(storage);
    await createBrowserRecoveryIo(storage).writeRecoveryDocument('a', 2, snapshot('a', 2));
    storage.setItem(key('a', 'current'), corrupt);
    let calls = 0;
    const io = createBrowserRecoveryIo(storage, { snapshotParser: async raw => { calls++; return JSON.parse(raw); } });
    await io.writeRecoveryDocument('a', 3, snapshot('a', 3));
    assert.equal(calls, 2);
    assert.equal(await io.loadRecoveryDocument('a', 1), snapshot('a', 1));
    assert.equal(await io.loadRecoveryDocument('a', 3), snapshot('a', 3));
  });
}

test('asynchronous validation retains quota-error cleanup and the valid previous revision', async () => {
  const storage = memoryStorage();
  await seed(storage);
  const setItem = storage.setItem;
  storage.setItem = (name, value) => {
    if (name === key('a', 'current')) throw new Error('install quota');
    setItem(name, value);
  };
  let calls = 0;
  const io = createBrowserRecoveryIo(storage, { snapshotParser: async raw => { calls++; return JSON.parse(raw); } });
  await assert.rejects(io.writeRecoveryDocument('a', 2, snapshot('a', 2)), /install quota/);
  assert.equal(calls, 2);
  assert.equal(storage.getItem(key('a', 'previous')), snapshot('a', 1));
  assert.equal(storage.getItem(key('a', 'temp')), null);
});

test('browser recovery environment forwards the write parser to persistent and fallback storage', async () => {
  for (const available of [true, false]) {
    let parsed = 0;
    const root = { get localStorage() { if (!available) throw new Error('unavailable'); return memoryStorage(); } };
    const environment = createBrowserRecoveryEnvironment(root, { snapshotParser: async raw => { parsed++; return JSON.parse(raw); } });
    await environment.io.writeRecoveryDocument('a', 1, snapshot('a', 1));
    assert.equal(parsed, 1);
    assert.equal(environment.persistent, available);
  }
});
