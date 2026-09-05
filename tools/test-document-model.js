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
      editorScrollTop: 12,
      previewScrollTop: 34,
      viewMode: "split",
    },
    ...overrides,
  };
}

function modelState(doc) {
  return {
    content: doc.content,
    editRevision: doc.editRevision,
    dirty: doc.dirty,
    recoveryStatus: doc.recoveryStatus,
    persistedRevision: doc.persistedRevision,
    savedContentSha256: doc.savedContentSha256,
    expectedDiskSha256: doc.expectedDiskSha256,
    fileStatus: doc.fileStatus,
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

test("constructor rejects negative revisions except the persisted sentinel", () => {
  assert.throws(
    () => new DocumentModel({
      id: "doc-1",
      displayName: "a.md",
      content: "",
      savedContentSha256: EMPTY_SHA,
      editRevision: -1,
    }),
    /edit revision/i,
  );
  assert.throws(
    () => new DocumentModel({
      id: "doc-1",
      displayName: "a.md",
      content: "",
      savedContentSha256: EMPTY_SHA,
      snapshotRevision: -1,
    }),
    /snapshot revision/i,
  );
  assert.throws(
    () => new DocumentModel({
      id: "doc-1",
      displayName: "a.md",
      content: "",
      savedContentSha256: EMPTY_SHA,
      persistedRevision: -2,
    }),
    /persisted revision/i,
  );
  assert.throws(
    () => new DocumentModel({
      id: "doc-1",
      displayName: "a.md",
      content: "",
      savedContentSha256: EMPTY_SHA,
      fileStatus: "broken",
    }),
    /file status/i,
  );
  assert.throws(
    () => new DocumentModel({
      id: "doc-1",
      displayName: "a.md",
      content: "",
      savedContentSha256: EMPTY_SHA,
      recoveryStatus: "glitched",
    }),
    /recovery status/i,
  );
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

test("applyContent returns false for identical content and leaves state unchanged", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
    dirty: true,
    recoveryStatus: "pending",
  });
  const before = modelState(doc);

  assert.equal(doc.applyContent("a"), false);
  assert.deepEqual(modelState(doc), before);
});

test("reconcileDirty preserves recovery status while updating dirty state", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
  });

  doc.applyContent("ab");
  doc.applyContent("a");
  doc.recoveryStatus = "pending";

  assert.equal(doc.reconcileDirty("sha-a", 1), false);
  assert.equal(doc.dirty, true);
  assert.equal(doc.recoveryStatus, "pending");

  for (const recoveryStatus of ["clean", "pending", "writing", "failed"]) {
    doc.recoveryStatus = recoveryStatus;
    assert.equal(doc.reconcileDirty("sha-a", 2), true);
    assert.equal(doc.dirty, false);
    assert.equal(doc.recoveryStatus, recoveryStatus);
  }
});

test("recordSave updates the save baseline without changing recovery state", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
  });

  doc.applyContent("ab");
  doc.recoveryStatus = "pending";
  const before = modelState(doc);

  doc.recordSave({
    editRevision: 0,
    contentSha256: "sha-first",
    diskSha256: "disk-first",
  });

  assert.equal(doc.savedContentSha256, "sha-first");
  assert.equal(doc.expectedDiskSha256, "disk-first");
  assert.equal(doc.fileStatus, "normal");
  assert.equal(doc.dirty, true);
  assert.equal(doc.persistedRevision, -1);
  assert.equal(doc.recoveryStatus, "pending");
});

test("recordSave rejects invalid results without mutating the model", () => {
  const doc = new DocumentModel({
    id: "doc-1",
    displayName: "a.md",
    content: "a",
    savedContentSha256: "sha-a",
    expectedDiskSha256: "disk-a",
    fileStatus: "externally-changed",
    recoveryStatus: "writing",
  });
  doc.applyContent("ab");
  doc.recoveryStatus = "writing";
  const before = modelState(doc);

  assert.throws(
    () => doc.recordSave({
      editRevision: doc.editRevision,
      contentSha256: "sha-next",
      diskSha256: "",
    }),
    /disk sha256/i,
  );
  assert.deepEqual(modelState(doc), before);
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
  assert.equal(doc.workspace.editorScrollTop, 12);
  assert.equal(doc.workspace.previewScrollTop, 34);
  assert.equal(doc.workspace.viewMode, "split");
});

