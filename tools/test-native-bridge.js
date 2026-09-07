const test = require("node:test");
const assert = require("node:assert");
const { makeNativeApp } = require("../src/native-bridge.js");

function fakeTauri() {
  const calls = { open: null, save: null, writeFile: [], invoke: [] };
  const selectedExportPaths = new Set();
  const tauri = {
    dialog: {
      open: async (opts) => { calls.open = opts; return "C:\\notes\\doc.md"; },
      save: async (opts) => {
        calls.save = opts;
        selectedExportPaths.add("C:\\notes\\out.md");
        return "C:\\notes\\out.md";
      },
    },
    fs: {
      writeFile: async (p, d) => {
        if (!selectedExportPaths.has(p)) throw new Error("path not allowed by dialog scope");
        calls.writeFile.push(["bytes", p, d]);
      },
    },
    core: {
      invoke: async (command, args) => {
        calls.invoke.push([command, args]);
        const responses = {
          read_document: "read-document-result",
          save_document: { saved: true },
          canonicalize_document_path: "C:\\notes\\doc.md",
          load_recovery_manifest: null,
          load_recovery_document: "recovery-document-result",
          write_recovery_document: { bytes: 2, atomicWriteDurationMs: 1.25 },
          write_recovery_manifest: undefined,
          delete_recovery_document: undefined,
          recovery_directory: "C:\\recovery",
          take_pending_files: ["C:\\notes\\a.md", "C:\\notes\\b.md"],
        };
        return responses[command];
      },
    },
  };
  return { tauri, calls };
}

test("makeNativeApp returns null without a Tauri global (plain browser)", () => {
  assert.equal(makeNativeApp(undefined), null);
});

test("makeNativeApp returns null when a plugin API is missing", () => {
  assert.equal(makeNativeApp({ dialog: {} }), null);
  assert.equal(makeNativeApp({ fs: {} }), null);
  assert.equal(makeNativeApp({ core: {} }), null);
});

test("native bridge exposes no direct text-file read or Save As APIs", () => {
  const { tauri } = fakeTauri();
  const app = makeNativeApp(tauri);

  assert.equal(app.readFile, undefined);
  assert.equal(app.saveAs, undefined);
});

test("writeFile rejects text and paths not granted by the save dialog", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);

  await assert.rejects(app.writeFile("C:\\notes\\out.md", "text"), /raw byte/i);
  assert.deepEqual(calls.writeFile, []);
  const bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(app.writeFile("C:\\notes\\arbitrary.png", bytes), /not allowed/i);
  await app.chooseSavePath({ suggestedName: "out.png" });
  await app.writeFile("C:\\notes\\out.md", bytes.buffer);
  assert.deepEqual(calls.writeFile, [["bytes", "C:\\notes\\out.md", bytes]]);
});

test("pickFile resolves the chosen path and null on cancel", async () => {
  const { tauri } = fakeTauri();
  const app = makeNativeApp(tauri);
  assert.equal(await app.pickFile(), "C:\\notes\\doc.md");
  tauri.dialog.open = async () => null;
  assert.equal(await app.pickFile(), null);
});

test("pickFiles returns every selection and normalizes strings, arrays, and cancel", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);

  assert.deepEqual(await app.pickFiles(), ["C:\\notes\\doc.md"]);
  assert.deepEqual(calls.open, {
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
  });

  tauri.dialog.open = async () => ["C:\\notes\\a.md", "C:\\notes\\b.md"];
  assert.deepEqual(await app.pickFiles(), ["C:\\notes\\a.md", "C:\\notes\\b.md"]);

  tauri.dialog.open = async () => null;
  assert.deepEqual(await app.pickFiles(), []);
});

test("takePendingFiles normalizes one, many, and no queued paths", async () => {
  const { tauri } = fakeTauri();
  const app = makeNativeApp(tauri);
  tauri.core.invoke = async () => "C:\\notes\\one.md";
  assert.deepEqual(await app.takePendingFiles(), ["C:\\notes\\one.md"]);
  tauri.core.invoke = async () => ["C:\\notes\\a.md", "C:\\notes\\b.md"];
  assert.deepEqual(await app.takePendingFiles(), ["C:\\notes\\a.md", "C:\\notes\\b.md"]);
  tauri.core.invoke = async () => null;
  assert.deepEqual(await app.takePendingFiles(), []);
});

test("chooseSavePath only chooses a path and does not write", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);
  assert.equal(await app.chooseSavePath({ suggestedName: "doc.md" }), "C:\\notes\\out.md");
  assert.deepEqual(calls.writeFile, []);
});

test("chooseSavePath anchors the dialog in defaultDir when given", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);
  await app.chooseSavePath({ defaultDir: "C:\\notes", suggestedName: "c.md" });
  assert.equal(calls.save.defaultPath, "C:\\notes/c.md");
  await app.chooseSavePath({ defaultDir: "/home/u/docs/", suggestedName: "c.md" });
  assert.equal(calls.save.defaultPath, "/home/u/docs/c.md");
});

test("chooseSavePath falls back to the bare name without a defaultDir", async () => {
  const { tauri, calls } = fakeTauri();
  await makeNativeApp(tauri).chooseSavePath({ suggestedName: "c.md" });
  assert.equal(calls.save.defaultPath, "c.md");
});

