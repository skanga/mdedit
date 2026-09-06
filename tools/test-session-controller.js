const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { DocumentModel, emptyWorkspace } = require("../src/document-model.js");
const { SessionModel } = require("../src/session-model.js");
const { SessionController, LEGACY_DRAFT_KEY } = require("../src/session-controller.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function outcomeByImmediate(promise) {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: "unsettled" }))),
  ]);
}

function manifest(ids, activeDocumentId = ids[0], overrides = {}) {
  return {
    schemaVersion: 1,
    generation: overrides.generation ?? 8,
    activeDocumentId,
    nextUntitledNumber: overrides.nextUntitledNumber ?? 1,
    tabs: ids.map((id, index) => ({
      documentId: id,
      displayName: `${id}.md`,
      snapshotRevision: index + 1,
    })),
  };
}

function snapshot(id, revision, overrides = {}) {
  const content = overrides.content ?? `content:${id}`;
  return {
    schemaVersion: 1,
    documentId: overrides.documentId ?? id,
    snapshotRevision: overrides.snapshotRevision ?? revision,
    editRevision: overrides.editRevision ?? revision,
    displayName: overrides.displayName ?? `${id}.md`,
    path: overrides.path ?? `/notes/${id}.md`,
    canonicalPath: overrides.canonicalPath ?? `/notes/${id}.md`,
    content,
    savedContentSha256: overrides.savedContentSha256 ?? `sha:${content}`,
    expectedDiskSha256: overrides.expectedDiskSha256 ?? `sha:${content}`,
    fileStatus: overrides.fileStatus ?? "normal",
    workspace: overrides.workspace ?? emptyWorkspace(),
  };
}

function readResult(pathname, canonicalPath = pathname, content = `content:${pathname}`) {
  return {
    path: pathname,
    canonicalPath,
    content,
    sha256: `sha:${content}`,
    size: content.length,
    modifiedMs: 1,
  };
}

function makeDependencies(overrides = {}) {
  const calls = {
    sequence: [],
    snapshotLoads: [],
    reads: [],
    manifestWrites: [],
    recoveryErrors: [],
    renderedSessions: [],
    renderedDocuments: [],
    scheduler: [],
    openErrors: [],
    removedLegacy: [],
  };
  let fileOpenedHandler = null;
  let id = 0;
  const values = new Map();

  const io = {
    listenFileOpened(handler) {
      calls.sequence.push("listen-file-opened");
      fileOpenedHandler = handler;
      return () => { fileOpenedHandler = null; };
    },
    async loadRecoveryManifest() {
      calls.sequence.push("load-manifest");
      return null;
    },
    async loadRecoveryDocument(documentId, revision) {
      calls.snapshotLoads.push([documentId, revision]);
      return JSON.stringify(snapshot(documentId, revision));
    },
    async readDocument(pathname) {
      calls.reads.push(pathname);
      return readResult(pathname);
    },
    async writeRecoveryManifest(generation, json) {
      calls.manifestWrites.push([generation, json]);
    },
    async recoveryDirectory() {
      return "/recovery/session-v1";
    },
    async deleteRecoveryDocument() {
      throw new Error("recovery files must not be deleted by restore");
    },
    ...(overrides.io || {}),
  };

  const scheduler = {
    changed(documentId, revision) {
      calls.scheduler.push(["changed", documentId, revision]);
      return true;
    },
    async flush(documentId, revision) {
      calls.scheduler.push(["flush", documentId, revision]);
    },
    ...(overrides.scheduler || {}),
  };

  const view = {
    renderSession(session) {
      calls.renderedSessions.push([...session.tabOrder]);
    },
    renderDocument(document) {
      calls.renderedDocuments.push(document && document.id);
    },
    async showRecoveryError(details) {
      calls.recoveryErrors.push(details);
    },
    ...(overrides.view || {}),
  };

  const dialogs = {
    showOpenError(pathname, error) {
      calls.openErrors.push([pathname, error]);
    },
    ...(overrides.dialogs || {}),
  };

  const legacyStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      calls.removedLegacy.push(key);
      values.delete(key);
    },
    ...(overrides.legacyStorage || {}),
  };

  const dependencies = {
    io,
    scheduler,
    view,
    dialogs,
    legacyStorage,
    hashText: overrides.hashText || (async (text) => `sha:${text}`),
    idFactory: overrides.idFactory || (() => `generated-${++id}`),
    inactiveLoadConcurrency: overrides.inactiveLoadConcurrency,
    renderer: overrides.renderer,
    exporter: overrides.exporter,
  };

  return {
    calls,
    dependencies,
    legacyStorage,
    emitFileOpened(payload) {
      assert.equal(typeof fileOpenedHandler, "function", "file-opened listener is registered");
      return fileOpenedHandler({ payload });
    },
  };
}

