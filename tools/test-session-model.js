const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { DocumentModel, SNAPSHOT_SCHEMA_VERSION } = require("../src/document-model.js");
const {
  SessionModel,
  SESSION_SCHEMA_VERSION,
} = require("../src/session-model.js");

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function makeDocument(overrides = {}) {
  return new DocumentModel({
    id: overrides.id ?? "doc-1",
    displayName: overrides.displayName ?? "notes.md",
    path: overrides.path,
    canonicalPath: overrides.canonicalPath ?? null,
    content: overrides.content ?? "",
    savedContentSha256: overrides.savedContentSha256 ?? EMPTY_SHA256,
    snapshotRevision: overrides.snapshotRevision ?? 0,
  });
}

function makeLoadingStub(overrides = {}) {
  return {
    id: overrides.id ?? "stub-1",
    displayName: overrides.displayName ?? "Loading...",
    canonicalPath: overrides.canonicalPath ?? null,
    snapshotRevision: overrides.snapshotRevision ?? 0,
  };
}

function createSessionWithDocuments(docs = []) {
  const session = new SessionModel({ idFactory: () => "generated-id" });
  for (const doc of docs) session.add(doc);
  return session;
}

test("browser wrapper merges the session API into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "session-model.js"), "utf8");
  const sandbox = {
    window: {
      MDEdit: {
        DocumentModel,
        SNAPSHOT_SCHEMA_VERSION,
      },
    },
  };

  vm.runInNewContext(code, sandbox, { filename: "session-model.js" });

  assert.equal(typeof sandbox.window.MDEdit.SessionModel, "function");
  assert.equal(sandbox.window.MDEdit.SESSION_SCHEMA_VERSION, 1);
  assert.equal(sandbox.window.MDEdit.DocumentModel, DocumentModel);
});

test("createUntitled creates unique untitled tabs in creation order", () => {
  const session = new SessionModel({ idFactory: (() => {
    const ids = ["doc-a", "doc-b"];
    let index = 0;
    return () => ids[index++];
  })() });

  const first = session.createUntitled();
  const second = session.createUntitled();

  assert.ok(first instanceof DocumentModel);
  assert.equal(first.displayName, "Untitled 1");
  assert.equal(first.content, "");
  assert.equal(first.dirty, false);
  assert.equal(first.savedContentSha256, EMPTY_SHA256);
  assert.equal(second.displayName, "Untitled 2");
  assert.deepEqual(session.tabOrder, ["doc-a", "doc-b"]);
  assert.equal(session.activeDocumentId, "doc-b");
  assert.equal(session.nextUntitledNumber, 3);
});

test("createUntitled rejects an empty id from the idFactory", () => {
  const session = new SessionModel({ idFactory: () => "" });

  assert.throws(() => session.createUntitled(), /document id must be a non-empty string/i);
});

test("add returns the added document, appends it, activates it, and increments generation once", () => {
  const session = new SessionModel({ idFactory: () => "generated-id" });
  const doc = makeDocument({ id: "doc-1" });
  const beforeGeneration = session.generation;

  const added = session.add(doc);

  assert.equal(added, doc);
  assert.deepEqual(session.tabOrder, ["doc-1"]);
  assert.equal(session.activeDocumentId, "doc-1");
  assert.equal(session.generation, beforeGeneration + 1);
});

test("add rejects session-invalid fields on a DocumentModel instance", () => {
  const session = new SessionModel({ idFactory: () => "generated-id" });
  const doc = new DocumentModel({
    id: "",
    displayName: "",
    canonicalPath: "",
    content: "",
    savedContentSha256: EMPTY_SHA256,
  });

  assert.throws(() => session.add(doc), /document id must be a non-empty string/i);
});

test("add rejects duplicate document IDs and duplicate canonical paths", () => {
  const session = new SessionModel({ idFactory: () => "generated-id" });
  const first = makeDocument({ id: "doc-1", canonicalPath: "/documents/a.md" });

  session.add(first);

  assert.throws(
    () => session.add(makeDocument({ id: "doc-1", canonicalPath: "/documents/b.md" })),
    /duplicate document id/i,
  );
  assert.throws(
    () => session.add(makeDocument({ id: "doc-2", canonicalPath: "/documents/a.md" })),
    /duplicate canonical path/i,
  );
  assert.equal(session.findByCanonicalPath("/documents/a.md"), first);
  assert.equal(session.findByCanonicalPath("/documents/missing.md"), null);
});

