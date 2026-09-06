const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { DocumentModel, emptyWorkspace } = require("../src/document-model.js");
const { SessionModel } = require("../src/session-model.js");
const {
  SessionController,
  LEGACY_DRAFT_KEY,
  createBrowserRecoveryIo,
  createBrowserRecoveryEnvironment,
} = require("../src/session-controller.js");
const { RecoveryScheduler } = require("../src/recovery-scheduler.js");

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

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
      }
    },
  };
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
    preview: [],
    statuses: [],
    activation: [],
    frames: [],
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
    captureWorkspace(documentId) {
      calls.activation.push(["capture", documentId]);
      return emptyWorkspace();
    },
    ensureEditor(document) {
      calls.activation.push(["ensure", document.id]);
      return { value: document.content };
    },
    activateEditor(documentId) {
      calls.activation.push(["activate-editor", documentId]);
    },
    applyWorkspace(documentId, workspace) {
      calls.activation.push(["apply", documentId, workspace]);
    },
    focusActiveEditor() {
      calls.activation.push(["focus"]);
    },
    setPreview(html, capture) {
      calls.preview.push([html, capture]);
    },
    clearPreview(capture) {
      calls.preview.push([null, capture]);
    },
    setDocumentStatus(documentId, status) {
      calls.statuses.push([documentId, status]);
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
    renderer: overrides.renderer || (overrides.exporter ? {
      async renderForExport(capture) { return `<article>${capture.content}</article>`; },
    } : undefined),
    exporter: overrides.exporter,
    requestAnimationFrame: overrides.requestAnimationFrame || ((callback) => {
      calls.frames.push(callback);
      callback();
    }),
    previewCacheMaxEntries: overrides.previewCacheMaxEntries,
    previewCacheMaxBytes: overrides.previewCacheMaxBytes,
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

test("browser recovery IO stores versioned JSON documents and manifest durably", async () => {
  const storage = memoryStorage();
  const io = createBrowserRecoveryIo(storage);

  const documentJson = JSON.stringify(snapshot("doc/a", 3));
  await io.writeRecoveryDocument("doc/a", 3, documentJson);
  const manifestJson = JSON.stringify(manifest(["doc/a"], "doc/a", { generation: 9 }));
  await io.writeRecoveryManifest(9, manifestJson);

  assert.equal(await io.loadRecoveryDocument("doc/a", 3), documentJson);
  assert.equal(await io.loadRecoveryManifest(), manifestJson);
  assert.match(await io.recoveryDirectory(), /localStorage.*v1/i);
  assert.ok([...storage.values.keys()].every((key) => key.startsWith("mdedit-recovery-v1:")));

  await io.deleteRecoveryDocument("doc/a");
  assert.equal(await io.loadRecoveryDocument("doc/a", 3), null);
});

test("browser recovery IO propagates storage quota failures", async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const io = createBrowserRecoveryIo(storage);

  await assert.rejects(io.writeRecoveryDocument("a", 1, JSON.stringify(snapshot("a", 1))), /quota exceeded/);
  await assert.rejects(io.writeRecoveryManifest(1, JSON.stringify(manifest(["a"], "a", { generation: 1 }))), /quota exceeded/);
});

test("browser recovery environment survives a SecurityError localStorage getter", async () => {
  const root = {};
  Object.defineProperty(root, "localStorage", { get() { throw new Error("SecurityError"); } });
  const environment = createBrowserRecoveryEnvironment(root);
  assert.equal(environment.persistent, false);
  assert.match(environment.error.message, /SecurityError/);
  await environment.io.writeRecoveryDocument("a", 1, JSON.stringify(snapshot("a", 1)));
  assert.match(await environment.io.loadRecoveryDocument("a", 1), /"snapshotRevision":1/);
});

test("browser manifest pointer keeps the last valid generation after a failed publish", async () => {
  const storage = memoryStorage();
  const io = createBrowserRecoveryIo(storage);
  const firstManifest = JSON.stringify(manifest(["a"], "a", { generation: 1 }));
  const secondManifest = JSON.stringify(manifest(["a"], "a", { generation: 2 }));
  await io.writeRecoveryManifest(1, firstManifest);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith("manifest:current") && String(value).includes('"generation":2')) throw new Error("pointer quota");
    setItem.call(storage, key, value);
  };

  await assert.rejects(io.writeRecoveryManifest(2, secondManifest), /pointer quota/);
  assert.equal(await io.loadRecoveryManifest(), firstManifest);
});

test("browser recovery keeps only current and previous snapshots after 100 revisions", async () => {
  const storage = memoryStorage();
  const io = createBrowserRecoveryIo(storage);
  for (let revision = 0; revision < 100; revision += 1) {
    await io.writeRecoveryDocument("a", revision, JSON.stringify(snapshot("a", revision)));
  }
  const documentKeys = [...storage.values.keys()].filter((key) => key.includes("document:a:"));
  assert.ok(documentKeys.length <= 2, documentKeys.join(","));
  assert.match(await io.loadRecoveryDocument("a", 99), /"snapshotRevision":99/);
  assert.match(await io.loadRecoveryDocument("a", 98), /"snapshotRevision":98/);
  assert.equal(await io.loadRecoveryDocument("a", 97), null);
});

test("browser recovery falls back to previous when the current slot is corrupt", async () => {
  const storage = memoryStorage();
  const io = createBrowserRecoveryIo(storage);
  await io.writeRecoveryDocument("a", 1, JSON.stringify(snapshot("a", 1)));
  await io.writeRecoveryDocument("a", 2, JSON.stringify(snapshot("a", 2)));
  const current = [...storage.values.keys()].find((key) => key.endsWith("document:a:current"));
  storage.setItem(current, "broken json");
  assert.match(await io.loadRecoveryDocument("a", 1), /"snapshotRevision":1/);
});

test("wrong-document current slot cannot evict the valid previous snapshot on failed install", async () => {
  const storage = memoryStorage();
  const io = createBrowserRecoveryIo(storage);
  await io.writeRecoveryDocument("a", 1, JSON.stringify(snapshot("a", 1)));
  await io.writeRecoveryDocument("a", 2, JSON.stringify(snapshot("a", 2)));
  const current = [...storage.values.keys()].find((key) => key.endsWith("document:a:current"));
  storage.setItem(current, JSON.stringify(snapshot("wrong", 9)));
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === current && String(value).includes('"snapshotRevision":3')) throw new Error("install quota");
    setItem.call(storage, key, value);
  };

  await assert.rejects(io.writeRecoveryDocument("a", 3, JSON.stringify(snapshot("a", 3))), /install quota/);
  storage.setItem = setItem;
  assert.match(await io.loadRecoveryDocument("a", 1), /"snapshotRevision":1/);
});