test("browser wrapper merges SessionController into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "session-controller.js"), "utf8");
  const sandbox = {
    window: { MDEdit: { DocumentModel, SessionModel } },
    Promise,
    AggregateError,
  };

  vm.runInNewContext(code, sandbox, { filename: "session-controller.js" });

  assert.equal(typeof sandbox.window.MDEdit.SessionController, "function");
  assert.equal(sandbox.window.MDEdit.LEGACY_DRAFT_KEY, "mdedit-draft-v1");
});

test("restore loads the active snapshot first without changing tab order or manifest state", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => {
    fixture.calls.sequence.push("load-manifest");
    return JSON.stringify(manifest(["a", "b"], "b", { generation: 13, nextUntitledNumber: 4 }));
  };
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.deepEqual(fixture.calls.snapshotLoads, [["b", 2], ["a", 1]]);
  assert.deepEqual(controller.session.tabOrder, ["a", "b"]);
  assert.equal(controller.session.activeDocumentId, "b");
  assert.equal(controller.session.generation, 13);
  assert.equal(controller.session.nextUntitledNumber, 4);
  assert.ok(controller.session.documents.get("a") instanceof DocumentModel);
  assert.ok(controller.session.documents.get("b") instanceof DocumentModel);
  assert.equal(fixture.calls.renderedDocuments[0], "b");
});

test("openReadResult detects a duplicate canonical owner before allocating a second model", async () => {
  let ids = 0;
  const fixture = makeDependencies({ idFactory: () => `id-${++ids}` });
  const controller = new SessionController(fixture.dependencies);
  const result = readResult("C:\\notes\\first.md", "C:\\real\\same.md", "one");

  const first = await controller.openReadResult(result);
  const second = await controller.openReadResult({ ...result, path: "C:\\alias\\second.md" });

  assert.equal(first, second);
  assert.equal(ids, 1);
  assert.equal(controller.session.documents.size, 1);
  assert.deepEqual(controller.session.tabOrder, [first.id]);
  assert.equal(controller.activeDocument(), first);
});

test("openPaths continues after an individual read failure and activates the final success", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.readDocument = async (pathname) => {
    fixture.calls.reads.push(pathname);
    if (pathname === "bad.md") throw new Error("unreadable");
    return readResult(`/chosen/${pathname}`, `/canonical/${pathname}`, pathname);
  };
  const controller = new SessionController(fixture.dependencies);

  const opening = controller.openPaths(["first.md", "bad.md", "last.md"]);
  assert.equal(controller.session, null);
  assert.deepEqual(fixture.calls.reads, []);
  await controller.restore();
  const result = await opening;

  assert.equal(result.opened.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].path, "bad.md");
  assert.deepEqual(fixture.calls.reads, ["first.md", "bad.md", "last.md"]);
  assert.equal(controller.activeDocument().displayName, "last.md");
  assert.equal(controller.activeDocument().content, "last.md");
  assert.equal(controller.activeDocument().dirty, false);
  assert.equal(controller.activeDocument().savedContentSha256, "sha:last.md");
  assert.equal(controller.activeDocument().expectedDiskSha256, "sha:last.md");
  assert.equal(fixture.calls.openErrors.length, 1);
});

