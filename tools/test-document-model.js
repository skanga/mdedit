const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { DocumentModel, emptyWorkspace, SNAPSHOT_SCHEMA_VERSION } = require("../src/document-model.js");

const EMPTY_SHA = "sha-empty";

function baseSnapshot(overrides = {}) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    documentId: "doc-1",
    snapshotRevision: 3,
    editRevision: 4,
    displayName: "notes.md",
    path: "/documents/notes.md",
    canonicalPath: "/documents/notes.md",
    content: "abc",
    savedContentSha256: "sha-abc",
    expectedDiskSha256: "disk-abc",
    fileStatus: "normal",
    workspace: {
      ...emptyWorkspace(),
      selectionStart: 99,
      selectionEnd: 100,
      editorScrollTop: -12,
      previewScrollTop: Number.POSITIVE_INFINITY,
      viewMode: "split",
    },
    ...overrides,
  };
}

test("browser wrapper merges the API into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "document-model.js"), "utf8");
  const sandbox = { window: {} };

  vm.runInNewContext(code, sandbox, { filename: "document-model.js" });

  assert.equal(typeof sandbox.window.MDEdit.DocumentModel, "function");
  assert.equal(typeof sandbox.window.MDEdit.emptyWorkspace, "function");
  assert.equal(sandbox.window.MDEdit.SNAPSHOT_SCHEMA_VERSION, 1);
});

test("blank untitled documents start clean with the empty-content hash", () => {
  const doc = new DocumentModel({
    id: "doc-untitled",
    displayName: "Untitled",
    content: "",
    savedContentSha256: EMPTY_SHA,
  });

  assert.equal(doc.id, "doc-untitled");
  assert.equal(doc.displayName, "Untitled");
  assert.equal(doc.content, "");
  assert.equal(doc.dirty, false);
  assert.deepEqual(doc.workspace, emptyWorkspace());
});

test("applyContent increments the edit revision and marks recovery pending", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
  });

  assert.equal(doc.applyContent("ab"), true);
  assert.equal(doc.content, "ab");
  assert.equal(doc.editRevision, 1);
  assert.equal(doc.dirty, true);
  assert.equal(doc.recoveryStatus, "pending");
});

test("reconcileDirty ignores stale revisions and clears matching content", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
  });

  doc.applyContent("ab");
  doc.applyContent("a");

  assert.equal(doc.reconcileDirty("sha-a", 1), false);
  assert.equal(doc.dirty, true);

  assert.equal(doc.reconcileDirty("sha-a", 2), true);
  assert.equal(doc.dirty, false);
});

test("recordSave updates the save baseline without clearing dirty after a newer edit", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
  });

  doc.applyContent("ab");

  doc.recordSave({
    editRevision: 0,
    contentSha256: "sha-first",
    diskSha256: "disk-first",
  });

  assert.equal(doc.savedContentSha256, "sha-first");
  assert.equal(doc.expectedDiskSha256, "disk-first");
  assert.equal(doc.fileStatus, "normal");
  assert.equal(doc.dirty, true);
});

test("fromSnapshot restores state and clamps selection and scroll positions", () => {
  const doc = DocumentModel.fromSnapshot(baseSnapshot());

  assert.equal(doc.id, "doc-1");
  assert.equal(doc.displayName, "notes.md");
  assert.equal(doc.editRevision, 4);
  assert.equal(doc.snapshotRevision, 3);
  assert.equal(doc.persistedRevision, 4);
  assert.equal(doc.workspace.selectionStart, 3);
  assert.equal(doc.workspace.selectionEnd, 3);
  assert.equal(doc.workspace.editorScrollTop, 0);
  assert.equal(doc.workspace.previewScrollTop, 0);
  assert.equal(doc.workspace.viewMode, "split");
});

test("fromSnapshot rejects unsupported schema versions", () => {
  assert.throws(() => DocumentModel.fromSnapshot({ schemaVersion: 2 }), /schema version/i);
});

test("fromSnapshot rejects missing required fields", () => {
  assert.throws(() => DocumentModel.fromSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION }), /invalid document snapshot/i);
});

test("fromSnapshot rejects invalid file status, view mode, and revisions", () => {
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({ fileStatus: "broken" })),
    /file status/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({
      workspace: { ...emptyWorkspace(), viewMode: "diagram" },
    })),
    /view mode/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({ editRevision: "4" })),
    /revision/i,
  );
});
