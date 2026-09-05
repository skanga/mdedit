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
      this._pendingOpenedPaths = [];
      this._eventOpenChain = Promise.resolve();
      this._manifestWrites = Promise.resolve();
      this._restorePromise = null;
      this._restoring = false;
      this._loadQueue = [];
      this._loadingIds = new Set();
      this._loadPriority = new Set();

      this.start();
    }

    start() {
      if (this._started) return this._listenerReady;
      this._started = true;

      const source = typeof this.io.listenFileOpened === "function"
        ? this.io
        : (typeof this.io.onFileOpened === "function" ? this.io : this.dialogs);
      const listen = source === this.io
        ? (this.io.listenFileOpened || this.io.onFileOpened)
        : (this.dialogs.listenFileOpened || this.dialogs.onFileOpened);
      if (typeof listen !== "function") return this._listenerReady;

      const registration = listen.call(source, (event) => this._handleFileOpened(event));
      if (!registration || typeof registration.then !== "function") {
        this._unlisten = registration;
      }
      this._listenerReady = Promise.resolve(registration).then(
        (unlisten) => {
          this._unlisten = unlisten;
          return unlisten;
        },
        () => null,
      );
      return this._listenerReady;
    }

    restore() {
      if (this._restorePromise) return this._restorePromise;
      this._restoring = true;
      this.start();

      this._restorePromise = this._restore().then(async () => {
        while (this._pendingOpenedPaths.length > 0) {
          const paths = this._pendingOpenedPaths.splice(0);
          await this.openPaths(paths);
        }
        return this.session;
      }).finally(() => {
        this._restoring = false;
      });
      return this._restorePromise;
    }

    async _restore() {
      await this._listenerReady;
      let rawManifest;
      try {
        rawManifest = await this.io.loadRecoveryManifest();
      } catch (reason) {
        await this._showRecoveryError(reason, { phase: "manifest" });
        this._createFreshSession();
        return;
      }

      if (rawManifest === null) {
        const imported = await this.importLegacyDraft();
        if (!imported) this._createFreshSession();
        return;
      }

      try {
        await this.restoreManifest(rawManifest);
      } catch (reason) {
        await this._showRecoveryError(reason, { phase: "manifest" });
        this._createFreshSession();
      }
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
      this._loadQueue = [
        ...inactiveIds.filter((id) => this._loadPriority.has(id)),
        ...inactiveIds.filter((id) => !this._loadPriority.has(id)),
      ];
      this._loadPriority.clear();

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
      let rawDraft;
      try {
        rawDraft = this.legacyStorage.getItem(LEGACY_DRAFT_KEY);
      } catch (_) {
        return null;
      }
      if (!rawDraft) return null;

      let draft;
      try {
        draft = JSON.parse(rawDraft);
      } catch (_) {
        return null;
      }
      if (!draft || typeof draft !== "object" || Array.isArray(draft)
          || typeof draft.text !== "string" || !draft.text.trim()) {
        return null;
      }

      const savedContentSha256 = await this.hashText("");
      const document = new DocumentModel({
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
      this._ensureSession().add(document);
      this._renderSession();
      this._renderDocument(document);

      try {
        this.scheduler.changed(document.id, document.editRevision);
        await this.scheduler.flush(document.id, document.editRevision);
        await this.persistManifest();
        this.legacyStorage.removeItem(LEGACY_DRAFT_KEY);
      } catch (reason) {
        await this._showRecoveryError(reason, {
          phase: "legacy-migration",
          documentId: document.id,
          displayName: document.displayName,
          snapshotRevision: document.snapshotRevision,
        });
      }
      return document;
    }

    async openPaths(paths) {
      if (!Array.isArray(paths)) throw new TypeError("paths must be an array");
      const opened = [];
      const openedIds = new Set();
      const failed = [];

      for (const path of paths) {
        try {
          const result = await this.io.readDocument(path);
          const document = this.openReadResult(result);
          if (!openedIds.has(document.id)) {
            openedIds.add(document.id);
            opened.push(document);
          }
        } catch (reason) {
          const error = normalizeError(reason);
          failed.push({ path, error });
          if (typeof this.dialogs.showOpenError === "function") {
            try {
              this.dialogs.showOpenError(path, error);
            } catch (_) {
              // Dialog failures must not block the remaining selected files.
            }
          }
        }
      }
      return { opened, failed };
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
          this._loadPriority.add(id);
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
        await this.view.showRecoveryError(details);
      }
      return details;
    }

    _handleFileOpened(event) {
      const path = typeof event === "string" ? event : event && event.payload;
      if (typeof path !== "string" || path.length === 0) return Promise.resolve();
      if (this._restoring || !this.session) {
        this._pendingOpenedPaths.push(path);
        return Promise.resolve();
      }

      this._eventOpenChain = this._eventOpenChain.then(() => this.openPaths([path]));
      return this._eventOpenChain;
    }
  }

  return {
    SessionController,
    LEGACY_DRAFT_KEY,
  };
});