test("no manifest imports the legacy pathless draft as dirty and removes it after durability", async () => {
  const fixture = makeDependencies();
  fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ name: "old.md", text: "legacy" }));
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  const document = controller.activeDocument();
  assert.equal(document.displayName, "old.md");
  assert.equal(document.content, "legacy");
  assert.equal(document.path, null);
  assert.equal(document.canonicalPath, null);
  assert.equal(document.dirty, true);
  assert.equal(document.savedContentSha256, "sha:");
  assert.equal(document.editRevision, 1);
  assert.deepEqual(fixture.calls.scheduler, [
    ["changed", document.id, 1],
    ["flush", document.id, 1],
  ]);
  assert.equal(fixture.calls.manifestWrites.length, 1);
  assert.deepEqual(fixture.calls.removedLegacy, [LEGACY_DRAFT_KEY]);
  assert.equal(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), null);
});

test("an invalid manifest reports recovery context, starts clean, and never deletes recovery data", async () => {
  let deleteCalls = 0;
  const fixture = makeDependencies({
    io: {
      async loadRecoveryManifest() { return "{not json"; },
      async deleteRecoveryDocument() { deleteCalls += 1; },
    },
  });
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.equal(controller.session.documents.size, 1);
  assert.equal(controller.activeDocument().displayName, "Untitled 1");
  assert.equal(controller.activeDocument().dirty, false);
  assert.equal(deleteCalls, 0);
  assert.equal(fixture.calls.recoveryErrors.length, 1);
  assert.equal(fixture.calls.recoveryErrors[0].phase, "manifest");
  assert.equal(fixture.calls.recoveryErrors[0].recoveryDirectory, "/recovery/session-v1");
  assert.match(fixture.calls.recoveryErrors[0].message, /json|unexpected|property/i);
});

test("a snapshot failure remains visible, reports its recovery path, and does not block other tabs", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b", "c"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    fixture.calls.snapshotLoads.push([id, revision]);
    if (id === "b") throw new Error("snapshot denied");
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.ok(controller.session.documents.get("a") instanceof DocumentModel);
  assert.equal(controller.session.documents.get("b").loadStatus, "failed");
  assert.ok(controller.session.documents.get("c") instanceof DocumentModel);
  assert.deepEqual(controller.session.tabOrder, ["a", "b", "c"]);
  assert.equal(fixture.calls.recoveryErrors.length, 1);
  assert.equal(fixture.calls.recoveryErrors[0].documentId, "b");
  assert.equal(fixture.calls.recoveryErrors[0].snapshotRevision, 2);
  assert.equal(fixture.calls.recoveryErrors[0].recoveryDirectory, "/recovery/session-v1");
  assert.match(fixture.calls.recoveryErrors[0].message, /snapshot denied/);
});

test("restored snapshots recompute dirty state from the saved-content hash", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => JSON.stringify(snapshot(id, revision, {
    content: id === "a" ? "edited" : "saved",
    savedContentSha256: id === "a" ? "sha:before-edit" : "sha:saved",
  }));
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.equal(controller.session.documents.get("a").dirty, true);
  assert.equal(controller.session.documents.get("b").dirty, false);
});

test("inactive recovery uses at most four loads and promotes a selected loading tab", async () => {
  const gates = new Map();
  let activeLoads = 0;
  let maximumLoads = 0;
  const started = [];
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b", "c", "d", "e", "f", "g"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    started.push(id);
    if (id === "a") return JSON.stringify(snapshot(id, revision));
    const gate = deferred();
    gates.set(id, gate);
    activeLoads += 1;
    maximumLoads = Math.max(maximumLoads, activeLoads);
    await gate.promise;
    activeLoads -= 1;
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.equal(maximumLoads, 4);

  controller.activateDocument("g");
  gates.get("b").resolve();
  await settle();
  assert.equal(started[5], "g");

  for (const [id, gate] of gates) {
    if (id !== "b") gate.resolve();
  }
  await settle();
  if (gates.has("f")) gates.get("f").resolve();
  await restoring;

  assert.equal(maximumLoads, 4);
  assert.equal(controller.session.activeDocumentId, "g");
  assert.ok(controller.activeDocument() instanceof DocumentModel);
});