test("add and fromManifest keep exact untitled labels unique and monotonic", () => {
  const session = new SessionModel({ idFactory: () => "generated-id" });
  const untitledOne = makeDocument({ id: "doc-1", displayName: "Untitled 1" });
  const untitledThree = makeDocument({ id: "doc-3", displayName: "Untitled 3" });

  session.add(untitledOne);
  assert.equal(session.nextUntitledNumber, 2);

  session.add(untitledThree);
  assert.equal(session.nextUntitledNumber, 4);

  assert.throws(
    () => session.add(makeDocument({ id: "doc-2", displayName: "Untitled 3" })),
    /duplicate untitled label/i,
  );
  assert.throws(
    () => session.add(makeDocument({ id: "doc-4", displayName: "Untitled 9007199254740992" })),
    /untitled label/i,
  );

  assert.throws(
    () => SessionModel.fromManifest({
      schemaVersion: SESSION_SCHEMA_VERSION,
      generation: 0,
      activeDocumentId: "doc-1",
      nextUntitledNumber: 3,
      tabs: [
        { documentId: "doc-1", displayName: "Untitled 1", snapshotRevision: 1 },
        { documentId: "doc-2", displayName: "Untitled 3", snapshotRevision: 2 },
      ],
    }),
    /untitled label/i,
  );
  assert.throws(
    () => SessionModel.fromManifest({
      schemaVersion: SESSION_SCHEMA_VERSION,
      generation: 0,
      activeDocumentId: "doc-1",
      nextUntitledNumber: 1,
      tabs: [
        { documentId: "doc-1", displayName: "Untitled 9007199254740992", snapshotRevision: 1 },
      ],
    }),
    /untitled label/i,
  );
  assert.throws(
    () => SessionModel.fromManifest({
      schemaVersion: SESSION_SCHEMA_VERSION,
      generation: 0,
      activeDocumentId: "doc-1",
      nextUntitledNumber: 4,
      tabs: [
        { documentId: "doc-1", displayName: "Untitled 1", snapshotRevision: 1 },
        { documentId: "doc-2", displayName: "Untitled 1", snapshotRevision: 2 },
      ],
    }),
    /untitled label/i,
  );
});

test("activate changes the active tab only when the id changes", () => {
  const first = makeDocument({ id: "doc-1" });
  const second = makeDocument({ id: "doc-2" });
  const session = createSessionWithDocuments([first, second]);
  const initialGeneration = session.generation;

  assert.equal(session.activate("doc-1"), first);
  assert.equal(session.activeDocumentId, "doc-1");
  assert.equal(session.generation, initialGeneration + 1);

  assert.equal(session.activate("doc-1"), first);
  assert.equal(session.generation, initialGeneration + 1);
  assert.throws(() => session.activate("unknown"), /unknown document id/i);
});

test("remove selects the expected neighbor and clears the active id after the final tab", () => {
  const left = makeDocument({ id: "left" });
  const middle = makeDocument({ id: "middle" });
  const right = makeDocument({ id: "right" });

  const firstSession = createSessionWithDocuments([left, middle, right]);
  firstSession.activate("middle");
  const removedMiddle = firstSession.remove("middle");
  assert.deepEqual(removedMiddle, { removed: middle, nextActiveId: "right" });
  assert.equal(firstSession.activeDocumentId, "right");

  const secondSession = createSessionWithDocuments([left, middle, right]);
  secondSession.activate("right");
  const removedRight = secondSession.remove("right");
  assert.deepEqual(removedRight, { removed: right, nextActiveId: "middle" });
  assert.equal(secondSession.activeDocumentId, "middle");

  const thirdSession = createSessionWithDocuments([left, middle, right]);
  thirdSession.activate("middle");
  const removedInactive = thirdSession.remove("right");
  assert.deepEqual(removedInactive, { removed: right, nextActiveId: "middle" });
  assert.equal(thirdSession.activeDocumentId, "middle");

  const solo = makeDocument({ id: "solo" });
  const emptySession = createSessionWithDocuments([solo]);
  const removedSolo = emptySession.remove("solo");
  assert.deepEqual(removedSolo, { removed: solo, nextActiveId: null });
  assert.equal(emptySession.activeDocumentId, null);
  assert.equal(emptySession.tabOrder.length, 0);
});

test("move clamps within bounds, preserves the active id, and rejects invalid input", () => {
  const first = makeDocument({ id: "a" });
  const second = makeDocument({ id: "b" });
  const third = makeDocument({ id: "c" });
  const session = createSessionWithDocuments([first, second, third]);
  const initialGeneration = session.generation;

  const beforeNoopMove = session.generation;
  assert.equal(session.move("a", -1), first);
  assert.equal(session.tabOrder.join(","), "a,b,c");
  assert.equal(session.generation, beforeNoopMove);

  session.activate("b");
  const beforeReorderMove = session.generation;
  assert.equal(session.move("b", 1), second);
  assert.equal(session.tabOrder.join(","), "a,c,b");
  assert.equal(session.activeDocumentId, "b");
  assert.equal(session.generation, beforeReorderMove + 1);

  const beforeUpperClamp = session.generation;
  assert.equal(session.move("c", 99), third);
  assert.equal(session.tabOrder.join(","), "a,b,c");
  assert.equal(session.generation, beforeUpperClamp + 1);

  assert.throws(() => session.move("unknown", 1), /unknown document id/i);
  assert.throws(() => session.move("a", 1.5), /delta must be a safe integer/i);
  assert.throws(() => session.move("a", 9007199254740992), /delta must be a safe integer/i);
});

