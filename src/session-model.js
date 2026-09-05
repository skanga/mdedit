(function initSessionModel(root, factory) {
  const api = factory(root);

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, (root) => {
  "use strict";

  const SESSION_SCHEMA_VERSION = 1;
  const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  let DocumentModel;
  if (typeof module !== "undefined" && module.exports) {
    ({ DocumentModel } = require("./document-model.js"));
  } else if (root && root.MDEdit && root.MDEdit.DocumentModel) {
    ({ DocumentModel } = root.MDEdit);
  } else {
    throw new Error("DocumentModel is required");
  }

  function getDefaultIdFactory() {
    if (root && root.crypto && typeof root.crypto.randomUUID === "function") {
      return () => root.crypto.randomUUID();
    }
    if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return () => globalThis.crypto.randomUUID();
    }
    if (typeof require === "function") {
      const { randomUUID } = require("node:crypto");
      return () => randomUUID();
    }
    throw new Error("random UUID generation is unavailable");
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function requireString(value, name) {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
  }

  function requireNonEmptyString(value, name) {
    const string = requireString(value, name);
    if (string.length === 0) throw new TypeError(`${name} must be a non-empty string`);
    return string;
  }

  function requireInteger(value, name) {
    if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
    return value;
  }

  function requireNonNegativeInteger(value, name) {
    const integer = requireInteger(value, name);
    if (integer < 0) throw new RangeError(`${name} must be non-negative`);
    return integer;
  }

  function requirePositiveInteger(value, name) {
    const integer = requireInteger(value, name);
    if (integer < 1) throw new RangeError(`${name} must be a positive integer`);
    return integer;
  }

  function normalizeLoadingStub(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new TypeError("document is required");
    }

    const id = requireNonEmptyString(document.id, "document id");
    const displayName = requireNonEmptyString(document.displayName, "display name");
    const snapshotRevision = requireNonNegativeInteger(document.snapshotRevision, "snapshot revision");

    let canonicalPath = null;
    if (hasOwn(document, "canonicalPath") && document.canonicalPath !== null) {
      canonicalPath = requireNonEmptyString(document.canonicalPath, "canonical path");
    }

    return {
      id,
      displayName,
      canonicalPath,
      snapshotRevision,
    };
  }

  function validateManifestTab(tab) {
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) {
      throw new TypeError("invalid tab entry");
    }

    const documentId = requireNonEmptyString(tab.documentId, "document id");
    let displayName;
    try {
      displayName = requireNonEmptyString(tab.displayName, "display name");
    } catch (error) {
      throw new TypeError("invalid tab label");
    }
    const snapshotRevision = requireNonNegativeInteger(tab.snapshotRevision, "snapshot revision");

    let canonicalPath = null;
    if (hasOwn(tab, "canonicalPath")) {
      if (tab.canonicalPath === null) {
        canonicalPath = null;
      } else {
        try {
          canonicalPath = requireNonEmptyString(tab.canonicalPath, "canonical path");
        } catch (error) {
          throw new TypeError("invalid canonical path");
        }
      }
    }

    return {
      documentId,
      displayName,
      canonicalPath,
      snapshotRevision,
    };
  }

  function createLoadingStub(entry) {
    return {
      id: entry.documentId,
      displayName: entry.displayName,
      canonicalPath: entry.canonicalPath,
      snapshotRevision: entry.snapshotRevision,
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  class SessionModel {
    constructor({ idFactory } = {}) {
      if (idFactory !== undefined && typeof idFactory !== "function") {
        throw new TypeError("idFactory must be a function");
      }

      this.documents = new Map();
      this.tabOrder = [];
      this.activeDocumentId = null;
      this.nextUntitledNumber = 1;
      this.generation = 0;
      this._idFactory = idFactory || getDefaultIdFactory();
    }

    add(document) {
      const entry = document instanceof DocumentModel ? document : normalizeLoadingStub(document);

      if (this.documents.has(entry.id)) {
        throw new Error("duplicate document id");
      }
      if (entry.canonicalPath !== null && this.findByCanonicalPath(entry.canonicalPath) !== null) {
        throw new Error("duplicate canonical path");
      }

      this.documents.set(entry.id, entry);
      this.tabOrder.push(entry.id);
      this.activeDocumentId = entry.id;
      this.generation += 1;
      return entry;
    }

    createUntitled() {
      const id = this._idFactory();
      const document = new DocumentModel({
        id,
        displayName: `Untitled ${this.nextUntitledNumber}`,
        path: null,
        canonicalPath: null,
        content: "",
        snapshotRevision: 0,
        savedContentSha256: EMPTY_CONTENT_SHA256,
      });

      this.add(document);
      this.nextUntitledNumber += 1;
      return document;
    }

    activate(id) {
      requireNonEmptyString(id, "document id");
      if (!this.documents.has(id)) throw new Error("unknown document id");
      if (this.activeDocumentId !== id) {
        this.activeDocumentId = id;
        this.generation += 1;
      }
      return this.documents.get(id);
    }

    remove(id) {
      requireNonEmptyString(id, "document id");
      if (!this.documents.has(id)) throw new Error("unknown document id");

      const index = this.tabOrder.indexOf(id);
      const removed = this.documents.get(id);
      const wasActive = this.activeDocumentId === id;

      this.documents.delete(id);
      this.tabOrder.splice(index, 1);

      let nextActiveId = this.activeDocumentId;
      if (wasActive) {
        if (this.tabOrder.length === 0) {
          nextActiveId = null;
          this.activeDocumentId = null;
        } else {
          const nextIndex = clamp(index, 0, this.tabOrder.length - 1);
          nextActiveId = this.tabOrder[nextIndex];
          this.activeDocumentId = nextActiveId;
        }
      }

      this.generation += 1;
      return { removed, nextActiveId };
    }

    move(id, delta) {
      requireNonEmptyString(id, "document id");
      if (!this.documents.has(id)) throw new Error("unknown document id");
      requireInteger(delta, "delta");

      const from = this.tabOrder.indexOf(id);
      const to = clamp(from + delta, 0, this.tabOrder.length - 1);
      if (from !== to) {
        this.tabOrder.splice(from, 1);
        this.tabOrder.splice(to, 0, id);
        this.generation += 1;
      }

      return this.documents.get(id);
    }

    findByCanonicalPath(path) {
      if (typeof path !== "string") return null;
      for (const document of this.documents.values()) {
        if (document.canonicalPath === path) return document;
      }
      return null;
    }

    toManifest() {
      return {
        schemaVersion: SESSION_SCHEMA_VERSION,
        generation: this.generation,
        activeDocumentId: this.activeDocumentId,
        nextUntitledNumber: this.nextUntitledNumber,
        tabs: this.tabOrder.map((documentId) => {
          const document = this.documents.get(documentId);
          return {
            documentId,
            displayName: document.displayName,
            snapshotRevision: document.snapshotRevision,
          };
        }),
      };
    }

    static fromManifest(value, { idFactory } = {}) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("invalid session manifest");
      }
      if (value.schemaVersion !== SESSION_SCHEMA_VERSION) {
        throw new Error("unsupported session schema version");
      }

      const generation = requireNonNegativeInteger(value.generation, "generation");
      const nextUntitledNumber = requirePositiveInteger(value.nextUntitledNumber, "next untitled number");

      if (!Array.isArray(value.tabs) || value.tabs.length === 0) {
        throw new TypeError("tabs must not be empty");
      }

      const session = new SessionModel({ idFactory });
      session.generation = generation;
      session.nextUntitledNumber = nextUntitledNumber;

      const seenIds = new Set();
      const seenCanonicalPaths = new Set();
      const tabs = [];

      for (const tab of value.tabs) {
        const entry = validateManifestTab(tab);
        if (seenIds.has(entry.documentId)) {
          throw new Error("duplicate document id");
        }
        if (entry.canonicalPath !== null) {
          if (seenCanonicalPaths.has(entry.canonicalPath)) {
            throw new Error("duplicate canonical path");
          }
          seenCanonicalPaths.add(entry.canonicalPath);
        }
        seenIds.add(entry.documentId);
        tabs.push(entry);
      }

      if (!hasOwn(value, "activeDocumentId") || value.activeDocumentId === null || value.activeDocumentId === undefined) {
        throw new Error("active document id is required");
      }
      if (typeof value.activeDocumentId !== "string" || value.activeDocumentId.length === 0) {
        throw new TypeError("active document id must be a non-empty string");
      }
      if (!seenIds.has(value.activeDocumentId)) {
        throw new Error("unknown active document id");
      }

      for (const tab of tabs) {
        const stub = createLoadingStub(tab);
        session.documents.set(stub.id, stub);
        session.tabOrder.push(stub.id);
      }

      session.activeDocumentId = value.activeDocumentId;
      return session;
    }
  }

  return {
    SessionModel,
    SESSION_SCHEMA_VERSION,
  };
});