test("loading-tab selections before inactive hydration use most-recent-first priority", async () => {
  const activeGate = deferred();
  const inactiveGates = new Map();
  const started = [];
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(
    manifest(["a", "b", "c", "d", "e", "f", "g"], "a"),
  );
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    started.push(id);
    if (id === "a") {
      await activeGate.promise;
    } else {
      const gate = deferred();
      inactiveGates.set(id, gate);
      await gate.promise;
    }
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  assert.deepEqual(started, ["a"]);

  for (const id of ["b", "c", "d", "e", "f", "g", "c"]) {
    controller.activateDocument(id);
  }
  assert.equal(controller.session.activeDocumentId, "c");

  activeGate.resolve();
  await settle();
  assert.deepEqual(started.slice(0, 5), ["a", "c", "g", "f", "e"]);

  for (const id of ["c", "g", "f", "e"]) inactiveGates.get(id).resolve();
  await settle();
  for (const gate of inactiveGates.values()) gate.resolve();
  await restoring;

  assert.deepEqual(controller.session.tabOrder, ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(controller.session.activeDocumentId, "c");
  assert.ok(controller.activeDocument() instanceof DocumentModel);
});

test("file-open events before and during restore queue behind restoration in arrival order", async () => {
  const manifestGate = deferred();
  const fixture = makeDependencies({
    io: {
      async loadRecoveryManifest() {
        fixture.calls.sequence.push("load-manifest");
        return manifestGate.promise;
      },
      async readDocument(pathname) {
        fixture.calls.reads.push(pathname);
        return readResult(pathname, `/canonical/${pathname}`, pathname);
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);

  fixture.emitFileOpened("before.md");
  const restoring = controller.restore();
  fixture.emitFileOpened("during.md");
  await settle();
  assert.deepEqual(fixture.calls.sequence.slice(0, 2), ["listen-file-opened", "load-manifest"]);
  assert.deepEqual(fixture.calls.reads, []);

  manifestGate.resolve(null);
  await restoring;

  assert.deepEqual(fixture.calls.reads, ["before.md", "during.md"]);
  assert.equal(controller.activeDocument().displayName, "during.md");
});

test("restore waits for asynchronous file-open listener registration before loading recovery", async () => {
  const listenerGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.listenFileOpened = async () => {
    fixture.calls.sequence.push("listen-start");
    await listenerGate.promise;
    fixture.calls.sequence.push("listen-ready");
    return () => {};
  };
  fixture.dependencies.io.loadRecoveryManifest = async () => {
    fixture.calls.sequence.push("load-manifest");
    return null;
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  assert.deepEqual(fixture.calls.sequence, ["listen-start"]);

  listenerGate.resolve();
  await restoring;
  assert.deepEqual(fixture.calls.sequence, ["listen-start", "listen-ready", "load-manifest"]);
});

test("persistManifest serializes concurrent writes so an older generation cannot finish last", async () => {
  const firstWrite = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.writeRecoveryManifest = async (generation, json) => {
    fixture.calls.manifestWrites.push([generation, json]);
    if (fixture.calls.manifestWrites.length === 1) await firstWrite.promise;
  };
  const controller = new SessionController(fixture.dependencies);
  await controller.createUntitled();
  const older = controller.persistManifest();
  await controller.createUntitled();
  const newer = controller.persistManifest();

  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 1);
  firstWrite.resolve();
  await Promise.all([older, newer]);

  assert.deepEqual(fixture.calls.manifestWrites.map(([generation]) => generation), [1, 2]);
  assert.deepEqual(fixture.calls.manifestWrites.map(([, json]) => JSON.parse(json).generation), [1, 2]);
});

test("legacy storage is retained until both snapshot flush and manifest persistence succeed", async () => {
  const flushGate = deferred();
  const manifestGate = deferred();
  const fixture = makeDependencies({
    scheduler: {
      changed() { return true; },
      async flush() { await flushGate.promise; },
    },
    io: {
      async writeRecoveryManifest(generation, json) {
        fixture.calls.manifestWrites.push([generation, json]);
        await manifestGate.promise;
      },
    },
  });
  fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ name: "old.md", text: "legacy" }));
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  assert.notEqual(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), null);
  assert.equal(fixture.calls.manifestWrites.length, 0);

  flushGate.resolve();
  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 1);
  assert.notEqual(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), null);

  manifestGate.resolve();
  await restoring;
  assert.equal(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), null);
});