test("fromSnapshot rejects missing or invalid required snapshot fields", () => {
  const missingPath = baseSnapshot();
  delete missingPath.path;
  assert.throws(() => DocumentModel.fromSnapshot(missingPath), /invalid document snapshot/i);

  const invalidExpectedDisk = baseSnapshot({ expectedDiskSha256: 7 });
  assert.throws(() => DocumentModel.fromSnapshot(invalidExpectedDisk), /invalid document snapshot/i);

  const missingWorkspaceField = baseSnapshot();
  delete missingWorkspaceField.workspace.selectionStart;
  assert.throws(() => DocumentModel.fromSnapshot(missingWorkspaceField), /invalid document snapshot/i);

  const missingFindField = baseSnapshot();
  delete missingFindField.workspace.find.replacement;
  assert.throws(() => DocumentModel.fromSnapshot(missingFindField), /invalid document snapshot/i);
});

test("fromSnapshot rejects unsupported schema versions", () => {
  assert.throws(() => DocumentModel.fromSnapshot({ schemaVersion: 2 }), /schema version/i);
});

test("fromSnapshot rejects missing required fields", () => {
  assert.throws(() => DocumentModel.fromSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION }), /invalid document snapshot/i);
});

test("fromSnapshot rejects invalid file status, view mode, revisions, and numeric bounds", () => {
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
    /invalid document snapshot/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({
      workspace: {
        ...emptyWorkspace(),
        selectionStart: -9,
        selectionEnd: 1,
        editorScrollTop: 0,
        previewScrollTop: 0,
      },
    })),
    /selection start/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({
      workspace: {
        ...emptyWorkspace(),
        selectionStart: 0,
        selectionEnd: Number.POSITIVE_INFINITY,
        editorScrollTop: 0,
        previewScrollTop: 0,
      },
    })),
    /selection end/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({
      workspace: {
        ...emptyWorkspace(),
        selectionStart: 0,
        selectionEnd: 0,
        editorScrollTop: -12,
        previewScrollTop: 0,
      },
    })),
    /editor scroll top/i,
  );
  assert.throws(
    () => DocumentModel.fromSnapshot(baseSnapshot({
      workspace: {
        ...emptyWorkspace(),
        selectionStart: 0,
        selectionEnd: 0,
        editorScrollTop: 0,
        previewScrollTop: Number.NaN,
      },
    })),
    /preview scroll top/i,
  );
});

test("toSnapshot returns a detached snapshot tree", () => {
  const doc = DocumentModel.fromSnapshot(baseSnapshot());
  const snapshot = doc.toSnapshot();

  snapshot.workspace.selectionStart = 0;
  snapshot.workspace.find.query = "changed";
  snapshot.workspace.find.matchIndex = 99;
  snapshot.content = "mutated";

  assert.equal(doc.workspace.selectionStart, 3);
  assert.equal(doc.workspace.find.query, "");
  assert.equal(doc.content, "abc");

  doc.workspace.selectionStart = 1;
  doc.workspace.find.query = "doc";
  doc.content = "xyz";

  assert.equal(snapshot.workspace.selectionStart, 0);
  assert.equal(snapshot.workspace.find.query, "changed");
  assert.equal(snapshot.content, "mutated");

  assert.deepEqual(Object.keys(snapshot).sort(), [
    "canonicalPath",
    "content",
    "displayName",
    "documentId",
    "editRevision",
    "expectedDiskSha256",
    "fileStatus",
    "path",
    "savedContentSha256",
    "schemaVersion",
    "snapshotRevision",
    "workspace",
  ]);
  assert.ok(!("renderedHtml" in snapshot));
  assert.ok(!("previewDom" in snapshot));
  assert.ok(!("undoHistory" in snapshot));
  assert.ok(!("dirty" in snapshot));
  assert.ok(!("recoveryStatus" in snapshot));
  assert.ok(!("persistedRevision" in snapshot));
});
