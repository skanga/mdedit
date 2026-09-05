(function initDocumentModel(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const SNAPSHOT_SCHEMA_VERSION = 1;
  const FILE_STATUSES = new Set(["normal", "externally-changed", "missing", "read-error"]);
  const VIEW_MODES = new Set(["split", "edit", "preview"]);

  function emptyWorkspace() {
    return {
      selectionStart: 0,
      selectionEnd: 0,
      editorScrollTop: 0,
      previewScrollTop: 0,
      viewMode: "split",
      tocOpen: false,
      find: {
        open: false,
        query: "",
        replacement: "",
        matchIndex: -1,
      },
    };
  }

  function requireString(value, name) {
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    return value;
  }

  function optionalString(value, name) {
    if (value === undefined || value === null) return null;
    return requireString(value, name);
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

  function normalizeScrollTop(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function normalizeSelection(value, max, fallback) {
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(max, Math.trunc(value));
  }

  function normalizeFind(value) {
    const find = emptyWorkspace().find;
    if (value === undefined || value === null) return find;
    if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid find state");

    if (value.open !== undefined && typeof value.open !== "boolean") throw new TypeError("invalid find state");
    if (value.query !== undefined && typeof value.query !== "string") throw new TypeError("invalid find state");
    if (value.replacement !== undefined && typeof value.replacement !== "string") throw new TypeError("invalid find state");
    if (value.matchIndex !== undefined && !Number.isInteger(value.matchIndex)) throw new TypeError("invalid find state");

    find.open = value.open ?? find.open;
    find.query = value.query ?? find.query;
    find.replacement = value.replacement ?? find.replacement;
    find.matchIndex = value.matchIndex ?? find.matchIndex;
    return find;
  }

  function normalizeWorkspace(value, contentLength) {
    const workspace = emptyWorkspace();
    if (value === undefined || value === null) return workspace;
    if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("workspace must be an object");

    if (value.viewMode !== undefined && (!VIEW_MODES.has(value.viewMode) || typeof value.viewMode !== "string")) {
      throw new TypeError("invalid view mode");
    }
    if (value.tocOpen !== undefined && typeof value.tocOpen !== "boolean") throw new TypeError("invalid workspace");

    workspace.viewMode = value.viewMode ?? workspace.viewMode;
    workspace.tocOpen = value.tocOpen ?? workspace.tocOpen;
    workspace.editorScrollTop = normalizeScrollTop(value.editorScrollTop);
    workspace.previewScrollTop = normalizeScrollTop(value.previewScrollTop);

    const start = normalizeSelection(value.selectionStart, contentLength, 0);
    const end = normalizeSelection(value.selectionEnd, contentLength, start);
    workspace.selectionStart = start;
    workspace.selectionEnd = end < start ? start : end;
    workspace.find = normalizeFind(value.find);
    return workspace;
  }

  class DocumentModel {
    constructor(input) {
      if (!input || typeof input !== "object") throw new TypeError("document id and display name are required");

      this.id = requireString(input.id, "document id");
      this.displayName = requireString(input.displayName, "display name");
      this.path = optionalString(input.path, "path");
      this.canonicalPath = optionalString(input.canonicalPath, "canonical path");
      this.content = typeof input.content === "string" ? input.content : "";
      this.editRevision = Number.isInteger(input.editRevision) ? input.editRevision : 0;
      this.persistedRevision = Number.isInteger(input.persistedRevision) ? input.persistedRevision : -1;
      this.snapshotRevision = Number.isInteger(input.snapshotRevision) ? input.snapshotRevision : 0;
      this.savedContentSha256 = requireString(input.savedContentSha256, "saved content sha256");
      this.expectedDiskSha256 = optionalString(input.expectedDiskSha256, "expected disk sha256");
      this.fileStatus = FILE_STATUSES.has(input.fileStatus) ? input.fileStatus : "normal";
      this.workspace = normalizeWorkspace(input.workspace, this.content.length);
      this.dirty = typeof input.dirty === "boolean" ? input.dirty : false;
      this.recoveryStatus = typeof input.recoveryStatus === "string" ? input.recoveryStatus : "clean";
    }

    applyContent(content) {
      requireString(content, "content");
      if (content === this.content) return false;

      this.content = content;
      this.editRevision += 1;
      this.dirty = true;
      this.recoveryStatus = "pending";
      return true;
    }

    reconcileDirty(contentSha256, editRevision) {
      requireString(contentSha256, "content sha256");
      requireNonNegativeInteger(editRevision, "edit revision");
      if (editRevision !== this.editRevision) return false;

      this.dirty = contentSha256 !== this.savedContentSha256;
      if (!this.dirty) this.recoveryStatus = "clean";
      return true;
    }

    recordSave(result) {
      if (!result || typeof result !== "object") throw new TypeError("save result is required");

      const editRevision = requireNonNegativeInteger(result.editRevision, "edit revision");
      this.savedContentSha256 = requireString(result.contentSha256, "content sha256");
      this.expectedDiskSha256 = requireString(result.diskSha256, "disk sha256");
      this.persistedRevision = editRevision;
      this.fileStatus = "normal";
      this.recoveryStatus = "clean";
      this.dirty = this.editRevision !== editRevision;
    }

    toSnapshot() {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        documentId: this.id,
        snapshotRevision: this.snapshotRevision,
        editRevision: this.editRevision,
        displayName: this.displayName,
        path: this.path,
        canonicalPath: this.canonicalPath,
        content: this.content,
        savedContentSha256: this.savedContentSha256,
        expectedDiskSha256: this.expectedDiskSha256,
        fileStatus: this.fileStatus,
        workspace: this.workspace,
      };
    }

    static fromSnapshot(value) {
      if (!value || typeof value !== "object") throw new TypeError("invalid document snapshot");
      if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error("unsupported snapshot schema version");

      let documentId;
      let displayName;
      let content;
      let snapshotRevision;
      let editRevision;
      let savedContentSha256;

      try {
        documentId = requireString(value.documentId, "document id");
        displayName = requireString(value.displayName, "display name");
        content = requireString(value.content, "content");
        savedContentSha256 = requireString(value.savedContentSha256, "saved content sha256");
      } catch (error) {
        throw new TypeError("invalid document snapshot");
      }

      if (!value.workspace || typeof value.workspace !== "object" || Array.isArray(value.workspace)) {
        throw new TypeError("invalid document snapshot");
      }
      if (value.snapshotRevision === undefined || value.editRevision === undefined) {
        throw new TypeError("invalid document snapshot");
      }
      snapshotRevision = requireNonNegativeInteger(value.snapshotRevision, "snapshot revision");
      editRevision = requireNonNegativeInteger(value.editRevision, "edit revision");
      if (!FILE_STATUSES.has(value.fileStatus)) throw new TypeError("invalid file status");

      const workspace = normalizeWorkspace(value.workspace, content.length);
      workspace.selectionStart = normalizeSelection(workspace.selectionStart, content.length, 0);
      workspace.selectionEnd = normalizeSelection(workspace.selectionEnd, content.length, workspace.selectionStart);
      workspace.editorScrollTop = normalizeScrollTop(workspace.editorScrollTop);
      workspace.previewScrollTop = normalizeScrollTop(workspace.previewScrollTop);

      return new DocumentModel({
        id: documentId,
        displayName,
        path: value.path,
        canonicalPath: value.canonicalPath,
        content,
        editRevision,
        persistedRevision: editRevision,
        snapshotRevision,
        savedContentSha256,
        expectedDiskSha256: value.expectedDiskSha256,
        fileStatus: value.fileStatus,
        workspace,
        recoveryStatus: typeof value.recoveryStatus === "string" ? value.recoveryStatus : "clean",
      });
    }
  }

  return { DocumentModel, emptyWorkspace, SNAPSHOT_SCHEMA_VERSION };
});