test("failed legacy durability keeps the old draft available for a future migration", async () => {
  const fixture = makeDependencies({
    scheduler: {
      changed() { return true; },
      async flush() { throw new Error("disk full"); },
    },
  });
  const raw = JSON.stringify({ name: "old.md", text: "legacy" });
  fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, raw);
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.equal(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), raw);
  assert.equal(controller.activeDocument().displayName, "Untitled 1");
  assert.equal(controller.activeDocument().content, "");
  assert.equal(controller.session.documents.size, 1);
  assert.equal(fixture.calls.recoveryErrors[0].phase, "legacy-migration");
});

test("canonical aliases opened through paths create one tab and count one opened document", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.readDocument = async (pathname) => {
    fixture.calls.reads.push(pathname);
    return readResult(pathname, "/real/shared.md", pathname);
  };
  const controller = new SessionController(fixture.dependencies);

  const opening = controller.openPaths(["/alias/first.md", "/alias/second.md"]);
  await controller.restore();
  const result = await opening;

  assert.equal(controller.session.documents.size, 1);
  assert.equal(result.opened.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(controller.activeDocument().canonicalPath, "/real/shared.md");
  assert.deepEqual(fixture.calls.reads, ["/alias/first.md", "/alias/second.md"]);
});

test("a manual open during snapshot hydration waits until recovery is fully loaded", async () => {
  const activeGate = deferred();
  const sequence = [];
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    sequence.push(`snapshot:${id}`);
    if (id === "a") await activeGate.promise;
    return JSON.stringify(snapshot(id, revision));
  };
  fixture.dependencies.io.readDocument = async (pathname) => {
    sequence.push(`read:${pathname}`);
    return readResult(pathname, `/canonical/${pathname}`, pathname);
  };
  const controller = new SessionController(fixture.dependencies);

  const firstRestore = controller.restore();
  assert.equal(controller.restore(), firstRestore);
  await settle();
  const opening = controller.openPaths(["late.md"]);
  await settle();

  assert.deepEqual(sequence, ["snapshot:a"]);
  assert.deepEqual(controller.session.tabOrder, ["a", "b"]);

  activeGate.resolve();
  await firstRestore;
  const result = await opening;

  assert.deepEqual(sequence, ["snapshot:a", "snapshot:b", "read:late.md"]);
  assert.equal(result.opened.length, 1);
  assert.deepEqual(controller.session.tabOrder.slice(0, 2), ["a", "b"]);
  assert.equal(controller.activeDocument().displayName, "late.md");
});

test("queued startup opens replace the unnecessary blank and preserve arrival activation", async () => {
  const manifestGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => manifestGate.promise;
  const controller = new SessionController(fixture.dependencies);

  const first = controller.openPaths(["first.md"]);
  const restoring = controller.restore();
  const second = controller.openPaths(["second.md"]);
  await settle();
  assert.equal(controller.session, null);
  assert.deepEqual(fixture.calls.reads, []);

  manifestGate.resolve(null);
  await restoring;
  await Promise.all([first, second]);

  assert.equal(controller.session.documents.size, 2);
  assert.deepEqual(
    controller.session.tabOrder.map((id) => controller.session.documents.get(id).displayName),
    ["first.md", "second.md"],
  );
  assert.equal(controller.activeDocument().displayName, "second.md");
});

test("openPaths from idle starts restore and settles without an explicit restore call", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  const outcome = await outcomeByImmediate(controller.openPaths(["standalone.md"]));

  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value.opened.length, 1);
  assert.equal(controller.session.documents.size, 1);
  assert.equal(controller.activeDocument().displayName, "standalone.md");
  assert.deepEqual(fixture.calls.sequence.slice(0, 2), ["listen-file-opened", "load-manifest"]);
});