test("document bridge methods invoke the expected Tauri commands and forward results", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);

  assert.equal(await app.readDocument("C:\\notes\\doc.md"), "read-document-result");
  assert.deepEqual(
    await app.saveDocument({ path: "C:\\notes\\doc.md", content: "x", expectedSha256: "abc123" }),
    { saved: true }
  );
  assert.equal(await app.canonicalizeDocumentPath("C:\\notes\\doc.md"), "C:\\notes\\doc.md");
  assert.equal(await app.loadRecoveryManifest(), null);
  assert.equal(await app.loadRecoveryDocument("doc-1", 4), "recovery-document-result");
  const recoveryMetrics = await app.writeRecoveryDocument("doc-1", 5, "{}");
  assert.equal(recoveryMetrics.bytes, 2);
  assert.equal(recoveryMetrics.atomicWriteDurationMs, 1.25);
  assert.ok(Number.isFinite(recoveryMetrics.ipcAndNativeDurationMs));
  assert.ok(recoveryMetrics.ipcAndNativeDurationMs >= 0);
  assert.equal(await app.writeRecoveryManifest(6, "{}"), undefined);
  assert.equal(await app.deleteRecoveryDocument("doc-1"), undefined);
  assert.equal(await app.recoveryDirectory(), "C:\\recovery");
  assert.deepEqual(await app.takePendingFiles(), ["C:\\notes\\a.md", "C:\\notes\\b.md"]);

  assert.deepEqual(calls.invoke, [
    ["read_document", { path: "C:\\notes\\doc.md" }],
    ["save_document", { path: "C:\\notes\\doc.md", content: "x", expectedSha256: "abc123" }],
    ["canonicalize_document_path", { path: "C:\\notes\\doc.md" }],
    ["load_recovery_manifest", undefined],
    ["load_recovery_document", { documentId: "doc-1", snapshotRevision: 4 }],
    ["write_recovery_document", { documentId: "doc-1", revision: 5, json: "{}" }],
    ["write_recovery_manifest", { generation: 6, json: "{}" }],
    ["delete_recovery_document", { documentId: "doc-1" }],
    ["recovery_directory", undefined],
    ["take_pending_files", undefined],
  ]);
});

test("document bridge methods propagate invoke rejections unchanged", async () => {
  const error = new Error("invoke failed");
  const tauri = {
    dialog: { open: async () => null, save: async () => null },
    fs: {
      writeFile: async () => {},
    },
    core: {
      invoke: async () => { throw error; },
    },
  };
  const app = makeNativeApp(tauri);

  await assert.rejects(app.readDocument("C:\\notes\\doc.md"), error);
  await assert.rejects(
    app.saveDocument({ path: "C:\\notes\\doc.md", content: "x", expectedSha256: "abc123" }),
    error
  );
  await assert.rejects(app.canonicalizeDocumentPath("C:\\notes\\doc.md"), error);
  await assert.rejects(app.takePendingFiles(), error);
  await assert.rejects(app.loadRecoveryManifest(), error);
  await assert.rejects(app.loadRecoveryDocument("doc-1", 4), error);
  await assert.rejects(app.writeRecoveryDocument("doc-1", 5, "{}"), error);
  await assert.rejects(app.writeRecoveryManifest(6, "{}"), error);
  await assert.rejects(app.deleteRecoveryDocument("doc-1"), error);
  await assert.rejects(app.recoveryDirectory(), error);
});

test("recent history commands serialize and a rejected write does not block later operations", async () => {
  const { tauri } = fakeTauri();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const commands = [];
  tauri.core.invoke = async (command, args) => {
    commands.push([command, args]);
    if (command === "remember_recent_document") { await gate; throw new Error("disk full"); }
    if (command === "list_recent_documents") return [];
  };
  const app = makeNativeApp(tauri);
  assert.equal(typeof app.rememberRecentDocument, "function");
  const write = app.rememberRecentDocument("/notes/a.md");
  const rejected = assert.rejects(write, /disk full/);
  const list = app.listRecentDocuments();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [["remember_recent_document", { path: "/notes/a.md" }]]);
  release();
  await rejected;
  assert.deepEqual(await list, []);
  await app.removeRecentDocument("/notes/a.md");
  await app.clearRecentDocuments();
  assert.deepEqual(commands.slice(1), [
    ["list_recent_documents", undefined],
    ["remove_recent_document", { canonicalPath: "/notes/a.md" }],
    ["clear_recent_documents", undefined],
  ]);
});

test('desktop asset, probe and reveal bridge commands preserve byte arrays and paths', async () => {
  const {tauri,calls}=fakeTauri();const app=makeNativeApp(tauri);
  await app.importDocumentAsset('/a.md','pic.png',new Uint8Array([0,128,255]));
  await app.importDocumentAttachment('/a.md','/pic.png');
  await app.readDocumentAsset('/a.md','assets/pic.png');
  await app.probeDocument('/a.md','hash');await app.revealDocument('/a.md');
  assert.deepEqual(calls.invoke,[
    ['import_document_asset',{documentPath:'/a.md',name:'pic.png',bytes:[0,128,255]}],
    ['import_document_attachment',{documentPath:'/a.md',sourcePath:'/pic.png'}],
    ['read_document_asset',{documentPath:'/a.md',reference:'assets/pic.png'}],
    ['probe_document',{path:'/a.md',expectedSha256:'hash'}],
    ['reveal_document',{path:'/a.md'}],
  ]);
});
