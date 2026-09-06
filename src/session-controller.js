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
      this._pendingOpenRequests = [];
      this._openChain = Promise.resolve();
      this._manifestWrites = Promise.resolve();
      this._restorePromise = null;
      this._restoreState = "idle";
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
          this._unlisten = unlisten;
          return unlisten;
        },
        (reason) => {
          const error = normalizeError(reason);
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
      this._restorePromise = this._restore();
      return this._restorePromise;
    }

    async _restore() {
      const earlierListenerFailure = this._listenerFailure;
      this._listenerFailure = null;
      try {
        await this.start();
      } catch (reason) {
        if (this._listenerFailure === reason) this._listenerFailure = null;
        await this._showRecoveryError(reason, { phase: "file-open-listener" });
      }
      if (earlierListenerFailure) {
        await this._showRecoveryError(earlierListenerFailure, { phase: "file-open-listener" });
      }

      let rawManifest;
      try {
        rawManifest = await this.io.loadRecoveryManifest();
      } catch (reason) {
        await this._showRecoveryError(reason, { phase: "manifest" });
        this._assignEmptySession();
        return this._finishRestore();
      }

      if (rawManifest === null) {
        await this.importLegacyDraft();
        if (!this.session) this._assignEmptySession();
      } else {
        try {
          await this.restoreManifest(rawManifest);
        } catch (reason) {
          await this._showRecoveryError(reason, { phase: "manifest" });
          this._assignEmptySession();
        }
      }
      return this._finishRestore();
    }

    async _finishRestore() {
      await this._drainPendingOpens();
      if (!this._disposed && (!this.session || this.session.documents.size === 0)) {
        this._createFreshSession();
      }
      if (!this._disposed) this._restoreState = "restored";
      return this.session;
    }

    async restoreManifest(rawManifest) {
      const manifest = typeof rawManifest === "string" ? JSON.parse(rawManifest) : rawManifest;
      const session = SessionModel.fromManifest(manifest, { idFactory: this.idFactory });
      this.session = session;

      for (const stub of session.documents.values()) stub.loadStatus = "loading";
      this._renderSession();

      const initiallyActiveId = session.activeDocumentId;
      await this.loadSnapshot(initiallyActiveId);

      const inactiveIds = session.tabOrder.filter((id) => id !== initiallyActiveId);
      const prioritizedIds = this._loadPriority.filter((id) => inactiveIds.includes(id));
      const prioritizedSet = new Set(prioritizedIds);
      this._loadQueue = [
        ...prioritizedIds,
        ...inactiveIds.filter((id) => !prioritizedSet.has(id)),
      ];
      this._loadPriority = [];

      const workerCount = Math.min(this.inactiveLoadConcurrency, this._loadQueue.length);
      const workers = Array.from({ length: workerCount }, () => this._loadWorker());
      await Promise.all(workers);
      this._loadQueue = [];
      return session;
    }

    async _loadWorker() {
      while (this._loadQueue.length > 0) {
        const id = this._loadQueue.shift();
        this._loadingIds.add(id);
        try {
          await this.loadSnapshot(id);
        } finally {
          this._loadingIds.delete(id);
        }
      }
    }

    async loadSnapshot(documentOrId) {
      if (!this.session) throw new Error("session has not been restored");
      const id = typeof documentOrId === "string" ? documentOrId : documentOrId && documentOrId.id;
      const stub = this.session.documents.get(id);
      if (!stub) throw new Error("unknown document id");
      const expectedRevision = stub.snapshotRevision;

      try {
        const rawSnapshot = await this.io.loadRecoveryDocument(id, expectedRevision);
        const value = typeof rawSnapshot === "string" ? JSON.parse(rawSnapshot) : rawSnapshot;
        const document = DocumentModel.fromSnapshot(value);
        if (document.id !== id) throw new Error(`recovery snapshot identity mismatch for ${id}`);
        if (document.snapshotRevision !== expectedRevision) {
          throw new Error(`recovery snapshot revision mismatch for ${id}`);
        }
        const contentSha256 = await this.hashText(document.content);
        document.reconcileDirty(contentSha256, document.editRevision);

        const canonicalOwner = document.canonicalPath === null
          ? null
          : this.session.findByCanonicalPath(document.canonicalPath);
        if (canonicalOwner && canonicalOwner.id !== id) {
          throw new Error(`recovery snapshot canonical path is already owned by ${canonicalOwner.id}`);
        }
        if (this.session.documents.get(id) !== stub) {
          throw new Error(`recovery snapshot identity changed while loading ${id}`);
        }

        document.loadStatus = "loaded";
        this.session.documents.set(id, document);
        this._renderSession();
        if (this.session.activeDocumentId === id) this._renderDocument(document);
        return document;
      } catch (reason) {
        const error = normalizeError(reason);
        if (this.session.documents.get(id) === stub) {
          stub.loadStatus = "failed";
          stub.loadError = error;
        }
        this._renderSession();
        if (this.session.activeDocumentId === id) this._renderDocument(stub);
        await this._showRecoveryError(error, {
          phase: "snapshot",
          documentId: id,
          displayName: stub.displayName,
          snapshotRevision: expectedRevision,
        });
        return null;
      }
    }

    async importLegacyDraft() {
      const previousSession = this.session;
      let document = null;
      try {
        const rawDraft = this.legacyStorage.getItem(LEGACY_DRAFT_KEY);
        if (!rawDraft) return null;
        const draft = JSON.parse(rawDraft);
        if (!draft || typeof draft !== "object" || Array.isArray(draft)
            || typeof draft.text !== "string" || !draft.text.trim()) {
          throw new TypeError("invalid legacy draft");
        }

        const savedContentSha256 = await this.hashText("");
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
        await this._persistManifestNow();
        this.legacyStorage.removeItem(LEGACY_DRAFT_KEY);
        this._renderSession();
        this._renderDocument(document);
        return document;
      } catch (reason) {
        if (document && typeof this.scheduler.forget === "function") {
          try {
            this.scheduler.forget(document.id);
          } catch (_) {
            // Rollback remains best-effort after the migration failure.
          }
        }
        this.session = previousSession;
        await this._showRecoveryError(reason, {
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
      if (this._restoreState !== "restored") {
        return new Promise((resolve, reject) => {
          this._pendingOpenRequests.push({ paths: [...paths], resolve, reject });
        });
      }

      const opening = this._openChain.catch(() => {}).then(() => this._openPathsNow(paths));
      this._openChain = opening;
      return opening;
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
          const document = this.openReadResult(result);
          if (!openedIds.has(document.id)) {
            openedIds.add(document.id);
            opened.push(document);
          }
        } catch (reason) {
          const error = normalizeError(reason);
          failed.push({ path, error });
          await this._showOpenError(path, error);
        }
      }
      return { opened, failed };
    }

    async _drainPendingOpens() {
      while (this._pendingOpenRequests.length > 0) {
        const request = this._pendingOpenRequests.shift();
        if (this._disposed) {
          request.resolve(this._disposedOpenResult(request.paths));
          continue;
        }
        try {
          request.resolve(await this._openPathsNow(request.paths));
        } catch (reason) {
          request.reject(reason);
        }
      }
    }

    _disposedOpenResult(paths) {
      return {
        opened: [],
        failed: paths.map((path) => ({ path, error: new Error("session controller is disposed") })),
      };
    }

    openReadResult(result) {
      if (!result || typeof result !== "object") throw new TypeError("read result is required");
      if (typeof result.canonicalPath !== "string" || result.canonicalPath.length === 0) {
        throw new TypeError("read result canonicalPath must be a non-empty string");
      }

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
      const document = this._ensureSession().createUntitled();
      this._renderSession();
      this._renderDocument(document);
      return document;
    }

    persistManifest() {
      if (this._restoreState === "restoring" && this._restorePromise) {
        return this._restorePromise.then(() => this._persistManifestNow());
      }
      return this._persistManifestNow();
    }

    _persistManifestNow() {
      if (!this.session) return Promise.reject(new Error("session has not been created"));
      const value = this.session.toManifest();
      const generation = value.generation;
      const json = JSON.stringify(value);
      const write = this._manifestWrites.catch(() => {}).then(
        () => this.io.writeRecoveryManifest(generation, json),
      );
      this._manifestWrites = write;
      return write;
    }

    _ensureSession() {
      if (!this.session) this.session = new SessionModel({ idFactory: this.idFactory });
      return this.session;
    }

    _createFreshSession() {
      this.session = new SessionModel({ idFactory: this.idFactory });
      return this.createUntitled();
    }

    _assignEmptySession() {
      this.session = new SessionModel({ idFactory: this.idFactory });
      this._renderSession();
      return this.session;
    }

    _renderSession() {
      if (typeof this.view.renderSession === "function") this.view.renderSession(this.session);
      else if (typeof this.view.renderTabs === "function") this.view.renderTabs(this.session);
    }

    _renderDocument(document) {
      if (typeof this.view.renderDocument === "function") this.view.renderDocument(document, this.session);
      else if (typeof this.view.showDocument === "function") this.view.showDocument(document, this.session);
      else if (typeof this.view.activateDocument === "function") this.view.activateDocument(document, this.session);
    }

    async _showRecoveryError(reason, context) {
      const error = normalizeError(reason);
      let recoveryDirectory = null;
      try {
        recoveryDirectory = await this.io.recoveryDirectory();
      } catch (_) {
        // The original recovery failure remains the useful error.
      }
      const details = {
        ...context,
        error,
        message: error.message,
        recoveryDirectory,
      };
      if (typeof this.view.showRecoveryError === "function") {
        try {
          await Promise.resolve(this.view.showRecoveryError(details));
        } catch (_) {
          // Recovery presentation is best-effort and cannot block restoration.
        }
      }
      return details;
    }

    async _showOpenError(path, error) {
      if (typeof this.dialogs.showOpenError !== "function") return;
      try {
        await Promise.resolve(this.dialogs.showOpenError(path, error));
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
      this._restoreState = "disposed";
      this._loadQueue = [];
      this._loadPriority = [];
      while (this._pendingOpenRequests.length > 0) {
        const request = this._pendingOpenRequests.shift();
        request.resolve(this._disposedOpenResult(request.paths));
      }

      this._disposePromise = (async () => {
        try {
          await this._listenerReady;
        } catch (_) {
          // A failed listener has nothing to unsubscribe.
        }
        const unlisten = this._unlisten;
        this._unlisten = null;
        this._started = false;
        this._listenerReady = Promise.resolve(null);
        if (typeof unlisten === "function") await Promise.resolve(unlisten());
        await this._openChain.catch(() => {});
      })();
      return this._disposePromise;
    }

    destroy() {
      return this.dispose();
    }
  }

  return {
    SessionController,
    LEGACY_DRAFT_KEY,
  };
});