test("an open chained from the final queued caller runs after the atomic restored transition", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  const first = controller.openPaths(["first.md"]);
  const chained = first.then(() => controller.openPaths(["chained.md"]));
  const outcome = await outcomeByImmediate(chained);

  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(fixture.calls.reads, ["first.md", "chained.md"]);
  assert.equal(controller.activeDocument().displayName, "chained.md");
});

test("all failed queued startup opens still leave one clean untitled document", async () => {
  const fixture = makeDependencies();
  fixture.dependencies.io.readDocument = async () => { throw new Error("no access"); };
  const controller = new SessionController(fixture.dependencies);

  const opening = controller.openPaths(["bad.md"]);
  await controller.restore();
  const result = await opening;

  assert.equal(result.failed.length, 1);
  assert.equal(controller.session.documents.size, 1);
  assert.equal(controller.activeDocument().displayName, "Untitled 1");
  assert.equal(controller.activeDocument().dirty, false);
});

test("legacy baseline is established before queued opens and the final open is active", async () => {
  const fixture = makeDependencies();
  fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ name: "old.md", text: "legacy" }));
  const controller = new SessionController(fixture.dependencies);

  const opening = controller.openPaths(["new.md"]);
  await controller.restore();
  await opening;

  assert.deepEqual(
    controller.session.tabOrder.map((id) => controller.session.documents.get(id).displayName),
    ["old.md", "new.md"],
  );
  assert.equal(controller.activeDocument().displayName, "new.md");
});

test("openReadResult during manifest loading waits and is not overwritten", async () => {
  const manifestGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => manifestGate.promise;
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  const opening = controller.openReadResult(readResult("manual.md", "/canonical/manual.md", "manual"));
  await settle();
  assert.equal(controller.session, null);

  manifestGate.resolve(null);
  await restoring;
  const document = await opening;

  assert.equal(controller.session.documents.size, 1);
  assert.equal(controller.activeDocument(), document);
  assert.equal(document.displayName, "manual.md");
});

test("createUntitled during active hydration runs after recovered inactive IDs are fixed", async () => {
  const activeGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    fixture.calls.snapshotLoads.push([id, revision]);
    if (id === "a") await activeGate.promise;
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  const creating = controller.createUntitled();
  assert.deepEqual(controller.session.tabOrder, ["a", "b"]);

  activeGate.resolve();
  await restoring;
  const created = await creating;

  assert.deepEqual(fixture.calls.snapshotLoads.map(([id]) => id), ["a", "b"]);
  assert.deepEqual(controller.session.tabOrder.slice(0, 2), ["a", "b"]);
  assert.equal(controller.activeDocument(), created);
});

test("recovery reporting rejection cannot block fresh restore or another snapshot", async () => {
  const fixture = makeDependencies({
    inactiveLoadConcurrency: 1,
    view: {
      async showRecoveryError() { throw new Error("view unavailable"); },
    },
    io: {
      async recoveryDirectory() { throw new Error("directory unavailable"); },
    },
  });
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b", "c"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    fixture.calls.snapshotLoads.push([id, revision]);
    if (id === "b") throw new Error("bad snapshot");
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.deepEqual(fixture.calls.snapshotLoads.map(([id]) => id), ["a", "b", "c"]);
  assert.ok(controller.session.documents.get("c") instanceof DocumentModel);
  assert.equal(controller.session.documents.get("b").loadStatus, "failed");
});

test("reentrant recovery reporting cannot deadlock restore", async () => {
  let controller;
  const fixture = makeDependencies({
    io: {
      async loadRecoveryManifest() { return "{bad json"; },
    },
    view: {
      showRecoveryError() { return controller.persistManifest(); },
    },
  });
  controller = new SessionController(fixture.dependencies);

  const outcome = await outcomeByImmediate(controller.restore());

  assert.equal(outcome.status, "fulfilled");
  assert.equal(controller.activeDocument().displayName, "Untitled 1");
});