test("browser legacy migration reloads the latest later edit from the versioned store", async () => {
  const storage = memoryStorage();
  storage.setItem(LEGACY_DRAFT_KEY, JSON.stringify({ name: "legacy.md", text: "original" }));

  function browserController() {
    const io = createBrowserRecoveryIo(storage);
    let controller;
    const scheduler = new RecoveryScheduler({
      async write(documentId, revision) {
        const document = controller.session.documents.get(documentId);
        assert.equal(document.snapshotRevision, revision);
        await io.writeRecoveryDocument(documentId, revision, JSON.stringify(document.toSnapshot()));
        document.persistedRevision = revision;
      },
    });
    const fixture = makeDependencies({
      io,
      legacyStorage: storage,
    });
    fixture.dependencies.scheduler = scheduler;
    controller = new SessionController(fixture.dependencies);
    return controller;
  }

  const first = browserController();
  await first.restore();
  const document = first.activeDocument();
  first.onEditorInput(document.id, "latest edit");
  await first.persistManifest();
  assert.equal(storage.getItem(LEGACY_DRAFT_KEY), null);
  const browserIo = createBrowserRecoveryIo(storage);
  const storedManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.equal(storedManifest.tabs[0].snapshotRevision, document.snapshotRevision);
  const storedDocument = await browserIo.loadRecoveryDocument(document.id, document.snapshotRevision);
  assert.ok(storedDocument, `missing revision ${document.snapshotRevision}; keys: ${[...storage.values.keys()].join(",")}`);
  assert.equal(JSON.parse(storedDocument).content, "latest edit");

  const reloaded = browserController();
  await reloaded.restore();
  assert.equal(reloaded.activeDocument().content, "latest edit");
  assert.equal(reloaded.activeDocument().snapshotRevision, document.snapshotRevision);
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
    ["changed", document.id, 0],
    ["flush", document.id, 0],
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
  const creating = controller.createUntitled();
  const newer = controller.persistManifest();

  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 1);
  firstWrite.resolve();
  await Promise.all([older, creating, newer]);

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

test("a completed queued open settles before a later queued read finishes", async () => {
  const manifestGate = deferred();
  const slowRead = deferred();
  const fixture = makeDependencies({
    io: {
      async loadRecoveryManifest() { return manifestGate.promise; },
      async readDocument(pathname) {
        fixture.calls.reads.push(pathname);
        if (pathname === "slow.md") return slowRead.promise;
        return readResult(pathname);
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);

  const first = controller.openPaths(["first.md"]);
  const second = controller.openPaths(["slow.md"]);
  manifestGate.resolve(null);

  const firstOutcome = await outcomeByImmediate(first);
  const secondOutcome = await outcomeByImmediate(second);
  assert.equal(firstOutcome.status, "fulfilled");
  assert.equal(firstOutcome.value.opened[0].displayName, "first.md");
  assert.equal(secondOutcome.status, "unsettled");

  await controller.dispose();
  assert.notEqual((await outcomeByImmediate(second)).status, "unsettled");
});

test("restore finalization failure settles queued callers and rejects reentrant pending work", async () => {
  let controller;
  let lateOpening;
  let failFinalization = true;
  const fixture = makeDependencies({
    idFactory() {
      if (failFinalization) {
        lateOpening = controller.openPaths(["late.md"]);
        throw new Error("cannot create blank");
      }
      return "recovered-id";
    },
  });
  controller = new SessionController(fixture.dependencies);

  const first = controller.openPaths([]);
  const second = controller.openPaths([]);
  const restoreOutcome = await outcomeByImmediate(controller.restore());

  assert.equal(restoreOutcome.status, "rejected");
  assert.match(restoreOutcome.reason.message, /cannot create blank/);
  assert.equal((await outcomeByImmediate(first)).status, "fulfilled");
  assert.equal((await outcomeByImmediate(second)).status, "fulfilled");
  const lateOutcome = await outcomeByImmediate(lateOpening);
  assert.equal(lateOutcome.status, "rejected");
  assert.match(lateOutcome.reason.message, /cannot create blank/);

  failFinalization = false;
  const retried = await outcomeByImmediate(controller.openPaths(["recovered.md"]));
  assert.equal(retried.status, "fulfilled");
  assert.equal(controller.activeDocument().displayName, "recovered.md");
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

test("persistManifest requested during an empty restore writes the finalized baseline", async () => {
  const manifestGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.loadRecoveryManifest = async () => manifestGate.promise;
  const controller = new SessionController(fixture.dependencies);

  const restoring = controller.restore();
  const persisting = controller.persistManifest();
  manifestGate.resolve(null);
  await Promise.all([restoring, persisting]);

  const written = JSON.parse(fixture.calls.manifestWrites.at(-1)[1]);
  assert.equal(written.tabs.length, 1);
  assert.equal(written.tabs[0].displayName, "Untitled 1");
  assert.equal(written.activeDocumentId, controller.activeDocument().id);
});

test("persistManifest queues behind an unawaited mutation and writes its resulting state", async () => {
  const readGate = deferred();
  const fixture = makeDependencies();
  fixture.dependencies.io.readDocument = async () => readGate.promise;
  const controller = new SessionController(fixture.dependencies);
  await controller.restore();
  await settle();
  fixture.calls.manifestWrites.length = 0;

  const opening = controller.openPaths(["opened.md"]);
  const creating = controller.createUntitled();
  const persisting = controller.persistManifest();
  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 0);

  readGate.resolve(readResult("opened.md"));
  const [openResult, created] = await Promise.all([opening, creating]);
  await persisting;

  const written = JSON.parse(fixture.calls.manifestWrites.at(-1)[1]);
  assert.equal(openResult.opened.length, 1);
  assert.ok(created instanceof DocumentModel);
  assert.deepEqual(written.tabs.map((tab) => tab.displayName), ["Untitled 1", "opened.md", "Untitled 2"]);
  assert.equal(written.activeDocumentId, created.id);
});

test("idle post-restore document creation APIs return models synchronously", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  await controller.restore();

  const created = controller.createUntitled();
  assert.equal(typeof created.then, "undefined");
  assert.ok(created instanceof DocumentModel);
  created.applyContent("edited immediately");

  const opened = controller.openReadResult(readResult("saved.md", "/saved.md", "saved"));
  assert.equal(typeof opened.then, "undefined");
  assert.ok(opened instanceof DocumentModel);
  assert.equal(opened.content, "saved");
  assert.equal(controller.activeDocument(), opened);
});

test("fresh createUntitled returns a usable model synchronously and owns the startup baseline", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  const created = controller.createUntitled();
  assert.ok(created instanceof DocumentModel);
  assert.equal(typeof created.then, "undefined");
  created.applyContent("local before restore");
  const session = controller.session;

  await controller.restore();

  assert.equal(controller.session, session);
  assert.equal(controller.activeDocument(), created);
  assert.equal(created.content, "local before restore");
  assert.equal(fixture.calls.sequence.includes("load-manifest"), false);
});

test("fresh openReadResult returns a model synchronously without later restore overwrite", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  const opened = controller.openReadResult(readResult("fresh.md", "/fresh.md", "fresh"));
  assert.ok(opened instanceof DocumentModel);
  assert.equal(typeof opened.id, "string");
  assert.equal(typeof opened.then, "undefined");

  await controller.restore();

  assert.equal(controller.activeDocument(), opened);
  assert.equal(controller.session.documents.size, 1);
  assert.equal(fixture.calls.sequence.includes("load-manifest"), false);
});

test("local synchronous documents still wait for listener readiness before restore completes", async () => {
  const listenerGate = deferred();
  const fixture = makeDependencies({
    io: {
      listenFileOpened() { return listenerGate.promise; },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  const created = controller.createUntitled();

  const restoring = controller.restore();
  assert.equal((await outcomeByImmediate(restoring)).status, "unsettled");
  assert.equal(fixture.calls.sequence.includes("load-manifest"), false);

  listenerGate.resolve(() => {});
  await restoring;

  assert.equal(controller.activeDocument(), created);
  assert.equal(fixture.calls.sequence.includes("load-manifest"), false);
});

test("local restore reports listener rejection, remains usable, and allows listener retry", async () => {
  const firstRegistration = deferred();
  let attempts = 0;
  let registered = false;
  const fixture = makeDependencies({
    io: {
      listenFileOpened() {
        attempts += 1;
        if (attempts === 1) return firstRegistration.promise;
        registered = true;
        return () => { registered = false; };
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  const created = controller.createUntitled();
  created.applyContent("keep me");

  const restoring = controller.restore();
  firstRegistration.reject(new Error("listener unavailable"));
  await restoring;
  await settle();

  assert.equal(controller.activeDocument(), created);
  assert.equal(created.content, "keep me");
  assert.equal(fixture.calls.sequence.includes("load-manifest"), false);
  assert.equal(fixture.calls.recoveryErrors.at(-1).phase, "file-open-listener");
  assert.match(fixture.calls.recoveryErrors.at(-1).message, /listener unavailable/);

  await controller.start();
  assert.equal(attempts, 2);
  assert.equal(registered, true);
});

test("failed local creation remains idle so manifest recovery still runs", async () => {
  let idCalls = 0;
  let manifestLoads = 0;
  const fixture = makeDependencies({
    idFactory() {
      idCalls += 1;
      if (idCalls === 1) throw new Error("id unavailable");
      return `id-${idCalls}`;
    },
    io: {
      async loadRecoveryManifest() {
        manifestLoads += 1;
        return JSON.stringify(manifest(["a"], "a"));
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);

  assert.throws(() => controller.createUntitled(), /id unavailable/);
  assert.equal(controller.session, null);

  await controller.restore();

  assert.equal(manifestLoads, 1);
  assert.deepEqual(controller.session.tabOrder, ["a"]);
  assert.equal(controller.activeDocument().id, "a");
});

test("invalid fresh read remains idle so manifest recovery still runs", async () => {
  let manifestLoads = 0;
  const fixture = makeDependencies({
    io: {
      async loadRecoveryManifest() {
        manifestLoads += 1;
        return JSON.stringify(manifest(["a"], "a"));
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);

  assert.throws(() => controller.openReadResult({
    path: "",
    canonicalPath: "/invalid.md",
    content: "invalid",
    sha256: "sha:invalid",
  }), /path/i);
  assert.equal(controller.session, null);

  await controller.restore();

  assert.equal(manifestLoads, 1);
  assert.deepEqual(controller.session.tabOrder, ["a"]);
  assert.equal(controller.activeDocument().id, "a");
});

test("createUntitled is synchronous immediately after awaiting openPaths", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);

  let created;
  await controller.openPaths(["opened.md"]).then(() => {
    created = controller.createUntitled();
  });

  assert.ok(created instanceof DocumentModel);
  assert.equal(typeof created.then, "undefined");
  created.applyContent("edited without another await");
  assert.equal(controller.activeDocument(), created);
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
  const restoreOutcome = await outcomeByImmediate(restoring);
  assert.equal(restoreOutcome.status, "rejected");
  assert.match(restoreOutcome.reason.message, /disposed/i);
  hydrationGate.resolve();
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

test("dispose settles an active hung open immediately and ignores its late read", async () => {
  const readGate = deferred();
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  await controller.restore();
  const initialIds = [...controller.session.tabOrder];
  fixture.dependencies.io.readDocument = async () => readGate.promise;

  const opening = controller.openPaths(["slow.md"]);
  await settle();
  await controller.dispose();

  const openOutcome = await outcomeByImmediate(opening);
  assert.notEqual(openOutcome.status, "unsettled");
  assert.throws(() => controller.activateDocument(initialIds[0]), /disposed/i);

  readGate.resolve(readResult("slow.md"));
  await settle();
  assert.deepEqual(controller.session.tabOrder, initialIds);
  assert.deepEqual(fixture.calls.renderedDocuments.slice(-1), [initialIds[0]]);
});

test("restore and public entry points guard disposal before cached state or input work", async () => {
  let legacyReads = 0;
  const fixture = makeDependencies({
    legacyStorage: {
      getItem() {
        legacyReads += 1;
        return null;
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  await controller.restore();
  await controller.dispose();
  const session = controller.session;
  const sequence = [...fixture.calls.sequence];
  const renderedSessions = fixture.calls.renderedSessions.length;
  const renderedDocuments = fixture.calls.renderedDocuments.length;

  await assert.rejects(controller.restore(), /disposed/i);
  await assert.rejects(controller.openReadResult(null), /disposed/i);
  assert.deepEqual(await controller.openPaths(null), { opened: [], failed: [] });
  await assert.rejects(controller.restoreManifest("{bad json"), /disposed/i);
  assert.equal(await controller.importLegacyDraft(), null);
  assert.equal(await controller.loadSnapshot(), null);
  await assert.rejects(controller.start(), /disposed/i);
  assert.equal(controller.activeDocument(), null);

  assert.equal(controller.session, session);
  assert.deepEqual(fixture.calls.sequence, sequence);
  assert.equal(fixture.calls.renderedSessions.length, renderedSessions);
  assert.equal(fixture.calls.renderedDocuments.length, renderedDocuments);
  assert.equal(legacyReads, 1);
});

test("immediate and late listener registrations unsubscribe exactly once after disposal", async (t) => {
  await t.test("synchronous registration", async () => {
    let unsubscribeCalls = 0;
    const fixture = makeDependencies({
      io: {
        listenFileOpened() {
          return () => { unsubscribeCalls += 1; };
        },
      },
    });
    const controller = new SessionController(fixture.dependencies);

    await controller.dispose();
    await settle();

    assert.equal(unsubscribeCalls, 1);
  });

  await t.test("asynchronous registration", async () => {
    const registration = deferred();
    let unsubscribeCalls = 0;
    const fixture = makeDependencies({
      io: {
        listenFileOpened() { return registration.promise; },
      },
    });
    const controller = new SessionController(fixture.dependencies);

    const disposing = controller.dispose();
    registration.resolve(() => { unsubscribeCalls += 1; });
    await disposing;
    await settle();

    assert.equal(unsubscribeCalls, 1);
  });
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

test("editor input is routed to the addressed document only", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const b = controller.createUntitled();

  controller.onEditorInput(a.id, "only a changed");

  assert.equal(a.content, "only a changed");
  assert.equal(a.editRevision, 1);
  assert.equal(b.content, "");
  assert.equal(b.editRevision, 0);
  assert.deepEqual(fixture.calls.scheduler.at(-1), ["changed", a.id, 1]);
});

test("rapid editor input schedules recovery without recursive clean-status manifest writes", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  fixture.calls.manifestWrites.length = 0;
  fixture.calls.scheduler.length = 0;
  for (let index = 0; index < 100; index += 1) controller.onEditorInput(document.id, `edit ${index}`);
  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 0);
  assert.equal(fixture.calls.scheduler.filter(([kind]) => kind === "flush").length, 0);
  assert.equal(fixture.calls.scheduler.filter(([kind]) => kind === "changed").length, 100);
  controller.onRecoveryStatus(document.id, "clean");
  await settle();
  assert.equal(fixture.calls.manifestWrites.length, 0);
});

test("session mutation during flush publishes the first candidate before its catch-up", async () => {
  const gate = deferred();
  const fixture = makeDependencies({ scheduler: { async flush(id) { if (id === "generated-1") await gate.promise; } } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await controller.restore();
  await settle();
  fixture.calls.manifestWrites.length = 0;
  const persisting = controller.persistManifest();
  await settle();
  const b = controller.session.createUntitled();
  controller._presentActivatedDocument(b);
  controller.onEditorInput(a.id, "later");
  gate.resolve();
  await persisting;
  await settle();
  const manifests = fixture.calls.manifestWrites.map(([, raw]) => JSON.parse(raw));
  assert.deepEqual(manifests[0].tabs.map((tab) => tab.documentId), [a.id]);
  assert.equal(manifests[0].tabs[0].snapshotRevision, 0);
  assert.ok(manifests.some((value) => value.tabs.some((tab) => tab.documentId === b.id)));
  assert.equal(controller.activeDocument(), b);
});

test("slow snapshot flush publishes its captured revision before deferred edit catch-up", async () => {
  const storage = memoryStorage();
  const browserIo = createBrowserRecoveryIo(storage);
  const clock = fakeClock();
  const slowWrite = deferred();
  const slowWriteStarted = deferred();
  const catchUpWrite = deferred();
  const catchUpWriteStarted = deferred();
  const manifestRevisions = [];
  let delayRevisionOne = false;
  let controller;
  const fixture = makeDependencies();
  fixture.dependencies.io = {
    ...fixture.dependencies.io,
    ...browserIo,
    async writeRecoveryManifest(generation, json) {
      manifestRevisions.push(JSON.parse(json).tabs[0].snapshotRevision);
      return browserIo.writeRecoveryManifest(generation, json);
    },
  };
  fixture.dependencies.scheduler = new RecoveryScheduler({
    clock,
    async write(documentId, revision) {
      const document = controller.session.documents.get(documentId);
      const json = controller.recoverySnapshotForWrite(documentId, revision)
        || JSON.stringify(document.toSnapshot());
      if (delayRevisionOne && revision === 1) {
        slowWriteStarted.resolve();
        await slowWrite.promise;
      }
      if (revision === 2) {
        catchUpWriteStarted.resolve();
        await catchUpWrite.promise;
      }
      await browserIo.writeRecoveryDocument(documentId, revision, json);
      if (document.snapshotRevision === revision) document.persistedRevision = revision;
    },
    onStatus(documentId, status, error) {
      if (controller) controller.onRecoveryStatus(documentId, status, error);
    },
  });
  controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  const initialManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  const initialRevision = initialManifest.tabs[0].snapshotRevision;
  manifestRevisions.length = 0;
  delayRevisionOne = true;
  controller.onEditorInput(document.id, "revision one");
  const persisting = controller.persistManifest();
  await slowWriteStarted.promise;
  controller.onEditorInput(document.id, "revision two");
  clock.advance(20_000);
  const heldManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.equal(heldManifest.tabs[0].snapshotRevision, initialRevision);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, initialRevision));
  slowWrite.resolve();
  await persisting;
  await catchUpWriteStarted.promise;

  assert.deepEqual(manifestRevisions, [1]);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, 1));
  assert.equal(await browserIo.loadRecoveryDocument(document.id, 2), null);

  catchUpWrite.resolve();
  await settle();
  await controller._manifestWrites;
  assert.deepEqual(manifestRevisions, [1, 2]);
  const durableManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.equal(durableManifest.tabs[0].snapshotRevision, 2);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, 2));
});

test("idle scheduler checkpoints publish each manifest before draining a late revision", async () => {
  const storage = memoryStorage();
  const browserIo = createBrowserRecoveryIo(storage);
  const clock = fakeClock();
  const snapshotOne = deferred();
  const snapshotOneStarted = deferred();
  const manifestOne = deferred();
  const manifestOneStarted = deferred();
  const documentWrites = [];
  let holdRevisionOne = false;
  let controller;
  const fixture = makeDependencies();
  fixture.dependencies.io = {
    ...fixture.dependencies.io,
    ...browserIo,
    async writeRecoveryDocument(documentId, revision, json) {
      documentWrites.push(revision);
      if (holdRevisionOne && revision === 1) {
        snapshotOneStarted.resolve();
        await snapshotOne.promise;
      }
      return browserIo.writeRecoveryDocument(documentId, revision, json);
    },
    async writeRecoveryManifest(generation, json) {
      const revision = JSON.parse(json).tabs[0].snapshotRevision;
      if (holdRevisionOne && revision === 1) {
        manifestOneStarted.resolve();
        await manifestOne.promise;
      }
      return browserIo.writeRecoveryManifest(generation, json);
    },
  };
  fixture.dependencies.scheduler = new RecoveryScheduler({
    clock,
    async write(documentId, revision) {
      const controlled = controller.recoverySnapshotForWrite(documentId, revision);
      if (controlled) return fixture.dependencies.io.writeRecoveryDocument(documentId, revision, controlled);
      return controller.writeRecoveryCheckpoint(documentId, revision);
    },
    onStatus(documentId, status, error) {
      if (controller) controller.onRecoveryStatus(documentId, status, error);
    },
  });
  controller = new SessionController(fixture.dependencies);
  assert.equal(typeof controller.writeRecoveryCheckpoint, "function");
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  const initialManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  holdRevisionOne = true;
  controller.onEditorInput(document.id, "revision one");
  clock.advance(1_000);
  await snapshotOneStarted.promise;
  controller.onEditorInput(document.id, "revision two");
  snapshotOne.resolve();
  await manifestOneStarted.promise;

  assert.deepEqual(documentWrites.slice(-1), [1]);
  assert.equal(JSON.parse(await browserIo.loadRecoveryManifest()).tabs[0].snapshotRevision,
    initialManifest.tabs[0].snapshotRevision);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, initialManifest.tabs[0].snapshotRevision));

  manifestOne.resolve();
  await settle();
  await controller._checkpointWrites;
  assert.deepEqual(documentWrites.slice(-2), [1, 2]);
  const latestManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.equal(latestManifest.tabs[0].snapshotRevision, 2);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, 2));
});

test("checkpoint transactions from two document timers serialize their manifests", async () => {
  const firstManifest = deferred();
  const firstManifestStarted = deferred();
  const documentWrites = [];
  const manifests = [];
  const fixture = makeDependencies({
    io: {
      async writeRecoveryDocument(documentId) { documentWrites.push(documentId); },
      async writeRecoveryManifest(generation, json) {
        manifests.push(JSON.parse(json));
        if (manifests.length === 1) {
          firstManifestStarted.resolve();
          await firstManifest.promise;
        }
      },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const b = controller.createUntitled();
  const checkpointA = controller.writeRecoveryCheckpoint(a.id, a.snapshotRevision);
  const checkpointB = controller.writeRecoveryCheckpoint(b.id, b.snapshotRevision);
  await firstManifestStarted.promise;
  assert.deepEqual(documentWrites, [a.id]);

  firstManifest.resolve();
  await Promise.all([checkpointA, checkpointB]);
  assert.deepEqual(documentWrites, [a.id, b.id]);
  assert.deepEqual(manifests[0].tabs.map((tab) => tab.documentId), [a.id]);
  assert.deepEqual(manifests[1].tabs.map((tab) => tab.documentId), [a.id, b.id]);
});

test("closing a document during its checkpoint preserves old recovery until an excluding manifest", async () => {
  const storage = memoryStorage();
  const browserIo = createBrowserRecoveryIo(storage);
  const clock = fakeClock();
  const slowSnapshot = deferred();
  const slowSnapshotStarted = deferred();
  let hold = false;
  let controller;
  const fixture = makeDependencies();
  fixture.dependencies.io = {
    ...fixture.dependencies.io,
    ...browserIo,
    async writeRecoveryDocument(documentId, revision, json) {
      if (hold && revision === 1) {
        slowSnapshotStarted.resolve();
        await slowSnapshot.promise;
      }
      return browserIo.writeRecoveryDocument(documentId, revision, json);
    },
  };
  fixture.dependencies.scheduler = new RecoveryScheduler({
    clock,
    async write(documentId, revision) {
      const controlled = controller.recoverySnapshotForWrite(documentId, revision);
      if (controlled) return fixture.dependencies.io.writeRecoveryDocument(documentId, revision, controlled);
      return controller.writeRecoveryCheckpoint(documentId, revision);
    },
    onStatus(documentId, status, error) {
      if (controller) controller.onRecoveryStatus(documentId, status, error);
    },
  });
  controller = new SessionController(fixture.dependencies);
  const closing = controller.createUntitled();
  await controller.restore();
  await settle();
  const durableBefore = JSON.parse(await browserIo.loadRecoveryManifest());
  closing.updateWorkspace({ ...closing.workspace, tocOpen: true });
  hold = true;
  fixture.dependencies.scheduler.changed(closing.id, closing.snapshotRevision);
  clock.advance(1_000);
  await slowSnapshotStarted.promise;

  assert.equal(controller.closeDocument(closing.id), true);
  const replacement = controller.activeDocument();
  slowSnapshot.resolve();
  await settle();
  await controller._manifestWrites;
  const durableAfter = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.ok(await browserIo.loadRecoveryDocument(closing.id, durableBefore.tabs[0].snapshotRevision));
  assert.equal(durableAfter.tabs.some((tab) => tab.documentId === closing.id), false);
  assert.equal(durableAfter.activeDocumentId, replacement.id);
  assert.notEqual(replacement.recoveryStatus, "failed");
});

test("a deferred render cannot replace the preview after another document activates", async () => {
  const pending = deferred();
  const fixture = makeDependencies({
    renderer: { render: async ({ documentId }) => documentId === "generated-1" ? pending.promise : "preview:b" },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const renderingA = controller.renderDocument(a.id);
  const b = controller.createUntitled();
  await controller.renderDocument(b.id);

  pending.resolve("preview:a");
  await renderingA;

  assert.equal(controller.activeDocument(), b);
  assert.equal(fixture.calls.preview.at(-1)[0], "preview:b");
  assert.equal(fixture.calls.preview.some(([html]) => html === "preview:a"), false);
});

test("a deferred export keeps its starting document identity after a tab switch", async () => {
  const pending = deferred();
  const fixture = makeDependencies({
    exporter: { export: async (capture) => {
      assert.equal(capture.documentId, "generated-1");
      assert.equal(capture.displayName, "Untitled 1");
      return pending.promise;
    } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  controller.onEditorInput(a.id, "export a");
  const exporting = controller.exportActive("html");
  const b = controller.createUntitled();

  pending.resolve({ message: "Exported Untitled 1.html" });
  await exporting;

  assert.equal(controller.activeDocument(), b);
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
  assert.match(fixture.calls.statuses.at(-1)[1].message, /Untitled 1/);
});

test("captured block export completion remains attached to its starting document", async () => {
  const pending = deferred();
  let capture;
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  a.displayName = "alpha.md";
  controller.onEditorInput(a.id, "alpha content");
  const exporting = controller.runCapturedExport("table 2 as CSV", async (starting, isCurrent) => {
    capture = starting;
    await pending.promise;
    assert.equal(isCurrent(), true);
    return { message: `Exported ${starting.displayName}-table-2.csv` };
  });
  const b = controller.createUntitled();
  pending.resolve();
  await exporting;

  assert.equal(capture.documentId, a.id);
  assert.equal(capture.editRevision, a.editRevision);
  assert.equal(capture.displayName, "alpha.md");
  assert.equal(capture.content, "alpha content");
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
  assert.match(fixture.calls.statuses.at(-1)[1].message, /alpha\.md-table-2\.csv/);
  assert.equal(controller.activeDocument(), b);
});

test("a stale captured export failure is still reported to its starting document", async () => {
  const pending = deferred();
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const exporting = controller.runCapturedExport("diagram 1 as SVG", async () => pending.promise);
  controller.onEditorInput(a.id, "new revision");
  pending.reject(new Error("stale preview"));

  await assert.rejects(exporting, /stale preview/);
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
  assert.match(fixture.calls.statuses.at(-1)[1].message, /stale preview/);
});

test("document capture guards distinguish tab switches from revision staleness", () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const capture = controller.captureActiveDocument();
  const b = controller.createUntitled();

  assert.equal(controller.isDocumentCaptureCurrent(capture), true);
  assert.equal(controller.isDocumentCaptureCurrent(capture, { requireActive: true }), false);
  controller.onEditorInput(a.id, "changed after capture");
  assert.equal(controller.isDocumentCaptureCurrent(capture), false);
  assert.equal(controller.activeDocument(), b);
});

test("PDF print guard rejects a captured document after a tab switch or preview replacement", () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const capture = controller.captureActiveDocument({ format: "pdf" });
  const owner = { documentId: a.id, editRevision: a.editRevision };

  assert.equal(controller.canPrintCapture(capture, owner), true);
  assert.equal(controller.canPrintCapture(capture, { ...owner, documentId: "other" }), false);
  controller.createUntitled();
  assert.equal(controller.canPrintCapture(capture, owner), false);
});

test("activation captures, flushes, switches, restores, persists, then renders without waiting for recovery", async () => {
  const flushGate = deferred();
  const events = [];
  const workspaceA = {
    ...emptyWorkspace(),
    selectionStart: 2,
    selectionEnd: 5,
    editorScrollTop: 17,
    previewScrollTop: 23,
    viewMode: "edit",
    tocOpen: true,
    find: { open: true, query: "a", replacement: "b", matchIndex: 1 },
  };
  let aId;
  const fixture = makeDependencies({
    scheduler: {
      flush(id, revision) {
        events.push(["flush", id, revision]);
        return flushGate.promise;
      },
    },
    view: {
      captureWorkspace(id) { events.push(["capture", id]); return workspaceA; },
      renderSession() { events.push(["render-session"]); },
      renderDocument(document) { events.push(["show-document", document.id]); },
      ensureEditor(document) { events.push(["ensure", document.id]); },
      activateEditor(id) { events.push(["activate-editor", id]); },
      applyWorkspace(id, workspace) { events.push(["apply", id, workspace.selectionStart]); },
      focusActiveEditor() { events.push(["focus"]); },
      clearPreview() { events.push(["clear-preview"]); },
    },
    requestAnimationFrame(callback) { events.push(["frame"]); callback(); },
    renderer: { async render({ documentId }) { events.push(["render", documentId]); return `preview:${documentId}`; } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  aId = a.id;
  controller.onEditorInput(a.id, "abcdef");
  events.length = 0;
  const b = controller.createUntitled();
  await settle();

  assert.equal(controller.activeDocument(), b);
  assert.deepEqual(a.workspace, workspaceA);
  assert.deepEqual(events.slice(0, 6).map(([name]) => name), [
    "capture", "flush", "render-session", "ensure", "activate-editor", "show-document",
  ]);
  assert.ok(events.findIndex(([name]) => name === "frame") < events.findIndex(([name]) => name === "render"));
  assert.ok(events.some(([name, id]) => name === "render" && id === b.id));
  assert.equal((await outcomeByImmediate(flushGate.promise)).status, "unsettled");
  flushGate.resolve();
});

test("keyboard activation can preserve tab focus while restoring workspace", () => {
  const frames = [];
  const fixture = makeDependencies({ requestAnimationFrame(callback) { frames.push(callback); } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const b = controller.createUntitled();
  frames.splice(0).forEach((callback) => callback());
  fixture.calls.activation.length = 0;

  controller.activateDocument(a.id, { focusEditor: false, preserveTabFocus: true });
  frames.splice(0).forEach((callback) => callback());

  assert.equal(controller.activeDocument(), a);
  assert.ok(fixture.calls.activation.some(([kind, id]) => kind === "apply" && id === a.id));
  assert.equal(fixture.calls.activation.some(([kind]) => kind === "focus"), false);
  assert.notEqual(a.id, b.id);
});

test("workspace-only activation checkpoints use increasing snapshot revisions", async () => {
  let selection = 1;
  let controller;
  const writes = [];
  const fixture = makeDependencies({
    view: {
      captureWorkspace() { return { ...emptyWorkspace(), selectionStart: selection, selectionEnd: selection }; },
    },
    scheduler: {
      async flush(id, revision) {
        const document = controller.session.documents.get(id);
        writes.push([id, revision, document.toSnapshot()]);
      },
    },
  });
  controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  a.content = "abcdef";
  const b = controller.createUntitled();
  b.content = "abcdef";
  await settle();
  controller.activateDocument(a.id);
  selection = 2;
  controller.activateDocument(b.id);
  selection = 3;
  controller.activateDocument(a.id);
  await settle();

  const aWrites = fixture.calls.scheduler.filter(([kind, id, revision]) => kind === "changed" && id === a.id && revision > 0);
  assert.deepEqual([...new Set(aWrites.map(([, , revision]) => revision))], [1, 2]);
  const savedA = writes.filter(([id]) => id === a.id);
  assert.deepEqual([...new Set(savedA.map(([, revision]) => revision))], [1, 2]);
  assert.equal(DocumentModel.fromSnapshot(savedA.at(-1)[2]).workspace.selectionStart, 2);
  assert.equal(a.editRevision, 0);
  assert.equal(a.snapshotRevision, 2);
});

test("new documents checkpoint a snapshot before their manifest is published", async () => {
  const order = [];
  const fixture = makeDependencies({
    scheduler: {
      changed() { return true; },
      async flush(id, revision) { order.push(["document", id, revision]); },
    },
    io: {
      async writeRecoveryManifest(generation, json) { order.push(["manifest", generation, JSON.parse(json)]); },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();

  await controller.restore();
  await settle();

  const documentIndex = order.findIndex(([kind, id]) => kind === "document" && id === document.id);
  const manifestIndex = order.findIndex(([kind]) => kind === "manifest");
  assert.ok(documentIndex >= 0);
  assert.ok(manifestIndex > documentIndex);
});

test("a newly opened clean document checkpoints before its first manifest reference", async () => {
  const order = [];
  const fixture = makeDependencies({
    scheduler: {
      changed() { return true; },
      async flush(id, revision) { order.push(["document", id, revision]); },
    },
    io: {
      async writeRecoveryManifest(generation, json) { order.push(["manifest", generation, JSON.parse(json)]); },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  const document = controller.openReadResult(readResult("opened.md"));

  await controller.restore();
  await settle();

  assert.ok(order.findIndex(([kind, id]) => kind === "document" && id === document.id)
    < order.findIndex(([kind]) => kind === "manifest"));
});

test("snapshot failure prevents publishing a dangling manifest and reports recovery failure", async () => {
  const fixture = makeDependencies({
    scheduler: {
      changed() { return true; },
      async flush() { throw new Error("snapshot quota"); },
    },
  });
  const controller = new SessionController(fixture.dependencies);
  controller.createUntitled();

  await controller.restore();
  await settle();

  assert.equal(fixture.calls.manifestWrites.length, 0);
  assert.match(fixture.calls.recoveryErrors.at(-1).message, /snapshot quota/);
});

test("initial manifest failure is reported after its document snapshot succeeds", async () => {
  let fail = true;
  const fixture = makeDependencies({
    io: { async writeRecoveryManifest(generation, json) {
      if (fail) throw new Error("manifest quota");
      fixture.calls.manifestWrites.push([generation, json]);
    } },
  });
  const controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();

  await controller.restore();
  await settle();

  assert.match(fixture.calls.recoveryErrors.at(-1).message, /manifest quota/);
  assert.equal(fixture.calls.recoveryErrors.at(-1).phase, "initial-checkpoint");
  assert.equal(fixture.calls.statuses.at(-1)[1].recoveryStatus, "failed");
  assert.match(fixture.calls.statuses.at(-1)[1].message, /manifest quota/);
  assert.ok(fixture.calls.scheduler.some(([kind]) => kind === "flush"));
  const schedulerCalls = fixture.calls.scheduler.length;
  controller.onEditorInput(document.id, "blocked edit");
  assert.equal(fixture.calls.scheduler.length, schedulerCalls);
  const future = controller.createUntitled();
  assert.equal(future.recoveryStatus, "failed");
  fail = false;
  assert.equal(await controller.retryRecovery(document.id), true);
  assert.equal(fixture.calls.manifestWrites.length, 1);
  assert.deepEqual(JSON.parse(fixture.calls.manifestWrites[0][1]).tabs.map((tab) => tab.documentId), [document.id, future.id]);
  assert.equal(document.recoveryStatus, "clean");
  assert.equal(future.recoveryStatus, "clean");
});

test("an edit during whole-session retry remains deferred and pending after manifest success", async () => {
  const retryGate = deferred();
  const retryStarted = deferred();
  let first = true;
  const fixture = makeDependencies({
    io: { async writeRecoveryManifest(generation, json) {
      if (first) {
        first = false;
        throw new Error("initial manifest failure");
      }
      retryStarted.resolve();
      await retryGate.promise;
      fixture.calls.manifestWrites.push([generation, json]);
    } },
  });
  const controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  const retrying = controller.retryRecovery();
  await retryStarted.promise;
  const schedulerBefore = fixture.calls.scheduler.length;
  controller.onEditorInput(document.id, "changed while retry manifest is held");
  assert.equal(document.recoveryStatus, "failed");
  assert.equal(fixture.calls.scheduler.length, schedulerBefore);

  retryGate.resolve();
  assert.equal(await retrying, true);
  assert.equal(document.recoveryStatus, "pending");
  assert.deepEqual(fixture.calls.scheduler.at(-1), ["changed", document.id, document.snapshotRevision]);
});

test("held manifest publication defers edits and rejection blocks the whole session", async () => {
  const manifestGate = deferred();
  let hold = false;
  const fixture = makeDependencies({
    io: { async writeRecoveryManifest(generation, json) {
      if (hold) return manifestGate.promise;
      fixture.calls.manifestWrites.push([generation, json]);
    } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await controller.restore();
  await settle();
  hold = true;
  const persisting = controller.persistManifest();
  await settle();
  const before = fixture.calls.scheduler.length;
  controller.onEditorInput(a.id, "during manifest");
  const b = controller.session.createUntitled();
  controller._presentActivatedDocument(b);
  assert.equal(fixture.calls.scheduler.length, before);
  manifestGate.reject(new Error("manifest rejected"));
  await assert.rejects(persisting, /manifest rejected/);
  assert.equal(a.recoveryStatus, "failed");
  assert.equal(b.recoveryStatus, "failed");
  const blockedCalls = fixture.calls.scheduler.length;
  controller.onEditorInput(b.id, "blocked too");
  assert.equal(fixture.calls.scheduler.length, blockedCalls);
});

test("successful held manifest schedules only the latest deferred revision", async () => {
  const manifestGate = deferred();
  const manifestStarted = deferred();
  let hold = false;
  const fixture = makeDependencies({
    io: { async writeRecoveryManifest(generation, json) {
      if (hold) {
        manifestStarted.resolve();
        await manifestGate.promise;
      }
      fixture.calls.manifestWrites.push([generation, json]);
    } },
  });
  const controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  hold = true;
  const persisting = controller.persistManifest();
  await manifestStarted.promise;
  const schedulerBefore = fixture.calls.scheduler.length;
  const changedBefore = fixture.calls.scheduler.filter(([kind]) => kind === "changed").length;
  controller.onEditorInput(document.id, "first deferred edit");
  controller.onEditorInput(document.id, "latest deferred edit");
  assert.equal(fixture.calls.scheduler.filter(([kind]) => kind === "changed").length, changedBefore);

  hold = false;
  manifestGate.resolve();
  await persisting;
  const deferredChanges = fixture.calls.scheduler.slice(schedulerBefore).filter(
    ([kind, id, revision]) => kind === "changed" && id === document.id
      && revision === document.snapshotRevision,
  );
  assert.equal(deferredChanges.length, 1);
  assert.equal(document.recoveryStatus, "pending");
});

test("real scheduler cannot rotate a durable snapshot while a manifest publish is held", async () => {
  const storage = memoryStorage();
  const browserIo = createBrowserRecoveryIo(storage);
  const clock = fakeClock();
  const documentWrites = [];
  let manifestGate = null;
  let manifestStarted = null;
  let controller;
  const fixture = makeDependencies();
  fixture.dependencies.io = {
    ...fixture.dependencies.io,
    ...browserIo,
    async writeRecoveryDocument(documentId, revision, json) {
      documentWrites.push([documentId, revision]);
      return browserIo.writeRecoveryDocument(documentId, revision, json);
    },
    async writeRecoveryManifest(generation, json) {
      if (manifestGate) {
        manifestStarted.resolve();
        await manifestGate.promise;
      }
      return browserIo.writeRecoveryManifest(generation, json);
    },
  };
  fixture.dependencies.scheduler = new RecoveryScheduler({
    clock,
    async write(documentId, revision) {
      const document = controller.session.documents.get(documentId);
      await fixture.dependencies.io.writeRecoveryDocument(
        documentId,
        revision,
        JSON.stringify(document.toSnapshot()),
      );
      document.persistedRevision = revision;
    },
    onStatus(documentId, status, error) {
      if (controller) controller.onRecoveryStatus(documentId, status, error);
    },
  });
  controller = new SessionController(fixture.dependencies);
  const document = controller.createUntitled();
  await controller.restore();
  await settle();
  const durableManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  const durableRevision = durableManifest.tabs[0].snapshotRevision;
  const writesBeforeBarrier = documentWrites.length;

  manifestGate = deferred();
  manifestStarted = deferred();
  const persisting = controller.persistManifest();
  await manifestStarted.promise;
  controller.onEditorInput(document.id, "first blocked edit");
  controller.onEditorInput(document.id, "second blocked edit");
  clock.advance(20_000);
  await settle();
  assert.equal(documentWrites.length, writesBeforeBarrier);

  manifestGate.reject(new Error("held manifest rejected"));
  await assert.rejects(persisting, /held manifest rejected/);
  const reloadedManifest = JSON.parse(await browserIo.loadRecoveryManifest());
  assert.equal(reloadedManifest.tabs[0].snapshotRevision, durableRevision);
  assert.ok(await browserIo.loadRecoveryDocument(document.id, durableRevision));
  assert.equal(document.recoveryStatus, "failed");
});

test("a failed outgoing recovery flush is reported to that document without rolling activation back", async () => {
  const fixture = makeDependencies({
    scheduler: { async flush() { throw new Error("disk full"); } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const b = controller.createUntitled();
  await settle();

  assert.equal(controller.activeDocument(), b);
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
  assert.match(fixture.calls.statuses.at(-1)[1].message, /disk full/);
  assert.equal(fixture.calls.recoveryErrors.at(-1).documentId, a.id);
  assert.equal(fixture.calls.recoveryErrors.at(-1).phase, "activation-flush");
});

test("a render is stale after its captured document revision changes", async () => {
  const pending = deferred();
  let renders = 0;
  const fixture = makeDependencies({ renderer: { render: async () => {
    renders += 1;
    if (renders === 2) return pending.promise;
    return renders === 1 ? "initial preview" : "new preview";
  } } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await settle();
  a.applyContent("revision one");
  const rendering = controller.renderDocument(a.id);
  controller.onEditorInput(a.id, "revision two");
  pending.resolve("old preview");
  await rendering;
  await settle();

  assert.equal(fixture.calls.preview.some(([html]) => html === "old preview"), false);
  assert.equal(fixture.calls.preview.at(-1)[0], "new preview");
});

test("only the newest concurrent render for one document can commit", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const fixture = makeDependencies({ renderer: { render: async () => (++calls === 1 ? first.promise : second.promise) } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const older = controller.renderDocument(a.id);
  const newer = controller.renderDocument(a.id);
  second.resolve("new preview");
  await newer;
  first.resolve("old preview");
  await older;

  assert.equal(fixture.calls.preview.at(-1)[0], "new preview");
  assert.equal(fixture.calls.preview.some(([html]) => html === "old preview"), false);
});

test("deferred renderer commit and async completion guards follow active identity", async () => {
  const completed = deferred();
  const guards = [];
  let commits = 0;
  const fixture = makeDependencies({ renderer: { async render({ documentId }) {
    if (documentId !== "generated-1") return "preview:b";
    return {
      async commit(_capture, isCurrent) {
        commits += 1;
        guards.push(isCurrent());
        await completed.promise;
        guards.push(isCurrent());
        return "preview:a";
      },
    };
  } } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await settle();
  assert.equal(commits, 1);
  const b = controller.createUntitled();
  await settle();
  completed.resolve();
  await settle();

  assert.equal(controller.activeDocument(), b);
  assert.deepEqual(guards, [true, false]);
  assert.equal(fixture.calls.preview.some(([html]) => html === "preview:a"), false);
  assert.ok(a.id !== b.id);
});

test("export errors are reported to the starting document and do not switch tabs", async () => {
  const pending = deferred();
  const fixture = makeDependencies({ exporter: { export: async () => pending.promise } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const exporting = controller.exportActive("png");
  const b = controller.createUntitled();
  pending.reject(new Error("canvas failed"));

  await assert.rejects(exporting, /canvas failed/);
  assert.equal(controller.activeDocument(), b);
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
  assert.match(fixture.calls.statuses.at(-1)[1].message, /canvas failed/);
});

test("HTML and PNG exports receive isolated rendered HTML for the captured revision", async () => {
  const rendered = deferred();
  const sharedRender = deferred();
  const captures = [];
  const fixture = makeDependencies({
    renderer: {
      render: async () => sharedRender.promise,
      renderForExport: async (capture) => {
        await rendered.promise;
        return `<article>${capture.content}</article>`;
      },
    },
    exporter: { export: async (capture) => { captures.push(capture); return { bytes: capture.renderedHtml.length }; } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  controller.onEditorInput(a.id, "captured alpha");
  const exporting = controller.exportActive("html");
  controller.createUntitled();
  rendered.resolve();

  const result = await exporting;
  assert.ok(result.bytes > 0);
  assert.equal(captures[0].documentId, a.id);
  assert.equal(captures[0].renderedHtml, "<article>captured alpha</article>");
  assert.equal((await outcomeByImmediate(sharedRender.promise)).status, "unsettled");
  sharedRender.resolve("shared preview");
  await settle();
});

test("isolated export render failure is explicit and never invokes the exporter", async () => {
  let exported = false;
  const fixture = makeDependencies({
    renderer: { render: async () => "shared", renderForExport: async () => { throw new Error("isolated render failed"); } },
    exporter: { export: async () => { exported = true; } },
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();

  await assert.rejects(controller.exportActive("png"), /isolated render failed/);
  assert.equal(exported, false);
  assert.equal(fixture.calls.statuses.at(-1)[0], a.id);
});

test("recordCapturedSave updates only the captured baseline and preserves edits made during save", async () => {
  const fixture = makeDependencies();
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  controller.onEditorInput(a.id, "first");
  const capture = controller.captureActiveDocument();
  const b = controller.createUntitled();

  controller.recordCapturedSave(capture, { contentSha256: "sha:first", diskSha256: "sha:first" });
  assert.equal(a.dirty, false);
  assert.equal(b.dirty, false);
  assert.equal(controller.activeDocument(), b);

  controller.activateDocument(a.id);
  const editingCapture = controller.captureActiveDocument();
  controller.onEditorInput(a.id, "second");
  controller.recordCapturedSave(editingCapture, { contentSha256: "sha:first", diskSha256: "sha:first" });
  assert.equal(a.dirty, true);
  assert.equal(a.savedContentSha256, "sha:first");
});

test("export completion is ignored when its starting document was closed", async () => {
  const pending = deferred();
  const fixture = makeDependencies({ exporter: { export: async () => pending.promise } });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  const exporting = controller.exportActive("html");
  controller.closeDocument(a.id);
  const statusesBeforeCompletion = fixture.calls.statuses.filter(([id]) => id === a.id).length;
  pending.resolve({ message: "late export" });
  await exporting;

  assert.equal(fixture.calls.statuses.filter(([id]) => id === a.id).length, statusesBeforeCompletion);
  assert.notEqual(controller.activeDocument() && controller.activeDocument().id, a.id);
});

test("preview cache evicts least-recently-used entries by count and invalidates edited documents", async () => {
  let renders = 0;
  const fixture = makeDependencies({
    renderer: { render: async ({ documentId }) => `${documentId}:${++renders}` },
    previewCacheMaxEntries: 2,
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await settle();
  const b = controller.createUntitled();
  await settle();
  controller.activateDocument(a.id);
  await settle(); // touch a
  const c = controller.createUntitled();
  await settle(); // evicts b
  controller.activateDocument(b.id);
  await settle();
  assert.equal(renders, 4);

  controller.activateDocument(a.id);
  controller.onEditorInput(a.id, "edited");
  await settle();
  const afterEditRender = renders;
  await controller.renderDocument(a.id);
  assert.equal(renders, afterEditRender); // input render populated the new-revision cache
});

test("preview cache also evicts entries over the serialized byte budget", async () => {
  let renders = 0;
  const fixture = makeDependencies({
    renderer: { render: async () => `${++renders}:123456789` },
    previewCacheMaxEntries: 5,
    previewCacheMaxBytes: 12,
  });
  const controller = new SessionController(fixture.dependencies);
  const a = controller.createUntitled();
  await settle();
  controller.createUntitled();
  await settle();
  controller.activateDocument(a.id);
  await settle();

  assert.equal(renders, 3);
});

test("browser bootstrap delegates document ownership and active operations to the session controller", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "src", "index.template.html"), "utf8");

  assert.match(template, /new MDEdit\.WorkspaceView\s*\(/);
  assert.match(template, /new MDEdit\.RecoveryScheduler\s*\(/);
  assert.match(template, /new MDEdit\.SessionController\s*\(/);
  assert.match(template, /controller\.onEditorInput\s*\(/);
  assert.match(template, /controller\.exportActive\s*\(/);
  assert.match(template, /controller\.activateDocument\s*\(/);
  assert.doesNotMatch(template, /\blet\s+(?:fileHandle|nativePath|dirty)\b/);
  assert.ok(template.indexOf("listenFileOpened(handler)") < template.indexOf("await controller.restore()"));
  assert.match(template, /writeToHandle\(fileHandle, capture\.content\)/);
});

test("browser builds resolve editors by active document without a mutable editor owner", () => {
  for (const filename of ["src/index.template.html", "index.html", "index-lite.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    assert.doesNotMatch(html, /\blet\s+editor\b/, filename);
    assert.doesNotMatch(html, /\beditor\s*=\s*(?:event|e)\.target/, filename);
    assert.match(html, /function activeEditor\(\)[\s\S]*controller\.activeDocument\(\)[\s\S]*workspaceView\.editorFor\(active\.id\)/, filename);
    assert.match(html, /function isActiveEditorEvent\(event\)/, filename);
    assert.match(html, /controller\.runCapturedExport\("diagram " \+ n \+ " as SVG"/, filename);
    assert.match(html, /controller\.runCapturedExport\("table " \+ n \+ " as CSV"/, filename);
    assert.match(html, /canPrintCapture\(capture, previewOwner\)/, filename);
    assert.match(html, /createBrowserRecoveryEnvironment\(window\)/, filename);
    assert.match(html, /controller\.writeRecoveryCheckpoint\(documentId, revision\)/, filename);
    assert.match(html, /renderForExport/, filename);
    assert.match(html, /capture\.renderedHtml/, filename);
    assert.doesNotMatch(html, /cleanPreviewClone\(\)/, filename);
    assert.match(html, /addEventListener\("change", async \(e\)/, filename);
    assert.match(html, /for \(const file of e\.target\.files \|\| \[\]\)[\s\S]{0,120}await openFromFile/, filename);
    assert.match(html, /downloadAsSave\(capture\)[\s\S]{0,300}recordCapturedSave\(capture/, filename);
    assert.match(html, /await saveAs\(capture\)/, filename);
    assert.match(html, /async function saveAs\(capture\)/, filename);
  }
});

test("DocumentModel workspace replacement is validated and detached", () => {
  const document = new DocumentModel({
    id: "workspace-document",
    displayName: "workspace.md",
    content: "abcdef",
    savedContentSha256: "sha:abcdef",
  });
  const input = {
    ...emptyWorkspace(),
    selectionStart: 2,
    selectionEnd: 4,
    find: { open: true, query: "b", replacement: "c", matchIndex: 0 },
  };

  document.updateWorkspace(input);
  input.selectionStart = 6;
  input.find.query = "changed";

  assert.equal(document.workspace.selectionStart, 2);
  assert.equal(document.workspace.find.query, "b");
  assert.throws(() => document.updateWorkspace({ ...emptyWorkspace(), viewMode: "invalid" }), /view mode/i);
});
