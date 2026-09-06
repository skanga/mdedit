(function initSessionController(root, factory) {
  const api = factory(root);

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, (root) => {
  "use strict";

  const LEGACY_DRAFT_KEY = "mdedit-draft-v1";
  const BROWSER_RECOVERY_PREFIX = "mdedit-recovery-v1:";
  const DEFAULT_INACTIVE_LOAD_CONCURRENCY = 4;
  const DEFAULT_PREVIEW_CACHE_MAX_ENTRIES = 5;
  const DEFAULT_PREVIEW_CACHE_MAX_BYTES = 20 * 1024 * 1024;

  let DocumentModel;
  let SessionModel;
  if (typeof module !== "undefined" && module.exports) {
    ({ DocumentModel } = require("./document-model.js"));
    ({ SessionModel } = require("./session-model.js"));
  } else if (root && root.MDEdit && root.MDEdit.DocumentModel && root.MDEdit.SessionModel) {
    ({ DocumentModel, SessionModel } = root.MDEdit);
  } else {
    throw new Error("DocumentModel and SessionModel are required");
  }

  function normalizeError(reason) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }

  function requireObject(value, name) {
    if (!value || typeof value !== "object") throw new TypeError(`${name} is required`);
    return value;
  }

  function requireFunction(value, name) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    return value;
  }

  function displayNameFromPath(path) {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || "untitled.md";
  }

  function onceAsync(callback) {
    if (typeof callback !== "function") return null;
    let called = false;
    let result = null;
    return function unsubscribeOnce() {
      if (called) return result;
      called = true;
      try {
        result = Promise.resolve(callback());
      } catch (reason) {
        result = Promise.reject(reason);
      }
      return result;
    };
  }

  function utf8ByteLength(value) {
    const text = String(value);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function createBrowserRecoveryIo(storage) {
    requireObject(storage, "storage");
    for (const method of ["getItem", "setItem", "removeItem", "key"]) {
      requireFunction(storage[method], `storage.${method}`);
    }
    const documentPrefix = (documentId) => `${BROWSER_RECOVERY_PREFIX}document:${encodeURIComponent(documentId)}:`;
    const slots = (prefix) => ({ current: `${prefix}current`, previous: `${prefix}previous`, temp: `${prefix}temp` });
    const valid = (raw, predicate) => {
      if (typeof raw !== "string") return null;
      try { const value = JSON.parse(raw); return predicate(value) ? raw : null; } catch (_) { return null; }
    };
    const validManifest = (raw) => valid(raw, (value) => {
      SessionModel.fromManifest(value, { idFactory: () => "validation-id" });
      return true;
    });
    const validDocument = (raw, documentId, revision) => valid(raw, (value) => {
      const document = DocumentModel.fromSnapshot(value);
      return document.id === documentId && document.snapshotRevision === revision;
    });
    const rotate = (keys, json, currentValidator) => {
      JSON.parse(json);
      storage.setItem(keys.temp, json);
      try {
        const current = currentValidator(storage.getItem(keys.current));
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
        if (typeof key === "string" && key.startsWith(prefix) && !keep.has(key)) keys.push(key);
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
        const keys = slots(documentPrefix(documentId));
        return validDocument(storage.getItem(keys.current), documentId, revision)
          || validDocument(storage.getItem(keys.previous), documentId, revision);
      },
      async writeRecoveryDocument(documentId, revision, json) {
        const keys = slots(documentPrefix(documentId));
        const text = String(json);
        const value = JSON.parse(text);
        if (value.documentId !== documentId || value.snapshotRevision !== revision) throw new Error("recovery snapshot identity mismatch");
        DocumentModel.fromSnapshot(value);
        rotate(keys, text, (raw) => {
          if (typeof raw !== "string") return null;
          try {
            const currentDocument = DocumentModel.fromSnapshot(JSON.parse(raw));
            return currentDocument.id === documentId ? raw : null;
          } catch (_) { return null; }
        });
        cleanup(documentPrefix(documentId), new Set([keys.current, keys.previous]));
      },
      async writeRecoveryManifest(generation, json) {
        const text = String(json);
        const value = JSON.parse(text);
        if (value.generation !== generation) throw new Error("recovery manifest generation mismatch");
        SessionModel.fromManifest(value, { idFactory: () => "validation-id" });
        rotate(manifestSlots, text, validManifest);
        cleanup(`${BROWSER_RECOVERY_PREFIX}manifest`, new Set([manifestSlots.current, manifestSlots.previous]));
      },
      async deleteRecoveryDocument(documentId) {
        const prefix = documentPrefix(documentId);
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
        }
        for (const key of keys) storage.removeItem(key);
      },
      async recoveryDirectory() { return "localStorage://mdedit-recovery-v1"; },
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

  function createBrowserRecoveryEnvironment(browserRoot) {
    let storage;
    let error = null;
    try {
      storage = browserRoot.localStorage;
      const probe = `${BROWSER_RECOVERY_PREFIX}probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
    } catch (reason) {
      error = normalizeError(reason);
      storage = createMemoryStorage();
    }
    return {
      io: createBrowserRecoveryIo(storage),
      legacyStorage: storage,
      persistent: error === null,
      error,
    };
  }

  class SessionController {
    constructor({
      io,
      scheduler,
      view,
      dialogs,
      legacyStorage,
      hashText,
      idFactory,
      inactiveLoadConcurrency = DEFAULT_INACTIVE_LOAD_CONCURRENCY,
      renderer,
      exporter,
      requestAnimationFrame,
      previewCacheMaxEntries = DEFAULT_PREVIEW_CACHE_MAX_ENTRIES,
      previewCacheMaxBytes = DEFAULT_PREVIEW_CACHE_MAX_BYTES,
    } = {}) {
      this.io = requireObject(io, "io");
      this.scheduler = requireObject(scheduler, "scheduler");
      this.view = requireObject(view, "view");
      this.dialogs = requireObject(dialogs, "dialogs");
      this.legacyStorage = requireObject(legacyStorage, "legacyStorage");
      this.hashText = requireFunction(hashText, "hashText");
      this.idFactory = requireFunction(idFactory, "idFactory");
      if (!Number.isSafeInteger(inactiveLoadConcurrency) || inactiveLoadConcurrency < 1) {
        throw new TypeError("inactiveLoadConcurrency must be a positive safe integer");
      }
      if (!Number.isSafeInteger(previewCacheMaxEntries) || previewCacheMaxEntries < 1) {
        throw new TypeError("previewCacheMaxEntries must be a positive safe integer");
      }
      if (!Number.isSafeInteger(previewCacheMaxBytes) || previewCacheMaxBytes < 1) {
        throw new TypeError("previewCacheMaxBytes must be a positive safe integer");
      }

      this.inactiveLoadConcurrency = inactiveLoadConcurrency;
      this.renderer = renderer;
      this.exporter = exporter;
      this.requestAnimationFrame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => callback();
      this.previewCacheMaxEntries = previewCacheMaxEntries;
      this.previewCacheMaxBytes = previewCacheMaxBytes;
      this.session = null;

      this._started = false;
      this._unlisten = null;
      this._listenerReady = Promise.resolve(null);
      this._listenerFailure = null;
      this._pendingOperations = [];
      this._activeOperations = new Set();
      this._operationChain = Promise.resolve();
      this._queuedOperationCount = 0;
      this._manifestWrites = Promise.resolve();
      this._recoveryManifestQueued = false;
      this._pendingManifestCandidates = new Set();
      this._recoveryBlocks = new Map();
      this._sessionRecoveryFailure = null;
      this._manifestBarrier = null;
      this._deferredRecoveryRevisions = new Map();
      this._restorePromise = null;
      this._restoreControl = null;
      this._restoreState = "idle";
      this._localSessionEstablished = false;
      this._lifecycleToken = 0;
      this._disposed = false;
      this._disposePromise = null;
      this._loadQueue = [];
      this._loadingIds = new Set();
      this._loadPriority = [];
      this._viewToken = 0;
      this._renderToken = 0;
      this._latestRenderTokens = new Map();
      this._previewCache = new Map();
      this._previewCacheBytes = 0;

      this.start().catch(() => {});
    }

    start() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._started) return this._listenerReady;
      this._started = true;

      const source = typeof this.io.listenFileOpened === "function"
        ? this.io
        : (typeof this.io.onFileOpened === "function" ? this.io : this.dialogs);
      const listen = source === this.io
        ? (this.io.listenFileOpened || this.io.onFileOpened)
        : (this.dialogs.listenFileOpened || this.dialogs.onFileOpened);
      if (typeof listen !== "function") return this._listenerReady;

      let registration;
      try {
        registration = listen.call(source, (event) => this._handleFileOpened(event));
      } catch (reason) {
        const error = normalizeError(reason);
        this._started = false;
        this._listenerFailure = error;
        this._listenerReady = Promise.resolve(null);
        const rejected = Promise.reject(error);
        rejected.catch(() => {});
        return rejected;
      }
      const immediateUnlisten = typeof registration === "function" ? onceAsync(registration) : null;
      if (immediateUnlisten) this._unlisten = immediateUnlisten;
      this._listenerReady = Promise.resolve(registration).then(
        (unlisten) => {
          const guardedUnlisten = immediateUnlisten || onceAsync(unlisten);
          if (this._disposed) {
            if (guardedUnlisten) {
              try {
                Promise.resolve(guardedUnlisten()).catch(() => {});
              } catch (_) {
                // Disposal remains complete even if late unsubscription fails.
              }
            }
            return null;
          }
          this._unlisten = guardedUnlisten;
          return guardedUnlisten;
        },
        (reason) => {
          const error = normalizeError(reason);
          if (this._disposed) throw error;
          this._started = false;
          this._unlisten = null;
          this._listenerFailure = error;
          this._listenerReady = Promise.resolve(null);
          throw error;
        },
      );
      this._listenerReady.catch(() => {});
      return this._listenerReady;
    }

    restore() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._restorePromise) return this._restorePromise;
      if (this._restoreState === "restored") return Promise.resolve(this.session);
      this._restoreState = "restoring";
      const token = ++this._lifecycleToken;
      let resolveRestore;
      let rejectRestore;
      let settled = false;
      const publicPromise = new Promise((resolve, reject) => {
        resolveRestore = resolve;
        rejectRestore = reject;
      });
      publicPromise.catch(() => {});
      const control = {
        token,
        promise: publicPromise,
        resolve(value) {
          if (settled) return;
          settled = true;
          resolveRestore(value);
        },
        reject(reason) {
          if (settled) return;
          settled = true;
          rejectRestore(reason);
        },
      };
      this._restoreControl = control;
      this._restorePromise = publicPromise;
      Promise.resolve(this._restore(token)).then(
        (session) => {
          if (this._restoreControl === control) this._restoreControl = null;
          control.resolve(session);
        },
        (reason) => {
          if (this._isLifecycleActive(token)) {
            this._restoreState = "idle";
            this._restorePromise = null;
            this._rejectPendingOperations(reason);
          }
          if (this._restoreControl === control) this._restoreControl = null;
          control.reject(reason);
        },
      );
      return publicPromise;
    }

    async _restore(token) {
      const earlierListenerFailure = this._listenerFailure;
      this._listenerFailure = null;
      try {
        await this.start();
      } catch (reason) {
        if (this._isLifecycleActive(token)) {
          if (this._listenerFailure === reason) this._listenerFailure = null;
          this._showRecoveryError(reason, { phase: "file-open-listener" });
        }
      }
      if (earlierListenerFailure) {
        this._showRecoveryError(earlierListenerFailure, { phase: "file-open-listener" });
      }
      if (!this._isLifecycleActive(token)) return this.session;
      if (this._localSessionEstablished) return this._finishRestore(token);

      let rawManifest;
      try {
        rawManifest = await this.io.loadRecoveryManifest();
      } catch (reason) {
        if (!this._isLifecycleActive(token)) return this.session;
        this._showRecoveryError(reason, { phase: "manifest" });
        this._assignEmptySession(token);
        return this._finishRestore(token);
      }
      if (!this._isLifecycleActive(token)) return this.session;

      if (rawManifest === null) {
        await this.importLegacyDraft(token);
        if (!this._isLifecycleActive(token)) return this.session;
        if (!this.session) this._assignEmptySession(token);
      } else {
        try {
          await this.restoreManifest(rawManifest, token);
        } catch (reason) {
          if (!this._isLifecycleActive(token)) return this.session;
          this._showRecoveryError(reason, { phase: "manifest" });
          this._assignEmptySession(token);
        }
      }
      return this._finishRestore(token);
    }

    async _finishRestore(token) {
      try {
        while (this._isLifecycleActive(token)) {
          while (this._pendingOperations.length > 0) {
            const request = this._pendingOperations.shift();
            this._activeOperations.add(request);
            try {
              request.resolve(await request.run(token));
            } catch (reason) {
              request.reject(reason);
            } finally {
              this._activeOperations.delete(request);
            }
            if (!this._isLifecycleActive(token)) return this.session;
          }

          if (!this.session || this.session.documents.size === 0) this._createFreshSession(token);
          if (this._pendingOperations.length > 0) continue;

          // No asynchronous boundary is allowed between this final empty-queue
          // check and publishing restored. Follow-up work therefore either joins
          // the drain above or enters the normal serialized operation queue.
          this._restoreState = "restored";
          const needsInitialCheckpoint = [...this.session.documents.values()].some(
            (document) => document instanceof DocumentModel
              && document.persistedRevision < document.snapshotRevision,
          );
          if (needsInitialCheckpoint) {
            this._persistManifestNow(token).catch((reason) => {
              if (!this._isLifecycleActive(token)) return;
              const active = this.activeDocument();
              this._showRecoveryError(reason, {
                phase: "initial-checkpoint",
                documentId: active && active.id,
                displayName: active && active.displayName,
                snapshotRevision: active && active.snapshotRevision,
              });
            });
          }
          return this.session;
        }
        return this.session;
      } catch (reason) {
        if (this._isLifecycleActive(token)) {
          this._rejectPendingOperations(reason);
          this._restoreState = "idle";
        }
        throw reason;
      }
    }

    async restoreManifest(rawManifest, token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
      const manifest = typeof rawManifest === "string" ? JSON.parse(rawManifest) : rawManifest;
      const session = SessionModel.fromManifest(manifest, { idFactory: this.idFactory });
      if (!this._isLifecycleActive(token)) return session;
      this.session = session;

      for (const stub of session.documents.values()) stub.loadStatus = "loading";
      this._renderSession();

      const initiallyActiveId = session.activeDocumentId;
      await this.loadSnapshot(initiallyActiveId, token, session);
      if (!this._isLifecycleActive(token) || this.session !== session) return session;

      const inactiveIds = session.tabOrder.filter((id) => id !== initiallyActiveId);
      const prioritizedIds = this._loadPriority.filter((id) => inactiveIds.includes(id));
      const prioritizedSet = new Set(prioritizedIds);
      this._loadQueue = [
        ...prioritizedIds,
        ...inactiveIds.filter((id) => !prioritizedSet.has(id)),
      ];
      this._loadPriority = [];

      const workerCount = Math.min(this.inactiveLoadConcurrency, this._loadQueue.length);
      const workers = Array.from({ length: workerCount }, () => this._loadWorker(token, session));
      await Promise.all(workers);
      if (!this._isLifecycleActive(token) || this.session !== session) return session;
      this._loadQueue = [];
      return session;
    }

    async _loadWorker(token, session) {
      while (this._isLifecycleActive(token) && this.session === session && this._loadQueue.length > 0) {
        const id = this._loadQueue.shift();
        this._loadingIds.add(id);
        try {
          await this.loadSnapshot(id, token, session);
        } finally {
          if (this._isLifecycleActive(token)) this._loadingIds.delete(id);
        }
      }
    }

    async loadSnapshot(documentOrId, token = this._lifecycleToken, session = this.session) {
      if (!this._isLifecycleActive(token)) return null;
      if (!session) throw new Error("session has not been restored");
      const id = typeof documentOrId === "string" ? documentOrId : documentOrId && documentOrId.id;
      const stub = session.documents.get(id);
      if (!stub) throw new Error("unknown document id");
      const expectedRevision = stub.snapshotRevision;

      try {
        const rawSnapshot = await this.io.loadRecoveryDocument(id, expectedRevision);
        if (!this._isLifecycleActive(token) || this.session !== session) return null;
        const value = typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot;
        const document = DocumentModel.fromSnapshot(value);
        if (document.id !== id) throw new Error(`recovery snapshot identity mismatch for ${id}`);
        if (document.snapshotRevision !== expectedRevision) {
          throw new Error(`recovery snapshot revision mismatch for ${id}`);
        }
        const contentSha256 = await this.hashText(document.content);
        if (!this._isLifecycleActive(token) || this.session !== session) return null;
        document.reconcileDirty(contentSha256, document.editRevision);

        const canonicalOwner = document.canonicalPath === null
          ? null
          : session.findByCanonicalPath(document.canonicalPath);
        if (canonicalOwner && canonicalOwner.id !== id) {
          throw new Error(`recovery snapshot canonical path is already owned by ${canonicalOwner.id}`);
        }
        if (session.documents.get(id) !== stub) {
          throw new Error(`recovery snapshot identity changed while loading ${id}`);
        }

        document.loadStatus = "loaded";
        session.documents.set(id, document);
        if (typeof this.scheduler.markPersisted === "function") {
          this.scheduler.markPersisted(id, document.snapshotRevision);
        }
        this._renderSession();
        if (session.activeDocumentId === id) this._renderDocument(document);
        return document;
      } catch (reason) {
        if (!this._isLifecycleActive(token) || this.session !== session) return null;
        const error = normalizeError(reason);
        if (session.documents.get(id) === stub) {
          stub.loadStatus = "failed";
          stub.loadError = error;
        }
        this._renderSession();
        if (session.activeDocumentId === id) this._renderDocument(stub);
        this._showRecoveryError(error, {
          phase: "snapshot",
          documentId: id,
          displayName: stub.displayName,
          snapshotRevision: expectedRevision,
        });
        return null;
      }
    }

    async importLegacyDraft(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) return null;
      const previousSession = this.session;
      let document = null;
      let durable = false;
      try {
        const rawDraft = this.legacyStorage.getItem(LEGACY_DRAFT_KEY);
        if (!rawDraft) return null;
        const draft = JSON.parse(rawDraft);
        if (!draft || typeof draft !== "object" || Array.isArray(draft)
            || typeof draft.text !== "string" || !draft.text.trim()) {
          throw new TypeError("invalid legacy draft");
        }

        const savedContentSha256 = await this.hashText("");
        if (!this._isLifecycleActive(token)) return null;
        document = new DocumentModel({
          id: this.idFactory(),
          displayName: typeof draft.name === "string" && draft.name.length > 0 ? draft.name : "untitled.md",
          path: null,
          canonicalPath: null,
          content: draft.text,
          editRevision: 1,
          persistedRevision: -1,
          snapshotRevision: 0,
          savedContentSha256,
          expectedDiskSha256: null,
          fileStatus: "normal",
          dirty: true,
          recoveryStatus: "pending",
        });
        const migrationSession = new SessionModel({ idFactory: this.idFactory });
        migrationSession.add(document);
        this.session = migrationSession;
        await this._persistManifestNow(token);
        if (!this._isLifecycleActive(token)) return null;
        durable = true;
        try {
          this.legacyStorage.removeItem(LEGACY_DRAFT_KEY);
        } catch (reason) {
          this._showRecoveryError(reason, {
            phase: "legacy-cleanup",
            documentId: document.id,
            displayName: document.displayName,
            snapshotRevision: document.snapshotRevision,
          });
        }
        this._renderSession();
        this._renderDocument(document);
        return document;
      } catch (reason) {
        if (durable || !this._isLifecycleActive(token)) return document;
        if (document && typeof this.scheduler.forget === "function") {
          try {
            this.scheduler.forget(document.id);
          } catch (_) {
            // Rollback remains best-effort after the migration failure.
          }
        }
        this.session = previousSession;
        this._showRecoveryError(reason, {
          phase: "legacy-migration",
          documentId: document && document.id,
          displayName: document && document.displayName,
          snapshotRevision: document && document.snapshotRevision,
        });
        return null;
      }
    }

    openPaths(paths) {
      if (this._disposed) {
        return Promise.resolve(this._disposedOpenResult(Array.isArray(paths) ? paths : []));
      }
      if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
      const copiedPaths = [...paths];
      return this._scheduleOperation(
        (token) => this._openPathsNow(copiedPaths, token),
        (resolve) => resolve(this._disposedOpenResult(copiedPaths)),
      );
    }

    async _openPathsNow(paths, token = this._lifecycleToken) {
      const opened = [];
      const openedIds = new Set();
      const failed = [];

      for (const path of paths) {
        if (!this._isLifecycleActive(token)) {
          failed.push({ path, error: new Error("session controller is disposed") });
          continue;
        }
        try {
          const result = await this.io.readDocument(path);
          if (!this._isLifecycleActive(token)) {
            failed.push({ path, error: new Error("session controller is disposed") });
            continue;
          }
          const document = this._openReadResultNow(result, token);
          if (!openedIds.has(document.id)) {
            openedIds.add(document.id);
            opened.push(document);
          }
        } catch (reason) {
          const error = normalizeError(reason);
          failed.push({ path, error });
          this._showOpenError(path, error);
        }
      }
      return { opened, failed };
    }

    _disposedOpenResult(paths) {
      return {
        opened: [],
        failed: paths.map((path) => ({ path, error: new Error("session controller is disposed") })),
      };
    }

    _scheduleOperation(run, onDispose) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      const request = this._createOperationRequest(run, onDispose);
      if (this._restoreState === "restored") return this._queueRestoredOperation(request);

      this._pendingOperations.push(request);

      if (this._restoreState === "idle") {
        this.restore().catch((reason) => {
          const index = this._pendingOperations.indexOf(request);
          if (index >= 0) this._pendingOperations.splice(index, 1);
          request.reject(reason);
        });
      }
      return request.promise;
    }

    _createOperationRequest(run, onDispose) {
      let request;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        request = {
          run,
          promise: null,
          isSettled() { return settled; },
          resolve(value) {
            if (settled) return;
            settled = true;
            resolvePromise(value);
          },
          reject(reason) {
            if (settled) return;
            settled = true;
            rejectPromise(reason);
          },
          dispose() {
            if (settled) return;
            if (onDispose) onDispose(request.resolve, request.reject);
            else request.reject(new Error("session controller is disposed"));
          },
        };
      });
      promise.catch(() => {});
      request.promise = promise;
      return request;
    }

    _queueRestoredOperation(request) {
      const token = this._lifecycleToken;
      this._queuedOperationCount += 1;
      this._activeOperations.add(request);
      const operation = this._operationChain.catch(() => {}).then(async () => {
        let failed = false;
        let result;
        try {
          if (!request.isSettled()) {
            if (!this._isLifecycleActive(token)) request.dispose();
            else result = await request.run(token);
          }
        } catch (reason) {
          failed = true;
          result = reason;
        }

        // Clear busy bookkeeping before exposing completion to the caller, so
        // a follow-up synchronous document mutation has deterministic timing.
        this._activeOperations.delete(request);
        this._queuedOperationCount -= 1;
        if (failed) request.reject(result);
        else request.resolve(result);
      });
      this._operationChain = operation;
      return request.promise;
    }

    _rejectPendingOperations(reason) {
      while (this._pendingOperations.length > 0) {
        this._pendingOperations.shift().reject(reason);
      }
    }

    _canMutateSynchronously() {
      const sessionIsUsable = this._restoreState === "restored"
        || (this._restoreState === "idle" && this._localSessionEstablished);
      return !this._disposed
        && sessionIsUsable
        && this._queuedOperationCount === 0;
    }

    openReadResult(result) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (!result || typeof result !== "object") throw new TypeError("read result is required");
      if (typeof result.canonicalPath !== "string" || result.canonicalPath.length === 0) {
        throw new TypeError("read result canonicalPath must be a non-empty string");
      }
      if (this._restoreState === "idle" && !this._localSessionEstablished) {
        return this._openLocalReadResult(result);
      }
      if (this._canMutateSynchronously()) return this._openReadResultNow(result, this._lifecycleToken);
      // Active recovery is the exceptional asynchronous phase: queue the model
      // creation so recovery cannot overwrite it.
      return this._scheduleOperation((token) => this._openReadResultNow(result, token));
    }

    _openReadResultNow(result, token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
      const session = this._ensureSession();
      const existing = session.findByCanonicalPath(result.canonicalPath);
      if (existing) {
        this.activateDocument(existing.id);
        return existing;
      }
      const outgoing = this.activeDocument();
      this._captureAndFlushOutgoing(outgoing);
      const document = this._documentFromReadResult(result);
      session.add(document);
      this._presentActivatedDocument(document);
      return document;
    }

    _documentFromReadResult(result) {
      if (typeof result.path !== "string" || result.path.length === 0) {
        throw new TypeError("read result path must be a non-empty string");
      }
      return new DocumentModel({
        id: this.idFactory(),
        displayName: displayNameFromPath(result.path),
        path: result.path,
        canonicalPath: result.canonicalPath,
        content: result.content,
        editRevision: 0,
        persistedRevision: -1,
        snapshotRevision: 0,
        savedContentSha256: result.sha256,
        expectedDiskSha256: result.sha256,
        fileStatus: "normal",
        dirty: false,
        recoveryStatus: "clean",
      });
    }

    _openLocalReadResult(result) {
      const candidate = new SessionModel({ idFactory: this.idFactory });
      const document = this._documentFromReadResult(result);
      candidate.add(document);
      this._commitLocalSession(candidate);
      this._presentActivatedDocument(document);
      return document;
    }

    activateDocument(id, options = {}) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
      const outgoing = this.activeDocument();
      if (outgoing && outgoing.id !== id) this._captureAndFlushOutgoing(outgoing);
      const document = this.session.activate(id);
      if (!(document instanceof DocumentModel)) {
        const queuedIndex = this._loadQueue.indexOf(id);
        if (queuedIndex >= 0) {
          this._loadQueue.splice(queuedIndex, 1);
          this._loadQueue.unshift(id);
        } else if (!this._loadingIds.has(id)) {
          const priorityIndex = this._loadPriority.indexOf(id);
          if (priorityIndex >= 0) this._loadPriority.splice(priorityIndex, 1);
          this._loadPriority.unshift(id);
        }
      }
      this._presentActivatedDocument(document, options);
      return document;
    }

    activate(id) {
      return this.activateDocument(id);
    }

    activeDocument() {
      if (this._disposed) return null;
      if (!this.session || this.session.activeDocumentId === null) return null;
      return this.session.documents.get(this.session.activeDocumentId) || null;
    }

    captureActiveDocument(extra = {}) {
      if (this._disposed) throw new Error("session controller is disposed");
      const document = this.activeDocument();
      if (!(document instanceof DocumentModel)) throw new Error("there is no loaded active document");
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
        throw new TypeError("capture metadata must be an object");
      }
      return Object.freeze({
        ...extra,
        documentId: document.id,
        editRevision: document.editRevision,
        content: document.content,
        displayName: document.displayName,
        path: document.path,
        canonicalPath: document.canonicalPath,
        document,
      });
    }

    isDocumentCaptureCurrent(capture, { requireActive = false } = {}) {
      if (!capture || typeof capture !== "object") return false;
      if (!this._ownsOperationCapture(capture)) return false;
      return capture.document.editRevision === capture.editRevision
        && (!requireActive || this.session.activeDocumentId === capture.documentId);
    }

    canPrintCapture(capture, previewOwner) {
      return this.isDocumentCaptureCurrent(capture, { requireActive: true })
        && Boolean(previewOwner)
        && previewOwner.documentId === capture.documentId
        && previewOwner.editRevision === capture.editRevision;
    }

    runCapturedExport(label, operation) {
      if (typeof label !== "string" || label.length === 0) {
        return Promise.reject(new TypeError("export label is required"));
      }
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("export operation must be a function"));
      }
      const capture = this.captureActiveDocument();
      return this._runCapturedExport(capture, label, operation);
    }

    onEditorInput(documentId, content) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
      const document = this.session.documents.get(documentId);
      if (!(document instanceof DocumentModel)) throw new Error("unknown or unloaded document id");
      const changed = document.applyContent(content);
      if (!changed) return false;

      this._invalidatePreview(documentId);
      this._scheduleRecoveryRevision(document);
      this._setDocumentStatus(documentId, {
        dirty: document.dirty,
        fileStatus: document.fileStatus,
        recoveryStatus: document.recoveryStatus,
      });
      if (this.session.activeDocumentId === documentId) {
        this.renderDocument(documentId).catch((reason) => {
          this._setDocumentStatus(documentId, {
            status: "failed",
            message: `Preview failed for ${document.displayName}: ${normalizeError(reason).message}`,
          });
        });
      }
      return true;
    }

    onRecoveryStatus(documentId, status, error) {
      const document = this.session && this.session.documents.get(documentId);
      if (this._sessionRecoveryFailure) {
        this._publishBlockedStatus(document);
        return;
      }
      if (document instanceof DocumentModel) document.recoveryStatus = status;
      this._setDocumentStatus(documentId, { recoveryStatus: status, message: error && error.message });
      const covered = document instanceof DocumentModel && [...this._pendingManifestCandidates].some(
        (candidate) => (candidate.get(documentId) ?? -1) >= document.snapshotRevision,
      );
      if (status === "clean" && this._restoreState === "restored" && !covered) this._queueRecoveryManifest();
    }

    _queueRecoveryManifest() {
      if (this._recoveryManifestQueued || this._disposed) return;
      this._recoveryManifestQueued = true;
      Promise.resolve().then(() => {
        this._recoveryManifestQueued = false;
        if (this._disposed || this._restoreState !== "restored") return;
        this._persistManifestNow().catch((reason) => this._showRecoveryError(reason, { phase: "recovery-checkpoint" }));
      });
    }

    async retryRecovery(documentId) {
      const ids = this.session ? [...this.session.documents.keys()] : (documentId ? [documentId] : []);
      this._manifestBarrier = { retry: true };
      for (const id of ids) {
        if (typeof this.scheduler.retry === "function") {
          try { await this.scheduler.retry(id); } catch (_) { /* latest immutable retry below owns reporting */ }
        }
      }
      try {
        let result = false;
        while (!result) result = await this._persistManifestNow(this._lifecycleToken, { allowBlocked: true });
        this._sessionRecoveryFailure = null;
        this._recoveryBlocks.clear();
        this._releaseManifestBarrier(true);
        return result;
      } catch (reason) {
        for (const id of ids) this._blockRecovery(id, reason);
        throw reason;
      }
    }

    _blockRecovery(documentId, reason) {
      const error = normalizeError(reason);
      const document = this.session && this.session.documents.get(documentId);
      const message = `Recovery failed for ${document ? document.displayName : documentId}: ${error.message}`;
      this._recoveryBlocks.set(documentId, { error, message });
      this._sessionRecoveryFailure = error;
      if (document instanceof DocumentModel) document.recoveryStatus = "failed";
      this._setDocumentStatus(documentId, { recoveryStatus: "failed", message });
    }

    _publishBlockedStatus(document) {
      if (!(document instanceof DocumentModel) || !this._sessionRecoveryFailure) return;
      document.recoveryStatus = "failed";
      this._setDocumentStatus(document.id, {
        recoveryStatus: "failed",
        message: `Recovery failed for this session: ${this._sessionRecoveryFailure.message}`,
      });
    }

    _scheduleRecoveryRevision(document) {
      if (!(document instanceof DocumentModel)) return false;
      if (this._manifestBarrier) {
        const previous = this._deferredRecoveryRevisions.get(document.id) ?? -1;
        this._deferredRecoveryRevisions.set(document.id, Math.max(previous, document.snapshotRevision));
        if (this._sessionRecoveryFailure) this._publishBlockedStatus(document);
        return false;
      }
      if (this._sessionRecoveryFailure) {
        this._publishBlockedStatus(document);
        return false;
      }
      this.scheduler.changed(document.id, document.snapshotRevision);
      return true;
    }

    _releaseManifestBarrier(scheduleDeferred) {
      this._manifestBarrier = null;
      if (!scheduleDeferred || this._sessionRecoveryFailure) return;
      const deferred = [...this._deferredRecoveryRevisions];
      this._deferredRecoveryRevisions.clear();
      for (const [id, revision] of deferred) {
        const document = this.session && this.session.documents.get(id);
        if (!(document instanceof DocumentModel)) continue;
        if (revision <= document.persistedRevision) {
          document.recoveryStatus = "clean";
          this._setDocumentStatus(id, { recoveryStatus: "clean" });
          continue;
        }
        document.recoveryStatus = "pending";
        this.scheduler.changed(id, Math.max(revision, document.snapshotRevision));
        this._setDocumentStatus(id, { recoveryStatus: "pending" });
      }
      for (const document of this.session ? this.session.documents.values() : []) {
        if (!(document instanceof DocumentModel) || this._deferredRecoveryRevisions.has(document.id)) continue;
        if (document.recoveryStatus === "failed") document.recoveryStatus = "clean";
        this._setDocumentStatus(document.id, { recoveryStatus: document.recoveryStatus });
      }
    }

    renderDocument(documentId = this.session && this.session.activeDocumentId) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      const document = this.session.documents.get(documentId);
      if (!(document instanceof DocumentModel)) return Promise.resolve(null);
      if (!this.renderer) return Promise.resolve(null);

      const token = ++this._renderToken;
      const optionsKey = this._rendererOptionsKey();
      const capture = Object.freeze({
        token,
        documentId: document.id,
        editRevision: document.editRevision,
        content: document.content,
        displayName: document.displayName,
        optionsKey,
        document,
      });
      this._latestRenderTokens.set(document.id, token);
      const cacheKey = this._previewCacheKey(capture);
      const cached = this._previewCache.get(cacheKey);
      if (cached) {
        this._touchPreviewCache(cacheKey, cached);
        if (this._canCommitRender(capture)) this._setPreview(cached.html, capture);
        return Promise.resolve(cached.html);
      }

      if (this.session.activeDocumentId === document.id && typeof this.view.clearPreview === "function") {
        this.view.clearPreview(capture);
      }
      let rendering;
      try {
        const render = typeof this.renderer === "function" ? this.renderer : this.renderer.render;
        if (typeof render !== "function") throw new TypeError("renderer must be a function or provide render");
        rendering = render.call(this.renderer, capture);
      } catch (reason) {
        return Promise.reject(reason);
      }
      return Promise.resolve(rendering).then((result) => {
        if (result && typeof result === "object" && typeof result.commit === "function") {
          if (!this._canCommitRender(capture)) return null;
          return Promise.resolve(result.commit(capture, () => this._canCommitRender(capture))).then((html) => {
            if (!this._isCurrentRender(capture) || typeof html !== "string") return null;
            this._storePreview(cacheKey, document.id, html);
            return html;
          });
        }
        const html = result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "html")
          ? result.html
          : result;
        if (typeof html !== "string") throw new TypeError("renderer result must be HTML text");
        if (!this._isCurrentRender(capture)) return null;
        this._storePreview(cacheKey, document.id, html);
        if (this._canCommitRender(capture)) this._setPreview(html, capture);
        return html;
      });
    }

    async exportActive(format) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.exporter) throw new Error("exporter is unavailable");
      if (typeof format !== "string" || format.length === 0) throw new TypeError("export format is required");

      const capture = this.captureActiveDocument({ format });
      const exportDocument = typeof this.exporter === "function" ? this.exporter : this.exporter.export;
      if (typeof exportDocument !== "function") throw new TypeError("exporter must be a function or provide export");
      return this._runCapturedExport(
        capture,
        capture.displayName,
        async () => {
          let exportCapture = capture;
          if (format === "html" || format === "png") {
            const renderForExport = this.renderer && this.renderer.renderForExport;
            if (typeof renderForExport !== "function") {
              throw new Error(`isolated ${format.toUpperCase()} export renderer is unavailable`);
            }
            const renderedHtml = await renderForExport.call(this.renderer, capture);
            if (typeof renderedHtml !== "string" || renderedHtml.length === 0) {
              throw new Error(`isolated ${format.toUpperCase()} export produced no HTML`);
            }
            exportCapture = Object.freeze({ ...capture, renderedHtml });
          }
          return exportDocument.call(this.exporter, exportCapture);
        },
      );
    }

    recordCapturedSave(capture, result) {
      if (!this._ownsOperationCapture(capture)) return false;
      const changed = capture.document.recordSave({
        editRevision: capture.editRevision,
        contentSha256: result && result.contentSha256,
        diskSha256: result && result.diskSha256,
      });
      const needsCheckpoint = changed
        || capture.document.persistedRevision < capture.document.snapshotRevision;
      if (needsCheckpoint) this._scheduleRecoveryRevision(capture.document);
      this._setDocumentStatus(capture.documentId, {
        dirty: capture.document.dirty,
        fileStatus: capture.document.fileStatus,
        recoveryStatus: capture.document.recoveryStatus,
      });
      if (needsCheckpoint && this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => this._showRecoveryError(reason, {
          phase: "save-checkpoint",
          documentId: capture.documentId,
          displayName: capture.displayName,
          snapshotRevision: capture.document.snapshotRevision,
        }));
      }
      return true;
    }

    checkpointDocument(documentId, phase = "metadata-checkpoint") {
      if (this._disposed || !this.session) return false;
      const document = this.session.documents.get(documentId);
      if (!(document instanceof DocumentModel)) return false;
      if (!this._scheduleRecoveryRevision(document)) return false;
      if (this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => this._showRecoveryError(reason, {
          phase,
          documentId,
          displayName: document.displayName,
          snapshotRevision: document.snapshotRevision,
        }));
      }
      return true;
    }

    async _runCapturedExport(capture, label, operation) {
      this._setDocumentStatus(capture.documentId, {
        status: "exporting",
        message: `Exporting ${label}`,
        editRevision: capture.editRevision,
      });
      try {
        const result = await operation(
          capture,
          (options) => this.isDocumentCaptureCurrent(capture, options),
        );
        if (this.isDocumentCaptureCurrent(capture)) {
          const message = result && typeof result.message === "string"
            ? result.message
            : `Exported ${label}`;
          this._setDocumentStatus(capture.documentId, {
            status: "exported",
            message,
            editRevision: capture.editRevision,
          });
        }
        return result;
      } catch (reason) {
        const error = normalizeError(reason);
        if (this._ownsOperationCapture(capture)) {
          this._setDocumentStatus(capture.documentId, {
            status: "failed",
            message: `Could not export ${label}: ${error.message}`,
            editRevision: capture.editRevision,
          });
        }
        throw error;
      }
    }

    closeDocument(documentId) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
      const document = this.session.documents.get(documentId);
      if (!document) throw new Error("unknown document id");
      if (document.dirty) return false;
      if (this.session.activeDocumentId === documentId) this._captureAndFlushOutgoing(document);
      const { nextActiveId } = this.session.remove(documentId);
      this._invalidatePreview(documentId);
      this._latestRenderTokens.delete(documentId);
      if (typeof this.scheduler.forget === "function") this.scheduler.forget(documentId);
      if (typeof this.view.removeEditor === "function") this.view.removeEditor(documentId);
      if (nextActiveId === null) {
        this._createUntitledNow();
      } else {
        this._presentActivatedDocument(this.session.documents.get(nextActiveId));
      }
      return true;
    }

    createUntitled() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._restoreState === "idle" && !this._localSessionEstablished) {
        const candidate = new SessionModel({ idFactory: this.idFactory });
        const document = candidate.createUntitled();
        this._commitLocalSession(candidate);
        this._presentActivatedDocument(document);
        return document;
      }
      if (this._canMutateSynchronously()) return this._createUntitledNow(this._lifecycleToken);
      // Active recovery is the exceptional asynchronous phase: queue the model
      // creation until recovery owns a stable session.
      return this._scheduleOperation((token) => this._createUntitledNow(token));
    }

    _createUntitledNow(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
      const session = this._ensureSession();
      const outgoing = this.activeDocument();
      this._captureAndFlushOutgoing(outgoing);
      const document = session.createUntitled();
      this._presentActivatedDocument(document);
      return document;
    }

    persistManifest() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._localSessionEstablished && this._restoreState !== "restored") {
        if (this._restoreState === "idle") this.restore();
        return this._scheduleOperation((token) => this._persistManifestNow(token));
      }
      if (this._restoreState !== "restored") {
        const restoring = this._restoreState === "idle" ? this.restore() : this._restorePromise;
        return restoring.then(() => {
          if (this._disposed) throw new Error("session controller is disposed");
          return this._scheduleOperation((token) => this._persistManifestNow(token));
        });
      }
      return this._scheduleOperation((token) => this._persistManifestNow(token));
    }

    _persistManifestNow(token = this._lifecycleToken, { allowBlocked = false } = {}) {
      if (!this._isLifecycleActive(token)) return Promise.reject(new Error("session controller is disposed"));
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      const candidateSession = this.session;
      const candidate = JSON.parse(JSON.stringify(candidateSession.toManifest()));
      const capturedDocuments = candidate.tabs.map((tab) => ({
        document: candidateSession.documents.get(tab.documentId),
        documentId: tab.documentId,
        snapshotRevision: tab.snapshotRevision,
      }));
      if (!allowBlocked && this._sessionRecoveryFailure) return Promise.reject(this._sessionRecoveryFailure);
      const coverage = new Map(capturedDocuments.map((capture) => [capture.documentId, capture.snapshotRevision]));
      this._pendingManifestCandidates.add(coverage);
      const json = JSON.stringify(candidate);
      const write = this._manifestWrites.catch(() => {}).then(
        async () => {
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          if (!allowBlocked && this._sessionRecoveryFailure) throw this._sessionRecoveryFailure;
          for (const capture of capturedDocuments) {
            if (!(capture.document instanceof DocumentModel)) continue;
            this.scheduler.changed(capture.documentId, capture.snapshotRevision);
            await this.scheduler.flush(capture.documentId, capture.snapshotRevision);
            if (this.session.documents.get(capture.documentId) === capture.document
                && capture.document.snapshotRevision === capture.snapshotRevision) {
              capture.document.persistedRevision = Math.max(capture.document.persistedRevision, capture.snapshotRevision);
            }
          }
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          const obsolete = this.session !== candidateSession
            || capturedDocuments.some((capture) => this.session.documents.get(capture.documentId) !== capture.document
              || capture.document.snapshotRevision !== capture.snapshotRevision)
            || JSON.stringify(this.session.toManifest()) !== json;
          if (obsolete) {
            if (!allowBlocked) this._queueRecoveryManifest();
            return false;
          }
          if (!this._manifestBarrier) this._manifestBarrier = { candidate: coverage };
          try {
            await this.io.writeRecoveryManifest(candidate.generation, json);
            this._releaseManifestBarrier(true);
          } catch (reason) {
            this._manifestBarrier = null;
            for (const document of this.session.documents.values()) this._blockRecovery(document.id, reason);
            throw reason;
          }
          return true;
        },
      );
      const trackedWrite = write.finally(() => this._pendingManifestCandidates.delete(coverage));
      this._manifestWrites = trackedWrite;
      return trackedWrite;
    }

    _ensureSession() {
      if (!this.session) this.session = new SessionModel({ idFactory: this.idFactory });
      return this.session;
    }

    _commitLocalSession(session) {
      this.session = session;
      this._localSessionEstablished = true;
    }

    _createFreshSession(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) return null;
      this.session = new SessionModel({ idFactory: this.idFactory });
      return this._createUntitledNow(token);
    }

    _assignEmptySession(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) return null;
      this.session = new SessionModel({ idFactory: this.idFactory });
      return this.session;
    }

    _captureAndFlushOutgoing(document) {
      if (!(document instanceof DocumentModel)) return;
      if (typeof this.view.captureWorkspace === "function") {
        try {
          const captured = this.view.captureWorkspace(document.id);
          document.updateWorkspace({
            ...document.workspace,
            ...(captured || {}),
            find: {
              ...document.workspace.find,
              ...((captured && captured.find) || {}),
            },
          });
          this._scheduleRecoveryRevision(document);
        } catch (reason) {
          this._setDocumentStatus(document.id, {
            status: "failed",
            message: `Could not capture ${document.displayName} workspace: ${normalizeError(reason).message}`,
          });
        }
      }

      let flushing;
      if (this._sessionRecoveryFailure || this._manifestBarrier) return;
      try {
        flushing = this.scheduler.flush(document.id, document.snapshotRevision);
      } catch (reason) {
        flushing = Promise.reject(reason);
      }
      Promise.resolve(flushing).catch((reason) => {
        const error = normalizeError(reason);
        if (!this.session || this.session.documents.get(document.id) !== document) return;
        this._setDocumentStatus(document.id, {
          recoveryStatus: "failed",
          message: `Recovery flush failed for ${document.displayName}: ${error.message}`,
        });
        this._showRecoveryError(error, {
          phase: "activation-flush",
          documentId: document.id,
          displayName: document.displayName,
          snapshotRevision: document.snapshotRevision,
        });
      });
    }

    _presentActivatedDocument(document, { focusEditor = true } = {}) {
      if (this._disposed || !document) return;
      if (document instanceof DocumentModel && (this._manifestBarrier || this._sessionRecoveryFailure)) {
        this._scheduleRecoveryRevision(document);
      }
      const id = document.id;
      const viewToken = ++this._viewToken;
      this._renderSession();
      if (document instanceof DocumentModel && typeof this.view.ensureEditor === "function") {
        const editor = this.view.ensureEditor(document);
        if (editor && typeof editor.value === "string" && editor.value !== document.content) {
          editor.value = document.content;
        }
      }
      if (typeof this.view.activateEditor === "function") this.view.activateEditor(id);
      this._renderDocumentView(document);
      this.requestAnimationFrame(() => {
        if (this._disposed || viewToken !== this._viewToken || !this.session
            || this.session.activeDocumentId !== id || this.session.documents.get(id) !== document) return;
        if (document instanceof DocumentModel && typeof this.view.applyWorkspace === "function") {
          this.view.applyWorkspace(id, document.workspace);
        }
        if (focusEditor && typeof this.view.focusActiveEditor === "function") this.view.focusActiveEditor();
      });
      if (this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => {
          if (!this.session || this.session.documents.get(id) !== document) return;
          this._showRecoveryError(reason, {
            phase: "manifest-selection",
            documentId: id,
            displayName: document.displayName,
            snapshotRevision: document.snapshotRevision,
          });
        });
      }
      this.renderDocument(id).catch((reason) => {
        if (!this.session || this.session.documents.get(id) !== document) return;
        this._setDocumentStatus(id, {
          status: "failed",
          message: `Preview failed for ${document.displayName}: ${normalizeError(reason).message}`,
        });
      });
    }

    _rendererOptionsKey() {
      if (!this.renderer) return "";
      const value = typeof this.renderer.optionsKey === "function"
        ? this.renderer.optionsKey()
        : this.renderer.optionsKey;
      return value === undefined || value === null ? "" : String(value);
    }

    _previewCacheKey(capture) {
      return `${capture.documentId}\u0000${capture.editRevision}\u0000${capture.optionsKey}`;
    }

    _isCurrentRender(capture) {
      if (this._disposed || !this.session) return false;
      const document = this.session.documents.get(capture.documentId);
      return document === capture.document
        && document.editRevision === capture.editRevision
        && this._latestRenderTokens.get(capture.documentId) === capture.token;
    }

    _canCommitRender(capture) {
      return this._isCurrentRender(capture)
        && this.session.activeDocumentId === capture.documentId;
    }

    _ownsOperationCapture(capture) {
      return !this._disposed && this.session
        && this.session.documents.get(capture.documentId) === capture.document;
    }

    _setPreview(html, capture) {
      if (typeof this.view.setPreview === "function") this.view.setPreview(html, capture);
      else if (typeof this.view.renderPreview === "function") this.view.renderPreview(html, capture);
    }

    _setDocumentStatus(documentId, status) {
      if (typeof this.view.setDocumentStatus === "function") this.view.setDocumentStatus(documentId, status);
    }

    _touchPreviewCache(key, entry) {
      this._previewCache.delete(key);
      this._previewCache.set(key, entry);
    }

    _storePreview(key, documentId, html) {
      const bytes = utf8ByteLength(html);
      const old = this._previewCache.get(key);
      if (old) this._previewCacheBytes -= old.bytes;
      this._previewCache.delete(key);
      if (bytes > this.previewCacheMaxBytes) return;
      this._previewCache.set(key, { documentId, html, bytes });
      this._previewCacheBytes += bytes;
      while (this._previewCache.size > this.previewCacheMaxEntries
          || this._previewCacheBytes > this.previewCacheMaxBytes) {
        const oldestKey = this._previewCache.keys().next().value;
        const oldest = this._previewCache.get(oldestKey);
        this._previewCache.delete(oldestKey);
        this._previewCacheBytes -= oldest.bytes;
      }
    }

    _invalidatePreview(documentId) {
      for (const [key, entry] of this._previewCache) {
        if (entry.documentId !== documentId) continue;
        this._previewCache.delete(key);
        this._previewCacheBytes -= entry.bytes;
      }
    }

    _renderSession() {
      if (this._disposed) return;
      if (typeof this.view.renderSession === "function") this.view.renderSession(this.session);
      else if (typeof this.view.renderTabs === "function") this.view.renderTabs(this.session);
    }

    _renderDocument(document) {
      if (this._disposed) return;
      this._renderDocumentView(document);
    }

    _renderDocumentView(document) {
      if (this._disposed) return;
      if (typeof this.view.renderDocument === "function") this.view.renderDocument(document, this.session);
      else if (typeof this.view.showDocument === "function") this.view.showDocument(document, this.session);
      else if (typeof this.view.activateDocument === "function") this.view.activateDocument(document, this.session);
    }

    _showRecoveryError(reason, context) {
      const error = normalizeError(reason);
      if (context && context.documentId) {
        this._setDocumentStatus(context.documentId, {
          recoveryStatus: "failed",
          message: `Recovery failed for ${context.displayName || context.documentId}: ${error.message}`,
        });
      }
      const details = {
        ...context,
        error,
        message: error.message,
        recoveryDirectory: null,
      };
      const reporting = Promise.resolve().then(async () => {
        try {
          details.recoveryDirectory = await this.io.recoveryDirectory();
        } catch (_) {
          // The original recovery failure remains the useful error.
        }
        if (this._disposed || typeof this.view.showRecoveryError !== "function") return;
        try {
          Promise.resolve(this.view.showRecoveryError(details)).catch(() => {});
        } catch (_) {
          // Recovery presentation is best-effort and cannot block restoration.
        }
      });
      reporting.catch(() => {});
      return details;
    }

    _showOpenError(path, error) {
      if (typeof this.dialogs.showOpenError !== "function") return;
      try {
        Promise.resolve(this.dialogs.showOpenError(path, error)).catch(() => {});
      } catch (_) {
        // Dialog failures must not block the remaining selected files.
      }
    }

    _handleFileOpened(event) {
      const path = typeof event === "string" ? event : event && event.payload;
      if (this._disposed || typeof path !== "string" || path.length === 0) return Promise.resolve();
      return this.openPaths([path]);
    }

    dispose() {
      if (this._disposePromise) return this._disposePromise;
      this._disposed = true;
      this._lifecycleToken += 1;
      this._restoreState = "disposed";
      this._loadQueue = [];
      this._loadPriority = [];
      this._loadingIds.clear();
      while (this._pendingOperations.length > 0) {
        this._pendingOperations.shift().dispose();
      }
      for (const request of this._activeOperations) request.dispose();
      this._activeOperations.clear();
      if (this._restoreControl) {
        this._restoreControl.reject(new Error("session controller is disposed"));
        this._restoreControl = null;
      }

      this._disposePromise = (async () => {
        const unlisten = this._unlisten;
        this._unlisten = null;
        this._started = false;
        this._listenerReady = Promise.resolve(null);
        if (typeof unlisten === "function") await Promise.resolve(unlisten());
      })();
      return this._disposePromise;
    }

    destroy() {
      return this.dispose();
    }

    _isLifecycleActive(token) {
      return !this._disposed && token === this._lifecycleToken;
    }
  }

  return {
    SessionController,
    LEGACY_DRAFT_KEY,
    BROWSER_RECOVERY_PREFIX,
    createBrowserRecoveryIo,
    createBrowserRecoveryEnvironment,
  };
});