test("listener rejection is diagnosed, remains retryable, and does not lose queued opens", async () => {
  let attempts = 0;
  let handler = null;
  const fixture = makeDependencies();
  fixture.dependencies.io.listenFileOpened = (nextHandler) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("listener denied"));
    handler = nextHandler;
    return Promise.resolve(() => { handler = null; });
  };
  const controller = new SessionController(fixture.dependencies);
  const opening = controller.openPaths(["queued.md"]);

  await controller.restore();
  await opening;

  assert.equal(attempts, 1);
  assert.equal(fixture.calls.recoveryErrors[0].phase, "file-open-listener");
  assert.equal(controller.activeDocument().displayName, "queued.md");

  await controller.start();
  assert.equal(attempts, 2);
  assert.equal(typeof handler, "function");
});

test("legacy hash and id preparation failures report and fall back without partial documents", async (t) => {
  let idCalls = 0;
  for (const failure of [
    { name: "hash", overrides: { hashText: async () => { throw new Error("hash failed"); } } },
    {
      name: "id",
      overrides: {
        idFactory: () => {
          idCalls += 1;
          if (idCalls === 1) throw new Error("id failed");
          return `fallback-${idCalls}`;
        },
      },
    },
  ]) {
    await t.test(failure.name, async () => {
      const fixture = makeDependencies(failure.overrides);
      const raw = JSON.stringify({ name: "old.md", text: "legacy" });
      fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, raw);
      const controller = new SessionController(fixture.dependencies);

      await controller.restore();

      assert.equal(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), raw);
      assert.equal(controller.session.documents.size, 1);
      assert.equal(controller.activeDocument().displayName, "Untitled 1");
      assert.equal(fixture.calls.recoveryErrors[0].phase, "legacy-migration");
    });
  }
});

test("an asynchronously rejected open-error dialog is observed without blocking results", async () => {
  const fixture = makeDependencies({
    dialogs: {
      async showOpenError() { throw new Error("dialog renderer failed"); },
    },
  });
  fixture.dependencies.io.readDocument = async () => { throw new Error("read failed"); };
  const controller = new SessionController(fixture.dependencies);

  const opening = controller.openPaths(["bad.md"]);
  await controller.restore();
  const result = await opening;
  await settle();

  assert.equal(result.failed.length, 1);
  assert.equal(controller.activeDocument().displayName, "Untitled 1");
});

test("a pending open-error reporter cannot block later selected files", async () => {
  const fixture = makeDependencies({
    dialogs: {
      showOpenError() { return new Promise(() => {}); },
    },
  });
  fixture.dependencies.io.readDocument = async (pathname) => {
    fixture.calls.reads.push(pathname);
    if (pathname === "bad.md") throw new Error("read failed");
    return readResult(pathname);
  };
  const controller = new SessionController(fixture.dependencies);

  const outcome = await outcomeByImmediate(controller.openPaths(["bad.md", "good.md"]));

  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value.failed.length, 1);
  assert.equal(outcome.value.opened.length, 1);
  assert.deepEqual(fixture.calls.reads, ["bad.md", "good.md"]);
  assert.equal(controller.activeDocument().displayName, "good.md");
});

test("persistManifest waits for restore hydration before serializing", async () => {
  const activeGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a", "b"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    if (id === "a") await activeGate.promise;
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  const persisting = controller.persistManifest();
  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 0);

  activeGate.resolve();
  await restoring;
  await persisting;
  assert.equal(fixture.calls.manifestWrites.length, 1);
  assert.deepEqual(JSON.parse(fixture.calls.manifestWrites[0][1]).tabs.map((tab) => tab.documentId), ["a", "b"]);
});

test("dispose awaits unsubscribe, is idempotent, and stale events cannot open documents", async () => {
  const unsubscribeGate = deferred();
  let handler;
  let unsubscribeCalls = 0;
  const fixture = makeDependencies();
  fixture.dependencies.io.listenFileOpened = (nextHandler) => {
    handler = nextHandler;
    return async () => {
      unsubscribeCalls += 1;
      await unsubscribeGate.promise;
    };
  };
  const controller = new SessionController(fixture.dependencies);
  await controller.restore();
  const initialSize = controller.session.documents.size;

  const disposing = controller.dispose();
  assert.equal(controller.destroy(), disposing);
  await settle();
  assert.equal(unsubscribeCalls, 1);
  handler({ payload: "ignored.md" });
  unsubscribeGate.resolve();
  await disposing;
  await settle();

  assert.equal(controller.session.documents.size, initialSize);
  assert.deepEqual(fixture.calls.reads, []);
  assert.equal(await controller.dispose(), undefined);
  assert.equal(unsubscribeCalls, 1);
});

