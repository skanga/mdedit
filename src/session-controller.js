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

  function isMissingFileError(reason) {
    const codes = reason && typeof reason === "object"
      ? [reason.code, reason.kind, reason.name].map((value) => String(value || ""))
      : [];
    const message = reason instanceof Error ? reason.message : String(reason || "");
    if (codes.some((code) => ["NotFound", "NotFoundError", "ENOENT"].includes(code))) return true;
    if (/^failed to read document .+: (?:No such file or directory(?: \(os error 2\))?|The system cannot find the file specified\.?(?: \(os error [23]\))?)$/i.test(message)) return true;
    if (/^failed to canonicalize parent for document path .+: (?:No such file or directory(?: \(os error 2\))?|The system cannot find the path specified\.? \(os error 3\))$/i.test(message)) return true;
    return /^document .+ is a dangling symlink$/i.test(message);
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

  function createNativeCloseRequestHandler(controller, currentWindow) {
    requireObject(controller, "controller");
    requireObject(currentWindow, "currentWindow");
    requireFunction(controller.allowNativeClose, "controller.allowNativeClose");
    requireFunction(controller.requestQuit, "controller.requestQuit");
    requireFunction(currentWindow.close, "currentWindow.close");
    let closeRequest = null;

    return function handleNativeCloseRequest(event) {
      if (controller.allowNativeClose()) return Promise.resolve({ allowClose: true, authorized: true });
      requireObject(event, "close event");
      requireFunction(event.preventDefault, "close event.preventDefault");
      event.preventDefault();
      if (closeRequest) return closeRequest;

      closeRequest = (async () => {
        const result = await controller.requestQuit();
        if (!result || !result.allowClose) return result;
        try {
          await currentWindow.close();
          return result;
        } catch (reason) {
          if (typeof controller.disallowNativeClose === "function") controller.disallowNativeClose();
          else controller.allowNativeClose();
          return { ...result, allowClose: false, error: normalizeError(reason) };
        }
      })();
      const request = closeRequest;
      return request.then(
        (result) => {
          if (closeRequest === request) closeRequest = null;
          return result;
        },
        (reason) => {
          if (closeRequest === request) closeRequest = null;
          throw reason;
        },
      );
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
      onRecoveryPerformance = () => {},
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
      this.onRecoveryPerformance = requireFunction(onRecoveryPerformance, "onRecoveryPerformance");
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
      this._retryCatchUpNeeded = false;
      this._durableRecoveryTabs = new Map();
      this._checkpointWrites = Promise.resolve();
      this._pendingRecoveryDeletions = new Set();
      this._restorePromise = null;
      this._restoreControl = null;
      this._restoreState = "idle";
      this.restoreOutcome = "pending";
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
      this._reservedCanonicalPaths = new Map();
      this._browserFileIdentities = new WeakMap();
      this._browserSourcesByDocument = new Map();
      this._browserSourceReservations = new Map();
      this._startupPlaceholderId = null;
      this._documentOperation = null;
      this._nativeCloseAllowed = false;

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
      if (this._localSessionEstablished) {
        if (this.restoreOutcome === "pending") this.restoreOutcome = "local-session";
        return this._finishRestore(token);
      }

      let rawManifest;
      try {
        rawManifest = await this.io.loadRecoveryManifest();
      } catch (reason) {
        if (!this._isLifecycleActive(token)) return this.session;
        this.restoreOutcome = "recovery-fallback";
        this._showRecoveryError(reason, { phase: "manifest" });
        this._assignEmptySession(token);
        return this._finishRestore(token);
      }
      if (!this._isLifecycleActive(token)) return this.session;

      if (rawManifest === null) {
        this.restoreOutcome = "fresh-session";
        await this.importLegacyDraft(token);
        if (!this._isLifecycleActive(token)) return this.session;
        if (!this.session) this._assignEmptySession(token);
      } else {
        try {
          this.restoreOutcome = "restored-session";
          await this.restoreManifest(rawManifest, token);
        } catch (reason) {
          if (!this._isLifecycleActive(token)) return this.session;
          this.restoreOutcome = "recovery-fallback";
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
      this._rememberDurableManifest(manifest);

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

      const firstLoadedId = session.tabOrder.find(
        (id) => session.documents.get(id) instanceof DocumentModel,
      );
      if (!firstLoadedId) {
        this.restoreOutcome = "recovery-fallback";
        const fallback = this._createFreshSession(token);
        this._renderSession();
        this._renderDocument(fallback);
        return this.session;
      }
      if (!(session.documents.get(session.activeDocumentId) instanceof DocumentModel)) {
        session.activate(firstLoadedId);
        this._renderSession();
        this._renderDocument(session.documents.get(firstLoadedId));
      }
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

        if (document.path !== null && document.expectedDiskSha256 !== null
            && typeof this.io.readDocument === "function") {
          try {
            const disk = await this.io.readDocument(document.path);
            document.fileStatus = disk && disk.sha256 === document.expectedDiskSha256
              ? "normal" : "externally-changed";
          } catch (reason) {
            document.fileStatus = isMissingFileError(reason) ? "missing" : "read-error";
          }
          if (!this._isLifecycleActive(token) || this.session !== session) return null;
        }

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
        if (typeof this.view.ensureEditor === "function") this.view.ensureEditor(document);
        if (typeof this.scheduler.markPersisted === "function") {
          this.scheduler.markPersisted(id, document.snapshotRevision);
        }
        this._renderSession();
        if (session.activeDocumentId === id) this._renderDocument(document);
        this._setDocumentStatus(id, {
          dirty: document.dirty,
          fileStatus: document.fileStatus,
          recoveryStatus: document.recoveryStatus,
        });
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
        this.restoreOutcome = "recovery-fallback";
        const rawDraft = this.legacyStorage.getItem(LEGACY_DRAFT_KEY);
        if (rawDraft === null) {
          this.restoreOutcome = "fresh-session";
          return null;
        }
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
        this.restoreOutcome = "legacy-session";
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

    openPaths(paths, options = {}) {
      if (this._disposed) {
        return Promise.resolve(this._disposedOpenResult(Array.isArray(paths) ? paths : []));
      }
      if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
      const copiedPaths = [...paths];
      const replaceStartupPlaceholder = options.replaceStartupPlaceholder === true;
      return this._scheduleOperation(
        (token) => this._openPathsNow(copiedPaths, token, { replaceStartupPlaceholder }),
        (resolve) => resolve(this._disposedOpenResult(copiedPaths)),
      );
    }

    openBrowserFiles(files, sourceKeys = []) {
      const batch = (async () => {
        const resolvedFiles = await files;
        const copiedFiles = resolvedFiles === null || resolvedFiles === undefined ? [] : Array.from(resolvedFiles);
        const resolvedSourceKeys = await sourceKeys;
        return {
          files: copiedFiles,
          sourceKeys: resolvedSourceKeys === null || resolvedSourceKeys === undefined
            ? [] : Array.from(resolvedSourceKeys),
        };
      })();
      batch.catch(() => {});
      if (this._disposed) {
        return Promise.reject(new Error("session controller is disposed"));
      }
      return this._scheduleOperation(
        (token) => this._openBrowserFilesNow(batch, token),
        (_resolve, reject) => reject(new Error("session controller is disposed")),
      );
    }

    async _openBrowserFilesNow(batch, token = this._lifecycleToken) {
      const { files, sourceKeys } = await batch;
      const opened = [];
      const openedIds = new Set();
      const failed = [];
      const failedSources = new Set();
      const results = [];

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const suppliedSource = sourceKeys[index];
        const sourceKey = suppliedSource && (typeof suppliedSource === "object" || typeof suppliedSource === "function")
          ? suppliedSource : file;
        try {
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          if (!file || typeof file !== "object" || typeof file.text !== "function") {
            throw new TypeError("browser file must provide text()");
          }
          const content = String(await file.text()).replace(/\r\n/g, "\n");
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          const sha256 = await this.hashText(content);
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          const reservation = await this._browserReservationForSource(sourceKey, token);
          if (reservation) {
            const settlement = await reservation.settled;
            if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
            if (settlement.committed) {
              const document = this.session && this.session.documents.get(reservation.documentId);
              if (document) {
                this.activateDocument(document.id);
                results.push({
                  file, sourceKey, document, id: document.id, existing: true, reserved: true, error: null,
                });
                if (!openedIds.has(document.id)) { openedIds.add(document.id); opened.push(document); }
                continue;
              }
            }
          }
          let canonicalPath = await this._canonicalForBrowserSource(sourceKey, token);
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          if (!canonicalPath) {
            canonicalPath = `browser-file:${this.idFactory()}`;
            this._browserFileIdentities.set(sourceKey, canonicalPath);
          }
          const session = this._ensureSession();
          const existing = Boolean(session.findByCanonicalPath(canonicalPath));
          const document = this._openReadResultNow({
            browserFile: true,
            path: null,
            canonicalPath,
            displayName: typeof file.name === "string" && file.name ? file.name : "untitled.md",
            content,
            sha256,
          }, token, { replaceStartupPlaceholder: true });
          this._rememberBrowserSource(document.id, sourceKey);
          if (sourceKey !== file) {
            this._browserFileIdentities.set(file, canonicalPath);
            this._rememberBrowserSource(document.id, file);
          }
          results.push({ file, sourceKey, document, id: document.id, existing, error: null });
          if (!openedIds.has(document.id)) {
            openedIds.add(document.id);
            opened.push(document);
          }
        } catch (reason) {
          const error = normalizeError(reason);
          results.push({ file, sourceKey, document: null, id: null, existing: false, error });
          if (!failedSources.has(sourceKey)) {
            failedSources.add(sourceKey);
            failed.push({ file, error });
          }
          if (this._isLifecycleActive(token)) this._showOpenError(file && file.name ? file.name : "browser file", error);
        }
      }
      return { opened, failed, results };
    }

    _disposedBrowserOpenResult(files) {
      const error = new Error("session controller is disposed");
      const seen = new Set();
      return {
        opened: [],
        failed: files.filter((file) => {
          if (seen.has(file)) return false;
          seen.add(file);
          return true;
        }).map((file) => ({ file, error })),
        results: files.map((file) => ({
          file, sourceKey: file, document: null, id: null, existing: false, error,
        })),
      };
    }

    _rememberBrowserSource(documentId, sourceKey) {
      let sources = this._browserSourcesByDocument.get(documentId);
      if (!sources) {
        sources = new Set();
        this._browserSourcesByDocument.set(documentId, sources);
      }
      sources.add(sourceKey);
    }

    async _canonicalForBrowserSource(sourceKey, token = this._lifecycleToken) {
      const exact = this._browserFileIdentities.get(sourceKey);
      if (exact) return exact;
      for (const sources of this._browserSourcesByDocument.values()) {
        for (const candidate of sources) {
          const equivalent = await this._browserSourcesEquivalent(sourceKey, candidate);
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          if (!equivalent) continue;
          const canonicalPath = this._browserFileIdentities.get(candidate);
          if (canonicalPath) {
            this._browserFileIdentities.set(sourceKey, canonicalPath);
            return canonicalPath;
          }
        }
      }
      return null;
    }

    async _browserSourcesEquivalent(left, right) {
      if (left === right) return true;
      if (left && typeof left.isSameEntry === "function") {
        try {
          if (await left.isSameEntry(right)) return true;
        } catch (_) {
          // A handle may reject one comparison direction; try the reciprocal.
        }
      }
      if (right && typeof right.isSameEntry === "function") {
        try {
          if (await right.isSameEntry(left)) return true;
        } catch (_) {
          // An unavailable or rejected comparator does not establish identity.
        }
      }
      return false;
    }

    async _browserReservationForSource(sourceKey, token = this._lifecycleToken) {
      for (const reservation of this._browserSourceReservations.values()) {
        for (const candidate of reservation.sourceKeys) {
          if (await this._browserSourcesEquivalent(sourceKey, candidate)) return reservation;
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
        }
      }
      return null;
    }

    reserveBrowserSource(documentId, ...sourceKeys) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      return this._scheduleOperation((token) => this._reserveBrowserSourceNow(documentId, sourceKeys, token));
    }

    async _reserveBrowserSourceNow(documentId, sourceKeys, token = this._lifecycleToken) {
      const document = this._requireLoadedDocument(documentId);
      const validSources = sourceKeys.filter((source) => source && typeof source === "object");
      if (!validSources.length) throw new TypeError("browser source is required");
      for (const source of validSources) {
        const canonicalPath = await this._canonicalForBrowserSource(source, token);
        const owner = canonicalPath && this.session.findByCanonicalPath(canonicalPath);
        if (owner && owner.id !== documentId) {
          this.activateDocument(owner.id);
          return { reserved: false, collision: true, document: owner, id: owner.id };
        }
        const held = await this._browserReservationForSource(source, token);
        if (held && held.documentId !== documentId) {
          const heldDocument = this.session.documents.get(held.documentId);
          if (heldDocument) this.activateDocument(heldDocument.id);
          return { reserved: false, collision: true, document: heldDocument || null, id: held.documentId };
        }
      }
      const reservation = {
        id: `browser-reservation:${this.idFactory()}`,
        documentId,
        canonicalPath: document.canonicalPath || `browser-file:${this.idFactory()}`,
        sourceKeys: validSources,
      };
      reservation.settled = new Promise((resolve) => { reservation.settle = resolve; });
      this._browserSourceReservations.set(reservation.id, reservation);
      return { reserved: true, collision: false, reservation };
    }

    commitBrowserSourceReservation(reservation, ...sourceKeys) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      try {
        const held = reservation && this._browserSourceReservations.get(reservation.id);
        if (!held || held !== reservation) throw new Error("browser source reservation is not active");
        const document = this._requireLoadedDocument(held.documentId);
        this._forgetBrowserSources(document.id);
        const sources = [...held.sourceKeys, ...sourceKeys].filter((source) => source && typeof source === "object");
        if (document.canonicalPath !== held.canonicalPath) document.updateMetadata({ canonicalPath: held.canonicalPath });
        for (const source of sources) {
          this._browserFileIdentities.set(source, held.canonicalPath);
          this._rememberBrowserSource(document.id, source);
        }
        this._browserSourceReservations.delete(held.id);
        this._scheduleRecoveryRevision(document);
        this._renderSession();
        held.settle({ committed: true, documentId: document.id, canonicalPath: held.canonicalPath });
        return Promise.resolve(document);
      } catch (reason) {
        return Promise.reject(reason);
      }
    }

    releaseBrowserSourceReservation(reservation) {
      if (!reservation || !reservation.id) return Promise.resolve(false);
      const held = this._browserSourceReservations.get(reservation.id);
      if (!held || held !== reservation) return Promise.resolve(false);
      this._browserSourceReservations.delete(held.id);
      held.settle({ committed: false });
      return Promise.resolve(true);
    }

    rebindBrowserSource(documentId, ...sourceKeys) {
      return this.reserveBrowserSource(documentId, ...sourceKeys).then((result) => {
        if (!result.reserved) return result;
        return this.commitBrowserSourceReservation(result.reservation);
      });
    }

    bindBrowserSource(documentId, ...sourceKeys) {
      return this.rebindBrowserSource(documentId, ...sourceKeys);
    }

    _forgetBrowserSources(documentId) {
      const sources = this._browserSourcesByDocument.get(documentId);
      if (!sources) return;
      for (const source of sources) this._browserFileIdentities.delete(source);
      this._browserSourcesByDocument.delete(documentId);
    }

    _discardStartupPlaceholder() {
      const id = this._startupPlaceholderId;
      const session = this.session;
      const document = id && session && session.documents.get(id);
      if (!(document instanceof DocumentModel) || session.documents.size !== 1
          || document.dirty || document.canonicalPath !== null || document.path !== null) return false;
      session.remove(id);
      this._startupPlaceholderId = null;
      this._pendingRecoveryDeletions.add(id);
      this._invalidatePreview(id);
      this._latestRenderTokens.delete(id);
      if (typeof this.scheduler.forget === "function") this.scheduler.forget(id);
      if (typeof this.view.removeEditor === "function") this.view.removeEditor(id);
      return true;
    }

    async _openPathsNow(paths, token = this._lifecycleToken, { replaceStartupPlaceholder = false } = {}) {
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
          const document = this._openReadResultNow(result, token, { replaceStartupPlaceholder });
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

    _openReadResultNow(result, token = this._lifecycleToken, { replaceStartupPlaceholder = false } = {}) {
      if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
      const session = this._ensureSession();
      const existing = session.findByCanonicalPath(result.canonicalPath);
      if (existing) {
        this.activateDocument(existing.id);
        return existing;
      }
      const reserved = this._reservedCanonicalPaths.get(result.canonicalPath);
      if (reserved && session.documents.get(reserved.id) === reserved) {
        this.activateDocument(reserved.id);
        return reserved;
      }
      if (replaceStartupPlaceholder) this._discardStartupPlaceholder();
      const outgoing = this.activeDocument();
      this._captureAndFlushOutgoing(outgoing);
      const document = this._documentFromReadResult(result);
      session.add(document);
      this._presentActivatedDocument(document);
      return document;
    }

    _documentFromReadResult(result) {
      const browserFile = result.browserFile === true;
      if ((!browserFile && (typeof result.path !== "string" || result.path.length === 0))
          || (browserFile && result.path !== null)) {
        throw new TypeError("read result path must be a non-empty string");
      }
      return new DocumentModel({
        id: this.idFactory(),
        displayName: typeof result.displayName === "string" && result.displayName
          ? result.displayName
          : displayNameFromPath(result.path),
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

    activateAdjacentDocument(delta, options = {}) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session || this.session.tabOrder.length === 0) throw new Error("session has not been created");
      if (!Number.isSafeInteger(delta)) throw new TypeError("delta must be a safe integer");
      const current = this.session.tabOrder.indexOf(this.session.activeDocumentId);
      const length = this.session.tabOrder.length;
      const next = ((current + delta) % length + length) % length;
      const nextId = this.session.tabOrder[next];
      if (nextId === this.session.activeDocumentId) return this.activeDocument();
      return this.activateDocument(nextId, options);
    }

    cycleActiveDocument(delta, options = {}) {
      return this.activateAdjacentDocument(delta, options);
    }

    moveActiveDocument(delta) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session || this.session.activeDocumentId === null) throw new Error("session has not been created");
      if (!Number.isSafeInteger(delta)) throw new TypeError("delta must be a safe integer");
      const generation = this.session.generation;
      const document = this.session.move(this.session.activeDocumentId, delta);
      if (this.session.generation === generation) return document;
      this._renderSession();
      if (typeof this.view.announceActiveDocument === "function") {
        this.view.announceActiveDocument(document, this.session);
      }
      if (this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => {
          if (!this.session || this.session.documents.get(document.id) !== document) return;
          this._showRecoveryError(reason, {
            phase: "manifest-tab-order",
            documentId: document.id,
            displayName: document.displayName,
            snapshotRevision: document.snapshotRevision,
          });
        });
      }
      return document;
    }

    reorderDocument(documentId, targetDocumentId) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
      const sourceIndex = this.session.tabOrder.indexOf(documentId);
      const targetIndex = this.session.tabOrder.indexOf(targetDocumentId);
      if (sourceIndex < 0 || targetIndex < 0) return null;
      const generation = this.session.generation;
      const document = this.session.move(documentId, targetIndex - sourceIndex);
      if (this.session.generation === generation) return document;
      this._renderSession();
      if (typeof this.view.announceTabReorder === "function") {
        this.view.announceTabReorder(document, this.session);
      }
      if (this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => {
          if (!this.session || this.session.documents.get(document.id) !== document) return;
          this._showRecoveryError(reason, {
            phase: "manifest-tab-order",
            documentId: document.id,
            displayName: document.displayName,
            snapshotRevision: document.snapshotRevision,
          });
        });
      }
      return document;
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
      if (this._manifestBarrier && this._deferredRecoveryRevisions.has(documentId)) {
        if (document instanceof DocumentModel) document.recoveryStatus = "pending";
        this._setDocumentStatus(documentId, { recoveryStatus: "pending" });
        return;
      }
      if (document instanceof DocumentModel) document.recoveryStatus = status;
      this._setDocumentStatus(documentId, { recoveryStatus: status, message: error && error.message });
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
      try {
        if (this._manifestBarrier) await this._manifestWrites.catch(() => {});
        this._retryCatchUpNeeded = false;
        const result = await this._persistManifestNow(this._lifecycleToken, {
          allowBlocked: true,
          retryScheduler: true,
        });
        this._sessionRecoveryFailure = null;
        this._recoveryBlocks.clear();
        this._releaseManifestBarrier(true);
        if (this._retryCatchUpNeeded) this._queueRecoveryManifest();
        this._retryCatchUpNeeded = false;
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

    recoverySnapshotForWrite(documentId, revision) {
      const snapshot = this._manifestBarrier && this._manifestBarrier.snapshots
        && this._manifestBarrier.snapshots.get(documentId);
      return snapshot && snapshot.revision === revision ? snapshot.json : null;
    }

    writeRecoveryCheckpoint(documentId, snapshotRevision) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      if (this._sessionRecoveryFailure) return Promise.reject(this._sessionRecoveryFailure);
      const document = this.session.documents.get(documentId);
      if (!(document instanceof DocumentModel) || document.snapshotRevision !== snapshotRevision) {
        return Promise.resolve(false);
      }
      const serializationStartedAt = Date.now();
      const snapshotJson = JSON.stringify(document.toSnapshot());
      const capture = Object.freeze({
        document,
        documentId,
        snapshotRevision,
        json: snapshotJson,
        serializationDurationMs: Date.now() - serializationStartedAt,
        tab: Object.freeze({
          documentId,
          displayName: document.displayName,
          snapshotRevision,
        }),
      });
      let barrier = this._manifestBarrier;
      if (!barrier) {
        let resolveCompletion;
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        barrier = {
          snapshots: new Map(),
          needsCatchUp: false,
          catchUpPromise: null,
          allowBlocked: false,
          externalCheckpoint: true,
          pending: 0,
          completion,
          resolveCompletion,
        };
        this._manifestBarrier = barrier;
      }
      barrier.snapshots.set(documentId, { revision: snapshotRevision, json: capture.json });
      barrier.pending += 1;
      const operation = this._checkpointWrites.catch(() => {}).then(
        () => this._writeRecoveryCheckpointNow(capture),
      );
      this._checkpointWrites = operation;
      return operation.finally(() => {
        barrier.pending -= 1;
        if (barrier.pending !== 0) return;
        if (this._manifestBarrier === barrier) this._releaseManifestBarrier(true);
        barrier.resolveCompletion();
      });
    }

    async _writeRecoveryCheckpointNow(capture) {
      if (!this.session || this.session.documents.get(capture.documentId) !== capture.document) return false;
      try {
        const writeMetrics = await this.io.writeRecoveryDocument(
          capture.documentId, capture.snapshotRevision, capture.json,
        );
        if (writeMetrics && Number.isFinite(writeMetrics.ipcAndNativeDurationMs)) {
          try {
            this.onRecoveryPerformance(Object.freeze({
              documentId: capture.documentId,
              revision: capture.snapshotRevision,
              bytes: Number.isSafeInteger(writeMetrics.bytes) ? writeMetrics.bytes : capture.json.length,
              serializationDurationMs: capture.serializationDurationMs,
              ipcAndNativeDurationMs: writeMetrics.ipcAndNativeDurationMs,
              atomicWriteDurationMs: writeMetrics.atomicWriteDurationMs,
              endToEndDurationMs: capture.serializationDurationMs + writeMetrics.ipcAndNativeDurationMs,
            }));
          } catch (_) {
            // Diagnostics must never turn a durable recovery write into a failure.
          }
        }
        if (!this.session || this.session.documents.get(capture.documentId) !== capture.document) return false;
        const candidate = this._durableManifestCandidate(capture);
        if (!candidate) return false;
        await this.io.writeRecoveryManifest(candidate.generation, JSON.stringify(candidate));
        this._rememberDurableManifest(candidate);
        await this._cleanupRecoveryAfterManifest(candidate);
        if (this.session.documents.get(capture.documentId) === capture.document) {
          capture.document.persistedRevision = Math.max(
            capture.document.persistedRevision,
            capture.snapshotRevision,
          );
        }
        return true;
      } catch (reason) {
        for (const current of this.session ? this.session.documents.values() : []) {
          if (current instanceof DocumentModel) this._blockRecovery(current.id, reason);
        }
        throw reason;
      }
    }

    _durableManifestCandidate(capture) {
      if (!this.session) return null;
      const entries = new Map(this._durableRecoveryTabs);
      entries.set(capture.documentId, capture.tab);
      const tabs = this.session.tabOrder.filter((id) => entries.has(id)).map((id) => ({ ...entries.get(id) }));
      if (tabs.length === 0) return null;
      const included = new Set(tabs.map((tab) => tab.documentId));
      const activeDocumentId = included.has(this.session.activeDocumentId)
        ? this.session.activeDocumentId
        : (included.has(capture.documentId) ? capture.documentId : tabs[0].documentId);
      return {
        schemaVersion: 1,
        generation: this.session.generation,
        activeDocumentId,
        nextUntitledNumber: this.session.nextUntitledNumber,
        tabs,
      };
    }

    _rememberDurableManifest(manifest) {
      this._durableRecoveryTabs = new Map(manifest.tabs.map((tab) => [tab.documentId, Object.freeze({
        documentId: tab.documentId,
        displayName: tab.displayName,
        snapshotRevision: tab.snapshotRevision,
      })]));
    }

    async _cleanupRecoveryAfterManifest(manifest) {
      const included = new Set(manifest.tabs.map((tab) => tab.documentId));
      for (const documentId of [...this._pendingRecoveryDeletions]) {
        if (included.has(documentId) || (this.session && this.session.documents.has(documentId))) continue;
        try {
          await this.io.deleteRecoveryDocument(documentId);
          this._pendingRecoveryDeletions.delete(documentId);
        } catch (reason) {
          this._showRecoveryError(reason, {
            phase: "recovery-cleanup",
            documentId,
          });
        }
      }
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

      const capture = this._createRenderCapture(document);
      const cacheKey = this._previewCacheKey(capture);
      const cached = this._showCachedPreviewOrClear(capture);
      if (cached) {
        return Promise.resolve(cached.html);
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

    _createRenderCapture(document) {
      const token = ++this._renderToken;
      const capture = Object.freeze({
        token,
        documentId: document.id,
        editRevision: document.editRevision,
        content: document.content,
        displayName: document.displayName,
        optionsKey: this._rendererOptionsKey(),
        document,
      });
      this._latestRenderTokens.set(document.id, token);
      return capture;
    }

    _showCachedPreviewOrClear(capture) {
      const cacheKey = this._previewCacheKey(capture);
      const cached = this._previewCache.get(cacheKey);
      if (cached) {
        this._touchPreviewCache(cacheKey, cached);
        if (this._canCommitRender(capture)) this._setPreview(cached.html, capture);
        return cached;
      }
      if (this._canCommitRender(capture) && typeof this.view.clearPreview === "function") {
        this.view.clearPreview(capture);
      }
      return null;
    }

    _preparePreviewForActivation(document) {
      if (!(document instanceof DocumentModel)) return null;
      const capture = this._createRenderCapture(document);
      if (document.workspace.viewMode === "edit") {
        if (this._canCommitRender(capture) && typeof this.view.clearPreview === "function") {
          this.view.clearPreview(capture);
        }
        return null;
      }
      return this._showCachedPreviewOrClear(capture);
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

    recordCapturedSave(capture, result, { persist = true } = {}) {
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
      if (persist && needsCheckpoint && this._restoreState === "restored") {
        this._persistManifestNow().catch((reason) => this._showRecoveryError(reason, {
          phase: "save-checkpoint",
          documentId: capture.documentId,
          displayName: capture.displayName,
          snapshotRevision: capture.document.snapshotRevision,
        }));
      }
      return true;
    }

    saveDocument(documentId) {
      return this._runDocumentOperation(`save:${documentId}`, () => this._saveDocumentNow(documentId));
    }

    saveBrowserDocument(documentId, operations = {}) {
      return this._runDocumentOperation(
        `save:${documentId}`,
        () => this._saveBrowserDocumentNow(documentId, operations),
      );
    }

    saveAs(documentId, options = {}) {
      if (documentId && typeof documentId === "object") {
        options = documentId;
        documentId = options.documentId;
      }
      const id = documentId || (this.activeDocument() && this.activeDocument().id);
      return this._runDocumentOperation(`save-as:${id}`, () => this._saveAsNow(id, options));
    }

    saveAll() {
      return this._runDocumentOperation("save-all", () => this._saveAllNow());
    }

    resolveConflict(documentId, action) {
      return this._runDocumentOperation(
        `conflict:${documentId}`,
        () => this._resolveConflictNow(documentId, action),
      );
    }

    async _saveDocumentNow(documentId, { showConflict = true } = {}) {
      const document = this._requireLoadedDocument(documentId);
      if (!document.path) return this._saveAsNow(documentId);
      const capture = this._captureDocument(document);
      if (capture.fileStatus === "externally-changed") {
        return this._presentSaveConflict(capture, null, { showConflict });
      }
      if (typeof this.io.saveDocument !== "function") throw new Error("document saving is unavailable");

      this._setDocumentStatus(documentId, {
        status: "saving",
        message: `Saving ${capture.displayName}`,
        editRevision: capture.editRevision,
      });
      try {
        const contentSha256 = await this.hashText(capture.content);
        const result = await this.io.saveDocument({
          path: capture.path,
          expectedSha256: capture.expectedDiskSha256,
          content: capture.content,
        });
        if (result && result.status === "conflict") {
          return this._presentSaveConflict(capture, result, { showConflict });
        }
        if (result && result.status === "missing") {
          return this._continueMissingSave(capture);
        }
        if (!result || result.status !== "saved" || typeof result.sha256 !== "string") {
          throw new Error("document save returned an invalid result");
        }
        if (!this._ownsOperationCapture(capture)) return { saved: true, documentId, closed: true };
        let metadataChanged = false;
        if (typeof result.canonicalPath === "string" && result.canonicalPath !== document.canonicalPath) {
          metadataChanged = document.updateMetadata({ canonicalPath: result.canonicalPath });
        }
        const baselineChanged = this.recordCapturedSave(capture, {
          contentSha256,
          diskSha256: result.sha256,
        }, { persist: false });
        await this._checkpointAfterDocumentChange(capture, metadataChanged || baselineChanged, "save-checkpoint");
        if (this._ownsOperationCapture(capture)) {
          this._setDocumentStatus(documentId, {
            status: "saved",
            message: `Saved ${document.displayName}`,
            dirty: document.dirty,
            fileStatus: document.fileStatus,
            recoveryStatus: document.recoveryStatus,
          });
        }
        return { saved: true, documentId, path: capture.path };
      } catch (reason) {
        if (isMissingFileError(reason)) return this._continueMissingSave(capture);
        const error = normalizeError(reason);
        if (this._ownsOperationCapture(capture)) {
          this._setDocumentStatus(documentId, {
            status: "failed",
            message: `Could not save ${capture.displayName}: ${error.message}`,
          });
        }
        throw error;
      }
    }

    async _saveBrowserDocumentNow(documentId, operations) {
      const document = this._requireLoadedDocument(documentId);
      if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
        throw new TypeError("browser save operations are required");
      }
      if (typeof operations.read !== "function") throw new TypeError("browser save read is required");
      if (typeof operations.write !== "function") throw new TypeError("browser save write is required");
      const capture = this._captureDocument(document);
      const resolveAction = (action) => this._resolveBrowserConflictNow(capture, action, operations);
      if (capture.fileStatus === "externally-changed") {
        return this._presentSaveConflict(capture, null, { resolveAction });
      }

      const contentSha256 = await this.hashText(capture.content);
      let current;
      try {
        current = await this._readBrowserSaveSource(operations.read);
      } catch (reason) {
        return this._presentSaveConflict(capture, {
          status: "read-error",
          error: normalizeError(reason),
        }, { resolveAction });
      }
      if (current.sha256 !== capture.expectedDiskSha256) {
        return this._presentSaveConflict(capture, {
          status: "conflict",
          actualSha256: current.sha256,
        }, { resolveAction });
      }

      this._setDocumentStatus(documentId, {
        status: "saving",
        message: `Saving ${capture.displayName}`,
        editRevision: capture.editRevision,
      });
      try {
        // File System Access has no atomic compare-and-swap write. This fresh
        // read immediately before createWritable closes the detectable gap;
        // the source can still change during the browser-managed write itself.
        await operations.write(capture.content);
        if (!this._ownsOperationCapture(capture)) return { saved: true, documentId, closed: true };
        const baselineChanged = this.recordCapturedSave(capture, {
          contentSha256,
          diskSha256: contentSha256,
        }, { persist: false });
        await this._checkpointAfterDocumentChange(capture, baselineChanged, "browser-save-checkpoint");
        if (this._ownsOperationCapture(capture)) {
          this._setDocumentStatus(documentId, {
            status: "saved",
            message: `Saved ${document.displayName}`,
            dirty: document.dirty,
            fileStatus: document.fileStatus,
            recoveryStatus: document.recoveryStatus,
          });
        }
        return { saved: true, documentId };
      } catch (reason) {
        const error = normalizeError(reason);
        if (this._ownsOperationCapture(capture)) {
          this._setDocumentStatus(documentId, {
            status: "failed",
            message: `Could not save ${capture.displayName}: ${error.message}`,
          });
        }
        throw error;
      }
    }

    async _readBrowserSaveSource(read) {
      const result = await read();
      if (!result || typeof result !== "object" || typeof result.content !== "string") {
        throw new TypeError("browser save read returned an invalid result");
      }
      const content = result.content.replace(/\r\n/g, "\n");
      const sha256 = typeof result.sha256 === "string" && result.sha256
        ? result.sha256 : await this.hashText(content);
      return { ...result, content, sha256 };
    }

    async _resolveBrowserConflictNow(capture, action, operations) {
      const document = this._requireLoadedDocument(capture.documentId);
      if (action === "save-as") {
        if (typeof operations.saveAs !== "function") throw new Error("browser Save As is unavailable");
        return operations.saveAs(capture);
      }
      if (action !== "reload") throw new Error("unknown conflict action");
      if (document.dirty && !(await this._confirmReload(document))) {
        return { resolved: false, canceled: true, documentId: document.id };
      }

      const current = await this._readBrowserSaveSource(operations.read);
      if (!this._ownsOperationCapture(capture) || document.editRevision !== capture.editRevision) {
        return { resolved: false, stale: true, documentId: document.id };
      }
      document.applyContent(current.content);
      document.updateMetadata({ fileStatus: "normal" });
      const reloadCapture = this._captureDocument(document);
      const baselineChanged = this.recordCapturedSave(reloadCapture, {
        contentSha256: current.sha256,
        diskSha256: current.sha256,
      }, { persist: false });
      await this._checkpointAfterDocumentChange(reloadCapture, baselineChanged, "browser-reload-checkpoint");
      if (this._ownsOperationCapture(reloadCapture)) {
        const editor = typeof this.view.ensureEditor === "function" ? this.view.ensureEditor(document) : null;
        if (editor && editor.value !== document.content) editor.value = document.content;
        this._renderSession();
        this._renderDocumentView(document);
      }
      return { resolved: true, reloaded: true, documentId: document.id };
    }

    async _continueMissingSave(capture) {
      if (!this._ownsOperationCapture(capture)) {
        return { saved: false, missing: true, stale: true, documentId: capture.documentId };
      }
      const metadataChanged = capture.document.updateMetadata({ fileStatus: "missing" });
      this._setDocumentStatus(capture.documentId, {
        status: "missing",
        message: `${capture.displayName} is missing from disk`,
        dirty: capture.document.dirty,
        fileStatus: capture.document.fileStatus,
        recoveryStatus: capture.document.recoveryStatus,
      });
      await this._checkpointAfterDocumentChange(capture, metadataChanged, "save-missing-checkpoint");
      return this._saveAsNow(capture.documentId, {}, capture);
    }

    async _saveAsNow(documentId, options = {}, existingCapture = null) {
      const document = this._requireLoadedDocument(documentId);
      const capture = existingCapture || this._captureDocument(document);
      if (typeof this.io.saveDocument !== "function") throw new Error("document saving is unavailable");
      const choose = this.io.chooseSavePath;
      if (!options.path && typeof choose !== "function") throw new Error("save path selection is unavailable");

      const chosenPath = options.path || await choose.call(this.io, {
        defaultDir: capture.path ? capture.path.replace(/[^/\\]*$/, "") : "",
        suggestedName: options.suggestedName || capture.displayName || "untitled.md",
      });
      if (!chosenPath) return { saved: false, canceled: true, documentId };
      if (!this._ownsOperationCapture(capture)) return { saved: false, stale: true, documentId };

      const canonicalPath = typeof this.io.canonicalizeDocumentPath === "function"
        ? await this.io.canonicalizeDocumentPath(chosenPath)
        : chosenPath;
      let owner = this.session.findByCanonicalPath(canonicalPath);
      if (owner && owner !== document) {
        this.activateDocument(owner.id);
        return { saved: false, collision: true, documentId, ownerId: owner.id };
      }

      const reservations = new Set([canonicalPath]);
      this._reservedCanonicalPaths.set(canonicalPath, document);
      try {
        let expectedSha256;
        try {
          const current = await this.io.readDocument(chosenPath);
          expectedSha256 = current.sha256;
          const observedCanonical = typeof current.canonicalPath === "string" ? current.canonicalPath : canonicalPath;
          owner = this.session.findByCanonicalPath(observedCanonical);
          if (owner && owner !== document) {
            this.activateDocument(owner.id);
            return { saved: false, collision: true, documentId, ownerId: owner.id };
          }
          reservations.add(observedCanonical);
          this._reservedCanonicalPaths.set(observedCanonical, document);
        } catch (reason) {
          if (!isMissingFileError(reason)) throw normalizeError(reason);
          expectedSha256 = null;
        }
        if (!this._ownsOperationCapture(capture)) return { saved: false, stale: true, documentId };

        this._setDocumentStatus(documentId, {
          status: "saving",
          message: `Saving ${capture.displayName}`,
          editRevision: capture.editRevision,
        });
        const contentSha256 = await this.hashText(capture.content);
        const result = await this.io.saveDocument({
          path: chosenPath,
          expectedSha256,
          content: capture.content,
        });
        if (result && result.status === "conflict") {
          return this._presentSaveConflict(capture, result, { showConflict: true });
        }
        if (!result || result.status !== "saved" || typeof result.sha256 !== "string") {
          throw new Error("document save returned an invalid result");
        }
        if (!this._ownsOperationCapture(capture)) return { saved: true, documentId, closed: true };

        const savedCanonicalPath = typeof result.canonicalPath === "string"
          ? result.canonicalPath : canonicalPath;
        owner = this.session.findByCanonicalPath(savedCanonicalPath);
        if (owner && owner !== document) {
          this.activateDocument(owner.id);
          return { saved: false, collision: true, documentId, ownerId: owner.id };
        }
        const metadataChanged = document.updateMetadata({
          path: chosenPath,
          canonicalPath: savedCanonicalPath,
          displayName: displayNameFromPath(chosenPath),
        });
        const baselineChanged = this.recordCapturedSave(capture, {
          contentSha256,
          diskSha256: result.sha256,
        }, { persist: false });
        await this._checkpointAfterDocumentChange(capture, metadataChanged || baselineChanged, "save-as-checkpoint");
        if (this._ownsOperationCapture(capture)) {
          this._renderSession();
          this._renderDocumentView(document);
          this._setDocumentStatus(documentId, {
            status: "saved",
            message: `Saved ${document.displayName}`,
            displayName: document.displayName,
            dirty: document.dirty,
            fileStatus: document.fileStatus,
            recoveryStatus: document.recoveryStatus,
          });
        }
        return { saved: true, documentId, path: chosenPath };
      } finally {
        for (const path of reservations) {
          if (this._reservedCanonicalPaths.get(path) === document) this._reservedCanonicalPaths.delete(path);
        }
      }
    }

    async _saveAllNow({ showConflicts = true } = {}) {
      const dirtyIds = this.session
        ? this.session.tabOrder.filter((id) => {
          const document = this.session.documents.get(id);
          return document instanceof DocumentModel && document.dirty;
        })
        : [];
      const savedIds = [];
      let canceled = false;
      let error = null;
      for (const documentId of dirtyIds) {
        try {
          const result = await this._saveDocumentNow(documentId, { showConflict: showConflicts });
          if (!result || !result.saved) {
            canceled = Boolean(result && result.canceled);
            if (!canceled && result && (result.conflict || result.collision)) {
              error = new Error(result.conflict ? "save conflict" : "save path is already open");
            }
            break;
          }
          const liveDocument = this.session.documents.get(documentId);
          if (liveDocument instanceof DocumentModel && !liveDocument.dirty) savedIds.push(documentId);
        } catch (reason) {
          error = normalizeError(reason);
          break;
        }
      }
      const remainingIds = dirtyIds.filter((id) => {
        const document = this.session.documents.get(id);
        return document instanceof DocumentModel && document.dirty;
      });
      return { savedIds, remainingIds, canceled, error };
    }

    async _presentSaveConflict(capture, result, { showConflict = true, resolveAction = null } = {}) {
      if (!this._ownsOperationCapture(capture)) return { saved: false, conflict: true, stale: true };
      capture.document.updateMetadata({ fileStatus: "externally-changed" });
      this._scheduleRecoveryRevision(capture.document);
      await this._checkpointAfterDocumentChange(capture, true, "save-conflict-checkpoint");
      this._setDocumentStatus(capture.documentId, {
        status: "conflict",
        message: `${capture.displayName} changed outside MDedit`,
        dirty: capture.document.dirty,
        fileStatus: capture.document.fileStatus,
        recoveryStatus: capture.document.recoveryStatus,
      });
      let action = null;
      if (showConflict) action = await this._showConflictChoice(capture.document);
      if (action && action !== "keep-editing") {
        const resolved = resolveAction
          ? await resolveAction(action)
          : await this._resolveConflictNow(capture.documentId, action);
        if (action === "save-as" && resolved && resolved.saved) {
          return { ...resolved, conflictResolved: true, action };
        }
        return { saved: false, conflict: true, action, result, resolved };
      }
      return { saved: false, conflict: true, action: action || "keep-editing", result };
    }

    async _resolveConflictNow(documentId, action) {
      const document = this._requireLoadedDocument(documentId);
      if (action === "keep-editing") {
        return { resolved: false, keptEditing: true, documentId };
      }
      if (action === "save-as") return this._saveAsNow(documentId);
      if (action !== "reload") throw new Error("unknown conflict action");
      if (!document.path) throw new Error("conflicted document has no path");

      const capture = this._captureDocument(document);
      if (document.dirty) {
        const confirmed = await this._confirmReload(document);
        if (!confirmed) return { resolved: false, canceled: true, documentId };
      }
      let result;
      try {
        result = await this.io.readDocument(capture.path);
      } catch (reason) {
        if (this._ownsOperationCapture(capture)) {
          document.updateMetadata({ fileStatus: isMissingFileError(reason) ? "missing" : "read-error" });
          await this._checkpointAfterDocumentChange(capture, true, "reload-error-checkpoint");
        }
        throw normalizeError(reason);
      }
      const contentSha256 = await this.hashText(result.content);
      if (!this._ownsOperationCapture(capture) || document.editRevision !== capture.editRevision) {
        return { resolved: false, stale: true, documentId };
      }
      document.applyContent(result.content);
      const metadataChanged = document.updateMetadata({
        path: result.path || capture.path,
        canonicalPath: result.canonicalPath || capture.canonicalPath,
        displayName: displayNameFromPath(result.path || capture.path),
      });
      const reloadCapture = this._captureDocument(document);
      const baselineChanged = this.recordCapturedSave(reloadCapture, {
        contentSha256,
        diskSha256: result.sha256,
      }, { persist: false });
      await this._checkpointAfterDocumentChange(reloadCapture, metadataChanged || baselineChanged, "reload-checkpoint");
      if (this._ownsOperationCapture(reloadCapture)) {
        const editor = typeof this.view.ensureEditor === "function" ? this.view.ensureEditor(document) : null;
        if (editor && editor.value !== document.content) editor.value = document.content;
        this._renderSession();
        this._renderDocumentView(document);
      }
      return { resolved: true, reloaded: true, documentId };
    }

    _captureDocument(document) {
      return Object.freeze({
        document,
        documentId: document.id,
        content: document.content,
        editRevision: document.editRevision,
        snapshotRevision: document.snapshotRevision,
        displayName: document.displayName,
        path: document.path,
        canonicalPath: document.canonicalPath,
        expectedDiskSha256: document.expectedDiskSha256,
        fileStatus: document.fileStatus,
      });
    }

    _requireLoadedDocument(documentId) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
      const document = this.session.documents.get(documentId);
      if (!(document instanceof DocumentModel)) throw new Error("unknown or unloaded document id");
      return document;
    }

    async _checkpointAfterDocumentChange(capture, changed, phase) {
      if (!changed || !this._ownsOperationCapture(capture)) return false;
      this._scheduleRecoveryRevision(capture.document);
      if (this._restoreState === "restored") await this._persistManifestNow(this._lifecycleToken);
      return true;
    }

    _runDocumentOperation(key, run) {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._documentOperation) {
        if (this._documentOperation.key === key) return this._documentOperation.promise;
        return Promise.resolve({ busy: true, saved: false, closed: false, allowClose: false });
      }
      const operation = { key, promise: null };
      operation.promise = Promise.resolve().then(async () => {
        if (this._restoreState !== "restored") await this.restore();
        return run();
      }).finally(() => {
        if (this._documentOperation === operation) this._documentOperation = null;
      });
      this._documentOperation = operation;
      return operation.promise;
    }

    _showConflictChoice(document) {
      const actions = ["reload", "keep-editing", "save-as"];
      if (typeof this.dialogs.showConflict === "function") return this.dialogs.showConflict(document, actions);
      if (typeof this.view.showDialog !== "function") return Promise.resolve("keep-editing");
      return this.view.showDialog({
        title: `Resolve conflict for ${document.displayName}`,
        message: "The file changed outside MDedit. Choose how to continue.",
        documents: [document],
        actions: [
          { id: "reload", label: "Reload Disk Version" },
          { id: "keep-editing", label: "Keep Editing", primary: true },
          { id: "save-as", label: "Save Editor Version As" },
        ],
      });
    }

    _confirmReload(document) {
      if (typeof this.dialogs.confirmReload === "function") return this.dialogs.confirmReload(document);
      if (typeof this.view.showDialog !== "function") return Promise.resolve(false);
      return this.view.showDialog({
        title: `Discard edits to ${document.displayName}?`,
        message: "Reloading replaces the editor version with the file on disk.",
        documents: [document],
        actions: [
          { id: "cancel", label: "Cancel", value: false },
          { id: "reload", label: "Discard and Reload", value: true, primary: true },
        ],
      });
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
      const document = this.session && this.session.documents.get(documentId);
      const displayName = document && document.displayName ? document.displayName : String(documentId);
      return this._runDocumentOperation(
        `close:${documentId}`,
        () => this._closeDocumentNow(documentId),
      ).then((result) => {
        if (typeof this.view.announceCloseOutcome === "function") {
          this.view.announceCloseOutcome(result, displayName);
        }
        return result;
      });
    }

    async _closeDocumentNow(documentId) {
      const document = this._requireLoadedDocument(documentId);
      await this._reconcileDocumentDirty(document);
      let choice = "discard";
      if (document.dirty) {
        choice = await this._showCloseChoice(document);
        if (!choice || choice === "cancel") return { closed: false, canceled: true, documentId };
        if (choice === "save") {
          const saved = await this._saveDocumentNow(documentId);
          if (!saved || !saved.saved || !this.session.documents.has(documentId)) {
            return { closed: false, canceled: Boolean(saved && saved.canceled), result: saved, documentId };
          }
          if (document.dirty) return { closed: false, stale: true, result: saved, documentId };
        } else if (choice !== "discard") {
          throw new Error("unknown close action");
        }
      }
      await this._removeDocumentDurably(documentId);
      return { closed: true, discarded: choice === "discard", documentId };
    }

    async _removeDocumentDurably(documentId) {
      const document = this._requireLoadedDocument(documentId);
      if (this.session.activeDocumentId === documentId) this._captureAndFlushOutgoing(document);
      const { nextActiveId } = this.session.remove(documentId);
      this._pendingRecoveryDeletions.add(documentId);
      this._invalidatePreview(documentId);
      this._latestRenderTokens.delete(documentId);
      this._forgetBrowserSources(documentId);
      if (this._startupPlaceholderId === documentId) this._startupPlaceholderId = null;
      if (typeof this.scheduler.forget === "function") this.scheduler.forget(documentId);
      if (typeof this.view.removeEditor === "function") this.view.removeEditor(documentId);
      let active;
      if (nextActiveId === null) {
        active = this.session.createUntitled();
      } else {
        active = this.session.documents.get(nextActiveId);
      }
      this._presentActivatedDocument(active, { persist: false, announce: false });
      await this._persistManifestNow(this._lifecycleToken);
      return active;
    }

    async _reconcileDocumentDirty(document) {
      if (!(document instanceof DocumentModel)) return false;
      if (!document.dirty) return false;
      const capture = this._captureDocument(document);
      const contentSha256 = await this.hashText(capture.content);
      if (!this._ownsOperationCapture(capture)) return false;
      document.reconcileDirty(contentSha256, capture.editRevision);
      this._setDocumentStatus(document.id, {
        dirty: document.dirty,
        fileStatus: document.fileStatus,
        recoveryStatus: document.recoveryStatus,
      });
      return document.dirty;
    }

    _showCloseChoice(document) {
      const actions = ["save", "discard", "cancel"];
      if (typeof this.dialogs.showClose === "function") return this.dialogs.showClose(document, actions);
      if (typeof this.view.showDialog !== "function") return Promise.resolve("cancel");
      return this.view.showDialog({
        title: `Save changes to ${document.displayName}?`,
        message: "Closing this tab without saving will discard its editor changes.",
        documents: [document],
        actions: [
          { id: "save", label: "Save", primary: true },
          { id: "discard", label: "Discard" },
          { id: "cancel", label: "Cancel" },
        ],
      });
    }

    requestQuit() {
      return this._runDocumentOperation("quit", () => this._requestQuitNow());
    }

    async _requestQuitNow() {
      const documents = [...this.session.documents.values()].filter(
        (document) => document instanceof DocumentModel,
      );
      await Promise.all(documents.map((document) => this._reconcileDocumentDirty(document)));
      const dirtyDocuments = this.session.tabOrder
        .map((id) => this.session.documents.get(id))
        .filter((document) => document instanceof DocumentModel && document.dirty);
      const recoveryRisk = Boolean(this._sessionRecoveryFailure) || documents.some(
        (document) => document.recoveryStatus === "failed",
      );
      const requiresRecoveryChoice = dirtyDocuments.length > 0 || recoveryRisk;
      const choice = await this._showQuitChoice(dirtyDocuments, { requiresRecoveryChoice });
      if (!choice || choice === "cancel") return { allowClose: false, canceled: true };

      if (!requiresRecoveryChoice) {
        if (choice !== "close") return { allowClose: false, canceled: true };
        try {
          await this._checkpointSessionForQuit();
          const currentDocuments = [...this.session.documents.values()].filter(
            (document) => document instanceof DocumentModel,
          );
          await Promise.all(currentDocuments.map((document) => this._reconcileDocumentDirty(document)));
          const changedIds = this.session.tabOrder.filter((id) => {
            const document = this.session.documents.get(id);
            return document instanceof DocumentModel && document.dirty;
          });
          if (changedIds.length > 0) {
            return {
              allowClose: false,
              canceled: false,
              changed: true,
              retryRequired: true,
              remainingIds: changedIds,
            };
          }
          this._nativeCloseAllowed = true;
          return { allowClose: true, choice };
        } catch (reason) {
          const error = normalizeError(reason);
          this._showRecoveryError(error, { phase: "quit" });
          return { allowClose: false, canceled: false, error };
        }
      }

      let saveAllResult = null;
      try {
        if (choice === "save-all") {
          const result = await this._saveAllNow({ showConflicts: false });
          saveAllResult = result;
          if (result.canceled || result.error || result.remainingIds.length > 0) {
            return {
              allowClose: false,
              canceled: result.canceled,
              error: result.error,
              saveAll: result,
            };
          }
          await this._checkpointSessionForQuit();
          result.remainingIds = this._recoveryUnsavedDocumentIds();
          if (result.remainingIds.length > 0) {
            result.savedIds = result.savedIds.filter((id) => !result.remainingIds.includes(id));
            return { allowClose: false, canceled: false, error: null, saveAll: result };
          }
        } else if (choice === "restore") {
          await this._checkpointSessionForQuit();
        } else if (choice === "discard-all") {
          await this._discardDocumentsForQuit(dirtyDocuments);
        } else {
          throw new Error("unknown quit action");
        }
      } catch (reason) {
        const error = normalizeError(reason);
        this._showRecoveryError(error, { phase: "quit" });
        if (saveAllResult) {
          saveAllResult.remainingIds = [...new Set([
            ...saveAllResult.remainingIds,
            ...this._recoveryUnsavedDocumentIds(),
          ])];
          saveAllResult.savedIds = saveAllResult.savedIds.filter(
            (id) => !saveAllResult.remainingIds.includes(id),
          );
          return { allowClose: false, canceled: false, error, saveAll: saveAllResult };
        }
        return { allowClose: false, canceled: false, error };
      }
      this._nativeCloseAllowed = true;
      return { allowClose: true, choice };
    }

    async _checkpointSessionForQuit() {
      await this._manifestWrites;
      if (typeof this.scheduler.flushAll !== "function") {
        throw new Error("whole-session recovery flush is unavailable");
      }
      await this.scheduler.flushAll();
      let needsCheckpoint = true;
      for (;;) {
        if (needsCheckpoint) await this._persistManifestNow(this._lifecycleToken);
        await Promise.resolve();

        const observedWrites = this._manifestWrites;
        await observedWrites;
        await Promise.resolve();
        if (observedWrites !== this._manifestWrites) {
          needsCheckpoint = false;
          continue;
        }

        const pendingIds = this._recoveryUnsavedDocumentIds({ includeDirty: false });
        const quiescent = !this._manifestBarrier
          && !this._recoveryManifestQueued
          && this._deferredRecoveryRevisions.size === 0
          && pendingIds.length === 0;
        if (quiescent) return;
        needsCheckpoint = true;
      }
    }

    _recoveryUnsavedDocumentIds({ includeDirty = true } = {}) {
      return this.session.tabOrder.filter((id) => {
        const document = this.session.documents.get(id);
        return document instanceof DocumentModel && ((includeDirty && document.dirty)
          || document.recoveryStatus === "failed"
          || document.persistedRevision < document.snapshotRevision);
      });
    }

    async _discardDocumentsForQuit(documents) {
      const ids = new Set(documents.map((document) => document.id));
      for (const documentId of this.session.tabOrder.filter((id) => ids.has(id))) {
        const document = this.session.documents.get(documentId);
        if (!(document instanceof DocumentModel)) continue;
        this.session.remove(documentId);
        this._pendingRecoveryDeletions.add(documentId);
        this._invalidatePreview(documentId);
        this._latestRenderTokens.delete(documentId);
        if (typeof this.scheduler.forget === "function") this.scheduler.forget(documentId);
        if (typeof this.view.removeEditor === "function") this.view.removeEditor(documentId);
      }
      if (this.session.documents.size === 0) this.session.createUntitled();
      const active = this.activeDocument();
      if (active) this._presentActivatedDocument(active, { persist: false, focusEditor: false });
      await this._persistManifestNow(this._lifecycleToken);
    }

    _showQuitChoice(documents, { requiresRecoveryChoice = true } = {}) {
      const actions = requiresRecoveryChoice
        ? ["save-all", "restore", "discard-all", "cancel"]
        : ["close", "cancel"];
      if (typeof this.dialogs.showQuit === "function") return this.dialogs.showQuit(documents, actions);
      if (typeof this.view.showDialog !== "function") return Promise.resolve("cancel");
      if (!requiresRecoveryChoice) {
        return this.view.showDialog({
          title: "Close application?",
          message: "Close MDedit?",
          documents: [],
          cancelable: true,
          actions: [
            { id: "close", label: "Close", primary: true },
            { id: "cancel", label: "Cancel" },
          ],
        });
      }
      return this.view.showDialog({
        title: "Close application?",
        message: "Choose what MDedit should do before closing.",
        documents,
        cancelable: true,
        actions: [
          { id: "save-all", label: "Save All & Quit", primary: true },
          { id: "restore", label: "Quit and Restore Next Time" },
          { id: "discard-all", label: "Discard All & Quit" },
          { id: "cancel", label: "Cancel" },
        ],
      });
    }

    allowNativeClose() {
      if (!this._nativeCloseAllowed) return false;
      this._nativeCloseAllowed = false;
      return true;
    }

    disallowNativeClose() {
      this._nativeCloseAllowed = false;
    }

    hasUnsavedOrRecoveryRisk() {
      if (this._sessionRecoveryFailure) return true;
      if (!this.session) return false;
      return [...this.session.documents.values()].some((document) => document instanceof DocumentModel
        && (document.dirty || document.recoveryStatus === "failed"));
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

    _persistManifestNow(token = this._lifecycleToken, { allowBlocked = false, retryScheduler = false } = {}) {
      if (!this._isLifecycleActive(token)) return Promise.reject(new Error("session controller is disposed"));
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      if (!allowBlocked && this._sessionRecoveryFailure) return Promise.reject(this._sessionRecoveryFailure);
      if (this._manifestBarrier) {
        const activeBarrier = this._manifestBarrier;
        activeBarrier.needsCatchUp = true;
        for (const document of this.session.documents.values()) {
          if (!(document instanceof DocumentModel)) continue;
          const previous = this._deferredRecoveryRevisions.get(document.id) ?? -1;
          this._deferredRecoveryRevisions.set(document.id, Math.max(previous, document.snapshotRevision));
        }
        if (activeBarrier.allowBlocked) return Promise.resolve(false);
        if (!activeBarrier.catchUpPromise) {
          const pendingTransaction = activeBarrier.externalCheckpoint
            ? activeBarrier.completion
            : this._manifestWrites;
          activeBarrier.catchUpPromise = pendingTransaction.then(() => this._persistManifestNow(token, {
            allowBlocked,
            retryScheduler,
          }));
        }
        return activeBarrier.catchUpPromise;
      }

      const barrier = {
        snapshots: new Map(),
        needsCatchUp: false,
        catchUpPromise: null,
        allowBlocked,
      };
      this._manifestBarrier = barrier;
      const candidateSession = this.session;
      let candidate;
      let capturedDocuments;
      try {
        candidate = JSON.parse(JSON.stringify(candidateSession.toManifest()));
        capturedDocuments = candidate.tabs.map((tab) => {
          const document = candidateSession.documents.get(tab.documentId);
          const capture = {
            document,
            documentId: tab.documentId,
            snapshotRevision: tab.snapshotRevision,
            needsSnapshot: document instanceof DocumentModel
              && document.persistedRevision < tab.snapshotRevision,
          };
          if (capture.needsSnapshot) {
            barrier.snapshots.set(tab.documentId, {
              revision: tab.snapshotRevision,
              json: JSON.stringify(document.toSnapshot()),
            });
          }
          return capture;
        });
      } catch (reason) {
        this._manifestBarrier = null;
        return Promise.reject(reason);
      }
      const coverage = new Map(capturedDocuments.map((capture) => [capture.documentId, capture.snapshotRevision]));
      this._pendingManifestCandidates.add(coverage);
      const json = JSON.stringify(candidate);
      const write = this._manifestWrites.catch(() => {}).then(
        async () => {
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          if (!allowBlocked && this._sessionRecoveryFailure) {
            if (this._manifestBarrier === barrier) this._manifestBarrier = null;
            throw this._sessionRecoveryFailure;
          }
          try {
            if (retryScheduler && typeof this.scheduler.retry === "function") {
              for (const capture of capturedDocuments) await this.scheduler.retry(capture.documentId);
            }
            const controlledFlushes = [];
            for (const capture of capturedDocuments) {
              if (!capture.needsSnapshot) continue;
              this.scheduler.changed(capture.documentId, capture.snapshotRevision);
              controlledFlushes.push({
                capture,
                promise: this.scheduler.flush(capture.documentId, capture.snapshotRevision),
              });
            }
            await Promise.all(controlledFlushes.map(({ promise }) => promise));
            for (const { capture } of controlledFlushes) {
              if (this.session.documents.get(capture.documentId) === capture.document) {
                capture.document.persistedRevision = Math.max(capture.document.persistedRevision, capture.snapshotRevision);
              }
            }
            if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
            await this.io.writeRecoveryManifest(candidate.generation, json);
            this._rememberDurableManifest(candidate);
            await this._cleanupRecoveryAfterManifest(candidate);
          } catch (reason) {
            if (this._manifestBarrier === barrier) this._manifestBarrier = null;
            for (const document of this.session.documents.values()) this._blockRecovery(document.id, reason);
            throw reason;
          }
          const diverged = barrier.needsCatchUp
            || this.session !== candidateSession
            || JSON.stringify(this.session.toManifest()) !== json;
          if (this._manifestBarrier === barrier) this._releaseManifestBarrier(true);
          if (diverged && !barrier.catchUpPromise) {
            if (allowBlocked) this._retryCatchUpNeeded = true;
            else this._queueRecoveryManifest();
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
      const document = this._createUntitledNow(token);
      this._startupPlaceholderId = document.id;
      return document;
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

    _presentActivatedDocument(document, {
      focusEditor = true,
      persist = true,
      announce = true,
      preserveTabFocus = false,
    } = {}) {
      if (this._disposed || !document) return;
      if (document instanceof DocumentModel && (this._manifestBarrier || this._sessionRecoveryFailure)) {
        this._scheduleRecoveryRevision(document);
      }
      const id = document.id;
      const viewToken = ++this._viewToken;
      this._renderSession();
      if (preserveTabFocus && typeof this.view.focusActiveTab === "function") this.view.focusActiveTab();
      if (announce && typeof this.view.announceActiveDocument === "function") {
        this.view.announceActiveDocument(document, this.session);
      }
      if (document instanceof DocumentModel && typeof this.view.ensureEditor === "function") {
        this.view.ensureEditor(document);
      }
      if (typeof this.view.activateEditor === "function") this.view.activateEditor(id);
      this._preparePreviewForActivation(document);
      this._renderDocumentView(document);
      this.requestAnimationFrame(() => {
        if (this._disposed || viewToken !== this._viewToken || !this.session
            || this.session.activeDocumentId !== id || this.session.documents.get(id) !== document) return;
        if (document instanceof DocumentModel && typeof this.view.applyWorkspace === "function") {
          this.view.applyWorkspace(id, document.workspace);
        }
        if (focusEditor && typeof this.view.focusActiveEditor === "function") this.view.focusActiveEditor();
        this.requestAnimationFrame(() => {
          if (this._disposed || viewToken !== this._viewToken || !this.session
              || this.session.activeDocumentId !== id || this.session.documents.get(id) !== document) return;
          if (!(document instanceof DocumentModel) || document.workspace.viewMode !== "edit") {
            this.renderDocument(id).catch((reason) => {
              if (!this.session || this.session.documents.get(id) !== document) return;
              this._setDocumentStatus(id, {
                status: "failed",
                message: `Preview failed for ${document.displayName}: ${normalizeError(reason).message}`,
              });
            });
          }
          if (persist && this._restoreState === "restored") {
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
      return this.openPaths([path], { replaceStartupPlaceholder: true });
    }

    dispose() {
      if (this._disposePromise) return this._disposePromise;
      this._disposed = true;
      this._lifecycleToken += 1;
      this._restoreState = "disposed";
      this._loadQueue = [];
      this._loadPriority = [];
      this._loadingIds.clear();
      this._browserSourcesByDocument.clear();
      for (const reservation of this._browserSourceReservations.values()) {
        reservation.settle({ committed: false, disposed: true });
      }
      this._browserSourceReservations.clear();
      this._browserFileIdentities = new WeakMap();
      this._startupPlaceholderId = null;
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
    createNativeCloseRequestHandler,
    isMissingFileError,
  };
});
