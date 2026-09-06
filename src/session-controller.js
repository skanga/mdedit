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
      this._operationChain = Promise.resolve();
      this._manifestWrites = Promise.resolve();
      this._restorePromise = null;
      this._restoreState = "idle";
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
      if (!registration || typeof registration.then !== "function") {
        this._unlisten = registration;
      }
      this._listenerReady = Promise.resolve(registration).then(
        (unlisten) => {
          if (this._disposed) {
            if (typeof unlisten === "function") {
              try {
                Promise.resolve(unlisten()).catch(() => {});
              } catch (_) {
                // Disposal remains complete even if late unsubscription fails.
              }
            }
            return null;
          }
          this._unlisten = unlisten;
          return unlisten;
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
      if (this._restorePromise) return this._restorePromise;
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      this._restoreState = "restoring";
      const token = ++this._lifecycleToken;
      this._restorePromise = this._restore(token);
      return this._restorePromise;
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
      const completions = [];
      while (this._isLifecycleActive(token) && this._pendingOperations.length > 0) {
        const request = this._pendingOperations.shift();
        try {
          completions.push({ request, value: await request.run() });
        } catch (reason) {
          completions.push({ request, error: reason });
        }
      }
      if (!this._isLifecycleActive(token)) {
        for (const { request } of completions) request.dispose();
        return this.session;
      }
      if (!this.session || this.session.documents.size === 0) this._createFreshSession(token);

      // Publish the lifecycle transition before resolving queued callers. Their
      // continuations can safely submit direct follow-up work without missing
      // the final drain pass.
      this._restoreState = "restored";
      for (const completion of completions) {
        if (Object.prototype.hasOwnProperty.call(completion, "error")) {
          completion.request.reject(completion.error);
        } else {
          completion.request.resolve(completion.value);
        }
      }
      return this.session;
    }

    async restoreManifest(rawManifest, token = this._lifecycleToken) {
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
      if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
      if (this._disposed) return Promise.resolve(this._disposedOpenResult(paths));
      const copiedPaths = [...paths];
      return this._scheduleOperation(
        () => this._openPathsNow(copiedPaths),
        (resolve) => resolve(this._disposedOpenResult(copiedPaths)),
      );
    }

    async _openPathsNow(paths) {
      const opened = [];
      const openedIds = new Set();
      const failed = [];

      for (const path of paths) {
        if (this._disposed) {
          failed.push({ path, error: new Error("session controller is disposed") });
          continue;
        }
        try {
          const result = await this.io.readDocument(path);
          if (this._disposed) {
            failed.push({ path, error: new Error("session controller is disposed") });
            continue;
          }
          const document = this._openReadResultNow(result);
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
      if (this._restoreState === "restored") {
        const operation = this._operationChain.catch(() => {}).then(() => {
          if (this._disposed) throw new Error("session controller is disposed");
          return run();
        });
        this._operationChain = operation;
        return operation;
      }

      let request;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        request = {
          run,
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
      this._pendingOperations.push(request);

      if (this._restoreState === "idle") {
        this.restore().catch((reason) => {
          const index = this._pendingOperations.indexOf(request);
          if (index >= 0) this._pendingOperations.splice(index, 1);
          request.reject(reason);
        });
      }
      return promise;
    }

    openReadResult(result) {
      if (!result || typeof result !== "object") throw new TypeError("read result is required");
      if (typeof result.canonicalPath !== "string" || result.canonicalPath.length === 0) {
        throw new TypeError("read result canonicalPath must be a non-empty string");
      }
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      return this._scheduleOperation(() => this._openReadResultNow(result));
    }

    _openReadResultNow(result) {
      const session = this._ensureSession();
      const existing = session.findByCanonicalPath(result.canonicalPath);
      if (existing) {
        this.activateDocument(existing.id);
        return existing;
      }
      if (typeof result.path !== "string" || result.path.length === 0) {
        throw new TypeError("read result path must be a non-empty string");
      }

      const document = new DocumentModel({
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
      session.add(document);
      this._renderSession();
      this._renderDocument(document);
      return document;
    }

    activateDocument(id) {
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
      if (!this.session || this.session.activeDocumentId === null) return null;
      return this.session.documents.get(this.session.activeDocumentId) || null;
    }

    createUntitled() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      return this._scheduleOperation(() => this._createUntitledNow());
    }

    _createUntitledNow() {
      const document = this._ensureSession().createUntitled();
      this._renderSession();
      this._renderDocument(document);
      return document;
    }

    persistManifest() {
      if (this._disposed) return Promise.reject(new Error("session controller is disposed"));
      if (this._restoreState === "restoring" && this._restorePromise) {
        return this._restorePromise.then(() => this._persistManifestNow(this._lifecycleToken));
      }
      return this._persistManifestNow(this._lifecycleToken);
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

    _createFreshSession(token = this._lifecycleToken) {
      if (!this._isLifecycleActive(token)) return null;
      this.session = new SessionModel({ idFactory: this.idFactory });
      return this._createUntitledNow();
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