test("dispose quiesces deferred hydration and rejects or no-ops later public work", async () => {
  const hydrationGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a"], "a"));
  fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => {
    await hydrationGate.promise;
    return JSON.stringify(snapshot(id, revision));
  };
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  await settle();
  const rendersBeforeDispose = fixture.calls.renderedDocuments.length;
  const stub = controller.session.documents.get("a");

  const disposed = await outcomeByImmediate(controller.dispose());
  assert.equal(disposed.status, "fulfilled");
  hydrationGate.resolve();
  await restoring;
  await settle();

  assert.equal(controller.session.documents.get("a"), stub);
  assert.equal(fixture.calls.renderedDocuments.length, rendersBeforeDispose);
  await assert.rejects(controller.createUntitled(), /disposed/i);
  await assert.rejects(controller.openReadResult(readResult("ignored.md")), /disposed/i);
  await assert.rejects(controller.persistManifest(), /disposed/i);
  const ignored = await controller.openPaths(["ignored.md"]);
  assert.equal(ignored.opened.length, 0);
  assert.deepEqual(fixture.calls.reads, []);
  assert.equal(fixture.calls.manifestWrites.length, 0);
});

test("legacy key removal failure is cleanup-only after durable migration", async () => {
  const fixture = makeDependencies({
    legacyStorage: {
      removeItem() { throw new Error("storage cleanup denied"); },
    },
  });
  const raw = JSON.stringify({ name: "old.md", text: "legacy" });
  fixture.legacyStorage.setItem(LEGACY_DRAFT_KEY, raw);
  const controller = new SessionController(fixture.dependencies);

  await controller.restore();

  assert.equal(fixture.calls.manifestWrites.length, 1);
  assert.equal(fixture.legacyStorage.getItem(LEGACY_DRAFT_KEY), raw);
  assert.equal(controller.session.documents.size, 1);
  assert.equal(controller.activeDocument().displayName, "old.md");
  assert.equal(controller.activeDocument().content, "legacy");
  assert.equal(fixture.calls.recoveryErrors.at(-1).phase, "legacy-cleanup");
  assert.equal(fixture.calls.scheduler.some(([kind]) => kind === "forget"), false);
});

test("snapshot identity and revision mismatches leave their stubs in place and report failures", async (t) => {
  for (const mismatch of [
    { name: "identity", override: { documentId: "someone-else" }, pattern: /identity/i },
    { name: "revision", override: { snapshotRevision: 99 }, pattern: /revision/i },
  ]) {
    await t.test(mismatch.name, async () => {
      const fixture = makeDependencies();
      fixture.dependencies.io.loadRecoveryManifest = async () => JSON.stringify(manifest(["a"], "a"));
      fixture.dependencies.io.loadRecoveryDocument = async (id, revision) => JSON.stringify(snapshot(id, revision, mismatch.override));
      const controller = new SessionController(fixture.dependencies);

      await controller.restore();

      const stub = controller.session.documents.get("a");
      assert.equal(stub.id, "a");
      assert.equal(stub.loadStatus, "failed");
      assert.equal(stub instanceof DocumentModel, false);
      assert.match(fixture.calls.recoveryErrors[0].message, mismatch.pattern);
      assert.deepEqual(controller.session.tabOrder, ["a"]);
      assert.equal(controller.session.activeDocumentId, "a");
    });
  }
});

test("createUntitled delegates naming to SessionModel and updates session and active views", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  const first = await controller.createUntitled();
  const second = await controller.createUntitled();

  assert.equal(first.displayName, "Untitled 1");
  assert.equal(second.displayName, "Untitled 2");
  assert.deepEqual(controller.session.tabOrder, [first.id, second.id]);
  assert.deepEqual(fixture.calls.renderedDocuments, [first.id, second.id]);
  assert.deepEqual(fixture.calls.renderedSessions, [[first.id], [first.id, second.id]]);
});