test("toManifest emits the session schema and ordered tab metadata", () => {
  const first = makeDocument({ id: "a", displayName: "A.md", snapshotRevision: 2 });
  const second = makeDocument({ id: "b", displayName: "B.md", snapshotRevision: 5 });
  const session = createSessionWithDocuments([first, second]);
  session.activate("b");

  assert.deepEqual(session.toManifest(), {
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation: session.generation,
    activeDocumentId: "b",
    nextUntitledNumber: 1,
    tabs: [
      { documentId: "a", displayName: "A.md", snapshotRevision: 2 },
      { documentId: "b", displayName: "B.md", snapshotRevision: 5 },
    ],
  });
});

test("fromManifest round-trips a valid manifest and hydrates loading stubs", () => {
  const manifest = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation: 4,
    activeDocumentId: "doc-2",
    nextUntitledNumber: 7,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1 },
      { documentId: "doc-2", displayName: "Second.md", snapshotRevision: 3 },
    ],
  };

  const session = SessionModel.fromManifest(manifest, {
    idFactory: () => "generated-id",
  });

  assert.equal(session.generation, 4);
  assert.equal(session.activeDocumentId, "doc-2");
  assert.equal(session.nextUntitledNumber, 7);
  assert.deepEqual(session.tabOrder, ["doc-1", "doc-2"]);
  assert.equal(session.documents.get("doc-1").displayName, "First.md");
  assert.equal(session.documents.get("doc-1").snapshotRevision, 1);
  assert.equal(session.documents.get("doc-1").canonicalPath, null);
});

test("fromManifest rejects invalid session manifests", () => {
  const base = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation: 0,
    activeDocumentId: "doc-1",
    nextUntitledNumber: 1,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1 },
    ],
  };

  assert.throws(() => SessionModel.fromManifest({ ...base, schemaVersion: 2 }), /unsupported session schema version/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, tabs: [] }), /tabs must not be empty/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, generation: 1.5 }), /generation/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, nextUntitledNumber: 1.5 }), /next untitled number/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, generation: 9007199254740992 }), /generation/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, nextUntitledNumber: 9007199254740992 }), /next untitled number/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, generation: Number.MAX_SAFE_INTEGER }), /generation/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, nextUntitledNumber: Number.MAX_SAFE_INTEGER }), /next untitled number/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1 },
      { documentId: "doc-1", displayName: "Duplicate.md", snapshotRevision: 2 },
    ],
  }), /duplicate document id/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1, canonicalPath: "/documents/a.md" },
      { documentId: "doc-2", displayName: "Second.md", snapshotRevision: 2, canonicalPath: "/documents/a.md" },
    ],
  }), /duplicate canonical path/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    nextUntitledNumber: 9007199254740991,
    tabs: [
      { documentId: "doc-1", displayName: "Untitled 9007199254740991", snapshotRevision: 1 },
    ],
  }), /next untitled number/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "Untitled 9007199254740992", snapshotRevision: 1 },
    ],
  }), /untitled label/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    nextUntitledNumber: 3,
    tabs: [
      { documentId: "doc-1", displayName: "Untitled 1", snapshotRevision: 1 },
      { documentId: "doc-2", displayName: "Untitled 3", snapshotRevision: 2 },
    ],
  }), /untitled label/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1, canonicalPath: 7 },
    ],
  }), /invalid canonical path/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, activeDocumentId: null }), /active document id/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, activeDocumentId: "missing" }), /unknown active document id/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, generation: -1 }), /generation/i);
  assert.throws(() => SessionModel.fromManifest({ ...base, nextUntitledNumber: 0 }), /next untitled number/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "", snapshotRevision: 1 },
    ],
  }), /invalid tab label/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: -1 },
    ],
  }), /snapshot revision/i);
  assert.throws(() => SessionModel.fromManifest({
    ...base,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 9007199254740992 },
    ],
  }), /snapshot revision/i);
});

test("fromManifest preserves supplied canonical paths", () => {
  const session = SessionModel.fromManifest({
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation: 2,
    activeDocumentId: "doc-1",
    nextUntitledNumber: 2,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1, canonicalPath: "/documents/first.md" },
      { documentId: "doc-2", displayName: "Second.md", snapshotRevision: 2, canonicalPath: "/documents/second.md" },
    ],
  }, { idFactory: () => "generated-id" });

  assert.equal(session.documents.get("doc-1").canonicalPath, "/documents/first.md");
  assert.equal(session.documents.get("doc-2").canonicalPath, "/documents/second.md");
});

test("fromManifest rejects fractional snapshot revisions", () => {
  assert.throws(() => SessionModel.fromManifest({
    schemaVersion: SESSION_SCHEMA_VERSION,
    generation: 0,
    activeDocumentId: "doc-1",
    nextUntitledNumber: 1,
    tabs: [
      { documentId: "doc-1", displayName: "First.md", snapshotRevision: 1.5 },
    ],
  }, { idFactory: () => "generated-id" }), /snapshot revision must be a safe integer/i);
});
