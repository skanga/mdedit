(function initSessionController(root, factory) {
  const api = factory(root);

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, (root) => {
  "use strict";

  const LEGACY_DRAFT_KEY = "mdedit-draft-v1";
  const DEFAULT_INACTIVE_LOAD_CONCURRENCY = 4;

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

      this.inactiveLoadConcurrency = inactiveLoadConcurrency;
      this.renderer = renderer;
      this.exporter = exporter;
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
        this.scheduler.changed(document.id, document.editRevision);
        await this.scheduler.flush(document.id, document.editRevision);
        if (!this._isLifecycleActive(token)) return null;
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
      const document = this._documentFromReadResult(result);
      session.add(document);
      this._renderSession();
      this._renderDocument(document);
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
      this._renderSession();
      this._renderDocument(document);
      return document;
    }

    activateDocument(id) {
      if (this._disposed) throw new Error("session controller is disposed");
      if (!this.session) throw new Error("session has not been created");
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
      this._renderSession();
      this._renderDocument(document);
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

    createUntitled() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._restoreState === "idle" && !this._localSessionEstablished) {
        const candidate = new SessionModel({ idFactory: this.idFactory });
        const document = candidate.createUntitled();
        this._commitLocalSession(candidate);
        this._renderSession();
        this._renderDocument(document);
        return document;
      }
      if (this._canMutateSynchronously()) return this._createUntitledNow(this._lifecycleToken);
      // Active recovery is the exceptional asynchronous phase: queue the model
      // creation until recovery owns a stable session.
      return this._scheduleOperation((token) => this._createUntitledNow(token));
    }

    _createUntitledNow(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
      const document = this._ensureSession().createUntitled();
      this._renderSession();
      this._renderDocument(document);
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

    _persistManifestNow(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) return Promise.reject(new Error("session controller is disposed"));
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      const value = this.session.toManifest();
      const generation = value.generation;
      const json = JSON.stringify(value);
      const write = this._manifestWrites.catch(() => {}).then(
        () => {
          if (!this._isLifecycleActive(token)) throw new Error("session controller is disposed");
          return this.io.writeRecoveryManifest(generation, json);
        },
      );
      this._manifestWrites = write;
      return write;
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

    _renderSession() {
      if (this._disposed) return;
      if (typeof this.view.renderSession === "function") this.view.renderSession(this.session);
      else if (typeof this.view.renderTabs === "function") this.view.renderTabs(this.session);
    }

    _renderDocument(document) {
      if (this._disposed) return;
      if (typeof this.view.renderDocument === "function") this.view.renderDocument(document, this.session);
      else if (typeof this.view.showDocument === "function") this.view.showDocument(document, this.session);
      else if (typeof this.view.activateDocument === "function") this.view.activateDocument(document, this.session);
    }

    _showRecoveryError(reason, context) {
      const error = normalizeError(reason);
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
  };
});
