(function initDocumentModel(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const SNAPSHOT_SCHEMA_VERSION = 1;
  const FILE_STATUSES = new Set(["normal", "externally-changed", "missing", "read-error"]);
  const VIEW_MODES = new Set(["split", "edit", "preview"]);
  const RECOVERY_STATUSES = new Set(["clean", "pending", "writing", "failed"]);

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

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

  function requireNonEmptyString(value, name) {
    const string = requireString(value, name);
    if (string.length === 0) throw new TypeError(`${name} must be a non-empty string`);
    return string;
  }

  function requireNonNegativeInteger(value, name) {
    const integer = requireInteger(value, name);
    if (integer < 0) throw new RangeError(`${name} must be non-negative`);
    return integer;
  }

  function requirePersistedRevision(value) {
    if (value === undefined) return -1;
    const integer = requireInteger(value, "persisted revision");
    if (integer < -1) throw new RangeError("persisted revision must be -1 or non-negative");
    return integer;
  }

  function requireRecoveryStatus(value) {
    if (value === undefined) return "clean";
    if (!RECOVERY_STATUSES.has(value)) throw new TypeError("recovery status must be clean, pending, writing, or failed");
    return value;
  }

  function requireFileStatus(value) {
    if (value === undefined) return "normal";
    if (!FILE_STATUSES.has(value)) throw new TypeError("file status must be normal, externally-changed, missing, or read-error");
    return value;
  }

  function requireSnapshotNullableString(snapshot, key) {
    if (!hasOwn(snapshot, key)) throw new TypeError("invalid document snapshot");
    const value = snapshot[key];
    if (value !== null && typeof value !== "string") throw new TypeError("invalid document snapshot");
    return value;
  }

  function requireSnapshotNonNegativeInteger(snapshot, key, label) {
    if (!hasOwn(snapshot, key)) throw new TypeError("invalid document snapshot");
    const value = snapshot[key];
    if (!Number.isInteger(value) || value < 0) throw new TypeError(label);
    return value;
  }

  function cloneWorkspace(workspace) {
    return {
      selectionStart: workspace.selectionStart,
      selectionEnd: workspace.selectionEnd,
      editorScrollTop: workspace.editorScrollTop,
      previewScrollTop: workspace.previewScrollTop,
      viewMode: workspace.viewMode,
      tocOpen: workspace.tocOpen,
      find: {
        open: workspace.find.open,
        query: workspace.find.query,
        replacement: workspace.find.replacement,
        matchIndex: workspace.find.matchIndex,
      },
    };
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
    workspace.editorScrollTop = typeof value.editorScrollTop === "number" && Number.isFinite(value.editorScrollTop) && value.editorScrollTop >= 0 ? value.editorScrollTop : 0;
    workspace.previewScrollTop = typeof value.previewScrollTop === "number" && Number.isFinite(value.previewScrollTop) && value.previewScrollTop >= 0 ? value.previewScrollTop : 0;

    const start = Number.isFinite(value.selectionStart) && value.selectionStart >= 0 ? Math.min(contentLength, Math.trunc(value.selectionStart)) : 0;
    const end = Number.isFinite(value.selectionEnd) && value.selectionEnd >= 0 ? Math.min(contentLength, Math.trunc(value.selectionEnd)) : start;
    workspace.selectionStart = start;
    workspace.selectionEnd = end < start ? start : end;
    if (value.find === undefined || value.find === null) {
      workspace.find = emptyWorkspace().find;
    } else {
      if (typeof value.find !== "object" || Array.isArray(value.find)) throw new TypeError("invalid find state");
      if (value.find.open !== undefined && typeof value.find.open !== "boolean") throw new TypeError("invalid find state");
      if (value.find.query !== undefined && typeof value.find.query !== "string") throw new TypeError("invalid find state");
      if (value.find.replacement !== undefined && typeof value.find.replacement !== "string") throw new TypeError("invalid find state");
      if (value.find.matchIndex !== undefined && !Number.isInteger(value.find.matchIndex)) throw new TypeError("invalid find state");

      workspace.find = {
        open: value.find.open ?? false,
        query: value.find.query ?? "",
        replacement: value.find.replacement ?? "",
        matchIndex: value.find.matchIndex ?? -1,
      };
    }
    return workspace;
  }

  function validateSnapshotWorkspace(workspace) {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new TypeError("invalid document snapshot");
    if (!hasOwn(workspace, "selectionStart") || !hasOwn(workspace, "selectionEnd") || !hasOwn(workspace, "editorScrollTop")
      || !hasOwn(workspace, "previewScrollTop") || !hasOwn(workspace, "viewMode") || !hasOwn(workspace, "tocOpen")
      || !hasOwn(workspace, "find")) {
      throw new TypeError("invalid document snapshot");
    }
    if (!Number.isInteger(workspace.selectionStart) || workspace.selectionStart < 0) throw new TypeError("selection start must be a non-negative integer");
    if (!Number.isInteger(workspace.selectionEnd) || workspace.selectionEnd < 0) throw new TypeError("selection end must be a non-negative integer");
    if (typeof workspace.editorScrollTop !== "number" || !Number.isFinite(workspace.editorScrollTop) || workspace.editorScrollTop < 0) {
      throw new TypeError("editor scroll top must be a non-negative finite number");
    }
    if (typeof workspace.previewScrollTop !== "number" || !Number.isFinite(workspace.previewScrollTop) || workspace.previewScrollTop < 0) {
      throw new TypeError("preview scroll top must be a non-negative finite number");
    }
    if (!VIEW_MODES.has(workspace.viewMode)) throw new TypeError("invalid view mode");
    if (typeof workspace.tocOpen !== "boolean") throw new TypeError("invalid workspace");
    if (!workspace.find || typeof workspace.find !== "object" || Array.isArray(workspace.find)) throw new TypeError("invalid find state");
    if (!hasOwn(workspace.find, "open") || !hasOwn(workspace.find, "query") || !hasOwn(workspace.find, "replacement") || !hasOwn(workspace.find, "matchIndex")) {
      throw new TypeError("invalid document snapshot");
    }
    if (typeof workspace.find.open !== "boolean") throw new TypeError("invalid find state");
    if (typeof workspace.find.query !== "string") throw new TypeError("invalid find state");
    if (typeof workspace.find.replacement !== "string") throw new TypeError("invalid find state");
    if (!Number.isInteger(workspace.find.matchIndex)) throw new TypeError("invalid find state");
    return {
      selectionStart: Math.trunc(workspace.selectionStart),
      selectionEnd: Math.trunc(workspace.selectionEnd),
      editorScrollTop: workspace.editorScrollTop,
      previewScrollTop: workspace.previewScrollTop,
      viewMode: workspace.viewMode,
      tocOpen: workspace.tocOpen,
      find: {
        open: workspace.find.open,
        query: workspace.find.query,
        replacement: workspace.find.replacement,
        matchIndex: workspace.find.matchIndex,
      },
    };
  }

  class DocumentModel {
    constructor(input) {
      if (!input || typeof input !== "object") throw new TypeError("document id and display name are required");

      this.id = requireString(input.id, "document id");
      this.displayName = requireString(input.displayName, "display name");
      this.path = optionalString(input.path, "path");
      this.canonicalPath = optionalString(input.canonicalPath, "canonical path");
      this.content = typeof input.content === "string" ? input.content : "";
      this.editRevision = input.editRevision === undefined
        ? 0
        : requireNonNegativeInteger(input.editRevision, "edit revision");
      this.persistedRevision = requirePersistedRevision(input.persistedRevision);
      this.snapshotRevision = input.snapshotRevision === undefined
        ? 0
        : requireNonNegativeInteger(input.snapshotRevision, "snapshot revision");
      this.savedContentSha256 = requireString(input.savedContentSha256, "saved content sha256");
      this.expectedDiskSha256 = optionalString(input.expectedDiskSha256, "expected disk sha256");
      this.fileStatus = requireFileStatus(input.fileStatus);
      this.workspace = normalizeWorkspace(input.workspace, this.content.length);
      this.dirty = typeof input.dirty === "boolean" ? input.dirty : false;
      this.recoveryStatus = requireRecoveryStatus(input.recoveryStatus);
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
      return true;
    }

    recordSave(result) {
      if (!result || typeof result !== "object") throw new TypeError("save result is required");

      const editRevision = requireNonNegativeInteger(result.editRevision, "edit revision");
      const savedContentSha256 = requireNonEmptyString(result.contentSha256, "content sha256");
      const expectedDiskSha256 = requireNonEmptyString(result.diskSha256, "disk sha256");

      this.savedContentSha256 = savedContentSha256;
      this.expectedDiskSha256 = expectedDiskSha256;
      this.fileStatus = "normal";
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
        workspace: cloneWorkspace(this.workspace),
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
      let path;
      let canonicalPath;
      let expectedDiskSha256;
      let fileStatus;
      let workspace;
      let recoveryStatus;

      try {
        documentId = requireString(value.documentId, "document id");
        displayName = requireString(value.displayName, "display name");
        content = requireString(value.content, "content");
        savedContentSha256 = requireString(value.savedContentSha256, "saved content sha256");
        path = requireSnapshotNullableString(value, "path");
        canonicalPath = requireSnapshotNullableString(value, "canonicalPath");
        expectedDiskSha256 = requireSnapshotNullableString(value, "expectedDiskSha256");
        if (!hasOwn(value, "fileStatus") || !FILE_STATUSES.has(value.fileStatus)) throw new TypeError("invalid file status");
        fileStatus = value.fileStatus;
        recoveryStatus = hasOwn(value, "recoveryStatus") ? requireRecoveryStatus(value.recoveryStatus) : "clean";
        snapshotRevision = requireSnapshotNonNegativeInteger(value, "snapshotRevision", "snapshot revision must be a non-negative integer");
        editRevision = requireSnapshotNonNegativeInteger(value, "editRevision", "edit revision must be a non-negative integer");
        workspace = value.workspace;
      } catch (error) {
        if (error instanceof TypeError && error.message !== "invalid file status") throw new TypeError("invalid document snapshot");
        throw error;
      }

      const normalizedWorkspace = validateSnapshotWorkspace(workspace);
      const clampedSelectionStart = Math.min(content.length, normalizedWorkspace.selectionStart);
      const clampedSelectionEnd = Math.min(content.length, Math.max(clampedSelectionStart, normalizedWorkspace.selectionEnd));

      return new DocumentModel({
        id: documentId,
        displayName,
        path,
        canonicalPath,
        content,
        editRevision,
        persistedRevision: editRevision,
        snapshotRevision,
        savedContentSha256,
        expectedDiskSha256,
        fileStatus,
        workspace: {
          ...normalizedWorkspace,
          selectionStart: clampedSelectionStart,
          selectionEnd: clampedSelectionEnd,
        },
        recoveryStatus,
      });
    }
  }

  return { DocumentModel, emptyWorkspace, SNAPSHOT_SCHEMA_VERSION };
});
