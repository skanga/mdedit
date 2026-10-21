(function(root, factory) {
  const models = typeof module !== 'undefined' && module.exports
    ? { ...require('./document-model.js'), ...require('./session-model.js') } : root.MDEdit;
  const api = factory(models);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, (models) => {
  'use strict';
  const { DocumentModel, SessionModel } = models;
  const BROWSER_RECOVERY_PREFIX = 'mdedit-recovery-v1:';

  function createBrowserRecoveryIo(storage, { snapshotParser = JSON.parse } = {}) {
    if (typeof snapshotParser !== 'function') throw new TypeError('snapshotParser must be a function');
    if (!storage || typeof storage !== 'object') throw new TypeError('storage is required');
    for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
      if (typeof storage[method] !== 'function') throw new TypeError(`storage.${method} must be a function`);
    }
    const documentOperations = new Map();
    function ordered(documentId, operation) {
      const previous = documentOperations.get(documentId) || Promise.resolve();
      const result = previous.catch(() => {}).then(operation);
      documentOperations.set(documentId, result);
      const release = () => { if (documentOperations.get(documentId) === result) documentOperations.delete(documentId); };
      result.then(release, release);
      return result;
    }
    const documentPrefix = (documentId) => `${BROWSER_RECOVERY_PREFIX}document:${encodeURIComponent(documentId)}:`;
    const slots = (prefix) => ({ current: `${prefix}current`, previous: `${prefix}previous`, temp: `${prefix}temp` });
    const valid = (raw, predicate) => {
      if (typeof raw !== 'string') return null;
      try { const value = JSON.parse(raw); return predicate(value) ? raw : null; } catch (_) { return null; }
    };
    const validManifest = (raw) => valid(raw, (value) => {
      SessionModel.fromManifest(value, { idFactory: () => 'validation-id' });
      return true;
    });
    const validDocument = (raw, documentId, revision) => valid(raw, (value) => {
      const document = DocumentModel.fromSnapshot(value);
      return document.id === documentId && document.snapshotRevision === revision;
    });
    async function validStoredDocument(raw, documentId) {
      if (typeof raw !== 'string') return null;
      let value;
      try { value = await snapshotParser(raw); }
      catch (error) {
        if (error && error.name === 'SyntaxError') return null;
        throw error; // Worker failure is not evidence that stored data is corrupt.
      }
      try {
        const document = DocumentModel.fromSnapshot(value);
        return document.id === documentId ? { raw, revision: document.snapshotRevision } : null;
      } catch (_) { return null; }
    }
    function retentionState(keys) {
      return { current: storage.getItem(keys.current), previous: storage.getItem(keys.previous),
        manifest: storage.getItem(manifestSlots.current), previousManifest: storage.getItem(manifestSlots.previous) };
    }
    async function retainedDocument(state, documentId) {
      const manifestBackup = validManifest(state.manifest);
      const manifest = manifestBackup || validManifest(state.previousManifest);
      const revision = manifest === null ? null
        : JSON.parse(manifest).tabs.find(tab => tab.documentId === documentId)?.snapshotRevision ?? null;
      const current = await validStoredDocument(state.current, documentId);
      let pinned = current && current.revision === revision ? current : null;
      if (revision !== null && !pinned) {
        const previous = await validStoredDocument(state.previous, documentId);
        if (previous && previous.revision === revision) pinned = previous;
      }
      return { retained: pinned || current, pinned, manifestBackup };
    }
    function backupManifest(current, previous) {
      if (current && current !== previous) storage.setItem(manifestSlots.previous, current);
    }
    const rotate = (keys, json, current) => {
      // All decoding/validation finishes before this synchronous commit starts.
      storage.setItem(keys.temp, json);
      try {
        if (current !== null) storage.setItem(keys.previous, current);
        storage.setItem(keys.current, json);
      } finally {
        storage.removeItem(keys.temp);
      }
    };
    const cleanup = (prefix, keep) => {
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === 'string' && key.startsWith(prefix) && !keep.has(key)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    };
    const manifestSlots = slots(`${BROWSER_RECOVERY_PREFIX}manifest:`);
    return {
      listenFileOpened() { return () => {}; },
      async loadRecoveryManifest() {
        return validManifest(storage.getItem(manifestSlots.current)) || validManifest(storage.getItem(manifestSlots.previous));
      },
      async loadRecoveryDocument(documentId, revision) {
        return ordered(documentId, () => {
          const keys = slots(documentPrefix(documentId));
          // Recovery reads remain independent of worker availability.
          return validDocument(storage.getItem(keys.current), documentId, revision)
            || validDocument(storage.getItem(keys.previous), documentId, revision);
        });
      },
      async writeRecoveryDocument(documentId, revision, json) {
        const text = String(json);
        return ordered(documentId, async () => {
          const keys = slots(documentPrefix(documentId));
          const value = await snapshotParser(text);
          if (value.documentId !== documentId || value.snapshotRevision !== revision) throw new Error('recovery snapshot identity mismatch');
          DocumentModel.fromSnapshot(value);
          // A newer current slot may be an orphan from a failed publication.
          // Retain the manifest's copy, not simply the last snapshot written.
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = retentionState(keys);
            const { retained, pinned, manifestBackup } = await retainedDocument(before, documentId);
            const after = retentionState(keys);
            if (!Object.keys(before).every(key => before[key] === after[key])) continue;
            if (pinned && pinned.revision === revision && pinned.raw !== text) {
              throw new Error('Cannot replace a committed revision with different snapshot bytes');
            }
            // Exact retries must not rotate away an older fallback copy.
            if (before.current !== text) {
              // Retiring older snapshot data also retires its old manifest.
              // A backup of the selected current manifest still references the
              // copy we are preserving, even if current metadata later corrupts.
              backupManifest(manifestBackup, before.previousManifest);
              rotate(keys, text, retained ? retained.raw : null);
            }
            cleanup(documentPrefix(documentId), new Set([keys.current, keys.previous]));
            return;
          }
          throw new Error('Recovery storage changed during validation; retry recovery');
        });
      },
      async writeRecoveryManifest(generation, json) {
        const text = String(json);
        const value = JSON.parse(text);
        if (value.generation !== generation) throw new Error('recovery manifest generation mismatch');
        SessionModel.fromManifest(value, { idFactory: () => 'validation-id' });
        rotate(manifestSlots, text, validManifest(storage.getItem(manifestSlots.current)));
        cleanup(`${BROWSER_RECOVERY_PREFIX}manifest`, new Set([manifestSlots.current, manifestSlots.previous]));
      },
      async deleteRecoveryDocument(documentId) {
        return ordered(documentId, () => {
          const prefix = documentPrefix(documentId);
          const keys = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
          }
          if (keys.length) {
            const manifest = validManifest(storage.getItem(manifestSlots.current));
            // Managed deletion follows publication of the document's removal.
            // Its older fallback header must retire before the data does.
            if (manifest && !JSON.parse(manifest).tabs.some(tab => tab.documentId === documentId)) {
              backupManifest(manifest, storage.getItem(manifestSlots.previous));
            }
          }
          for (const key of keys) storage.removeItem(key);
        });
      },
      async recoveryDirectory() { return 'localStorage://mdedit-recovery-v1'; },
    };
  }

  function createMemoryStorage() {
    const values = new Map();
    return {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(String(key), String(value)); },
      removeItem(key) { values.delete(key); },
    };
  }

  function createBrowserRecoveryEnvironment(browserRoot, options) {
    let storage;
    let error = null;
    try {
      storage = browserRoot.localStorage;
      const probe = `${BROWSER_RECOVERY_PREFIX}probe`;
      storage.setItem(probe, '1');
      storage.removeItem(probe);
    } catch (reason) {
      error = reason instanceof Error ? reason : new Error(String(reason));
      storage = createMemoryStorage();
    }
    return {
      io: createBrowserRecoveryIo(storage, options),
      legacyStorage: storage,
      persistent: error === null,
      error,
    };
  }
  return { BROWSER_RECOVERY_PREFIX, createBrowserRecoveryIo, createBrowserRecoveryEnvironment };
});
