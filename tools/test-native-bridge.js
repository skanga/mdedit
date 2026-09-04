const test = require("node:test");
const assert = require("node:assert");
const { makeNativeApp } = require("../src/native-bridge.js");

function fakeTauri() {
  const calls = { open: null, save: null, read: null, writeFile: [] };
  const tauri = {
    dialog: {
      open: async (opts) => { calls.open = opts; return "C:\\notes\\doc.md"; },
      save: async (opts) => { calls.save = opts; return "C:\\notes\\out.md"; },
    },
    fs: {
      readTextFile: async (p) => { calls.read = p; return "# hello\n"; },
      writeTextFile: async (p, d) => { calls.writeFile.push(["text", p, d]); },
      writeFile: async (p, d) => { calls.writeFile.push(["bytes", p, d]); },
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
});

test("pickFile resolves the chosen path and null on cancel", async () => {
  const { tauri } = fakeTauri();
  const app = makeNativeApp(tauri);
  assert.equal(await app.pickFile(), "C:\\notes\\doc.md");
  tauri.dialog.open = async () => null;
  assert.equal(await app.pickFile(), null);
});

test("readFile returns utf-8 text via readTextFile", async () => {
  const { tauri, calls } = fakeTauri();
  assert.equal(await makeNativeApp(tauri).readFile("C:\\notes\\doc.md"), "# hello\n");
  assert.equal(calls.read, "C:\\notes\\doc.md");
});

test("saveAs writes text to the chosen path and returns it", async () => {
  const { tauri, calls } = fakeTauri();
  const p = await makeNativeApp(tauri).saveAs({ suggestedName: "doc.md", data: "x" });
  assert.equal(p, "C:\\notes\\out.md");
  assert.deepEqual(calls.writeFile, [["text", "C:\\notes\\out.md", "x"]]);
});

test("saveAs anchors the dialog in defaultDir when given", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);
  await app.saveAs({ defaultDir: "C:\\notes", suggestedName: "c.md", data: "x" });
  assert.equal(calls.save.defaultPath, "C:\\notes/c.md");
  await app.saveAs({ defaultDir: "/home/u/docs/", suggestedName: "c.md", data: "x" });
  assert.equal(calls.save.defaultPath, "/home/u/docs/c.md");
});

test("saveAs falls back to the bare name without a defaultDir", async () => {
  const { tauri, calls } = fakeTauri();
  await makeNativeApp(tauri).saveAs({ suggestedName: "c.md", data: "x" });
  assert.equal(calls.save.defaultPath, "c.md");
});

test("saveAs writes raw bytes with writeFile when data is not a string", async () => {
  const { tauri, calls } = fakeTauri();
  const bytes = new Uint8Array([1, 2, 3]);
  const p = await makeNativeApp(tauri).saveAs({ suggestedName: "x.png", data: bytes });
  assert.equal(p, "C:\\notes\\out.md");
  assert.deepEqual(calls.writeFile, [["bytes", "C:\\notes\\out.md", bytes]]);
});

test("saveAs returns null without writing on cancel", async () => {
  const { tauri, calls } = fakeTauri();
  tauri.dialog.save = async () => null;
  assert.equal(await makeNativeApp(tauri).saveAs({ suggestedName: "d.md", data: "x" }), null);
  assert.deepEqual(calls.writeFile, []);
});

test("writeFile writes directly to a known path (write-back)", async () => {
  const { tauri, calls } = fakeTauri();
  await makeNativeApp(tauri).writeFile("C:\\notes\\doc.md", "edited");
  assert.deepEqual(calls.writeFile, [["text", "C:\\notes\\doc.md", "edited"]]);
});
