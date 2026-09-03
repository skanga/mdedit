# Tauri v2 Desktop Shell + Native Save Bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Free MD Viewer as a standalone desktop app (Tauri v2) with a small `window.nativeApp` bridge that replaces the Chromium-only File System Access API with native open/save dialogs and file read/write, so Open/Save/Save-As/Export work on every platform.

**Architecture:** The existing app is one self-contained `index.html` built from `src/index.template.html` by `build.sh`. We add (a) a small plain-JS bridge file `src/native-bridge.js` that is inlined by `build.sh` like the vendor libs and defines `window.nativeApp` (null in a plain browser, a 4-method wrapper over `window.__TAURI__` inside the shell), and (b) a `src-tauri/` v2 project that serves `dist-desktop/index.html` with `withGlobalTauri: true` plus the dialog and fs plugins. The app's existing code paths are untouched; each of Open / Save / Save-As / blob-save checks `nativeApp` first and falls back to the current behavior.

**Tech Stack:** Tauri v2 (Rust), `tauri-plugin-dialog`, `tauri-plugin-fs`, `@tauri-apps/cli` (npm), node:test for the bridge unit test. Existing web build: unchanged `build.sh` + python inliner.

**Key facts about the codebase (verified):**
- `src/index.template.html` is the single source (~2155 lines). `build.sh` replaces `/*__MARKED__*/`-style markers with vendored lib contents and writes `index.html` (full) + `index-lite.html`, then copies PWA sidecars to the repo root.
- App state: `let fileHandle = null;` at `src/index.template.html:898` (a `FileSystemFileHandle` when opened via FSA picker/drop).
- Save flow: `save()` (line ~1369) → writes back via `writeToHandle(fileHandle)` if set, else `saveAs()` (line ~1386) → `showSaveFilePicker` if available, else `download()` → `saveBlob()` (anchor download).
- Open flow: `openPicker()` (line ~1343) → `showOpenFilePicker` if available, else hidden `<input type=file>`. `loadContent(text, name, handle)` (line ~1323) is the single entry for "a document is now loaded".
- `saveBlob(blob, name)` (line ~1404) is also used by `exportHtml`, `exportPng`, `downloadDiagramSvg`, `downloadTableCsv` — an anchor download, which is unreliable inside a webview with no browser download manager, so it gets routed through the native save dialog too.
- Vendor libs are inlined in separate `<script>` blocks at lines 881–885; the main app script starts at line 886.
- `tools/make-icons.py` renders the app icon (blue rounded square, white "M↓") at any size with a pure-python PNG encoder — reuse it for Tauri's 1024px icon source.
- Repo has no `package.json` yet; `.gitignore` contains only `.DS_Store`.

**Prerequisites (one-time, dev machine):**
- Rust (stable, via rustup) and Node ≥ 18.
- Linux dev deps for `tauri dev`/`build`: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev` (or `libappindicator3-dev`), `librsvg2-dev`, `patchelf` — the Tauri v2 prerequisites list.
- Windows build needs a Windows machine (or CI); WebView2 runtime is preinstalled on Windows 10/11, no bundling needed.

---

### Task 1: Native bridge module (TDD) + build.sh wiring

**Files:**
- Create: `src/native-bridge.js`
- Create: `tools/test-native-bridge.js`
- Modify: `build.sh` (LIBS dict)
- Modify: `src/index.template.html` (one new `<script>` marker block after line 885)

The bridge is plain JS with a dual export: `window.nativeApp` in the browser, `module.exports` for the node test. `build.sh` inlines it like any other vendored lib, so the desktop app stays a single self-contained HTML file.

- [ ] **Step 1: Write the failing test**

Create `tools/test-native-bridge.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/test-native-bridge.js`
Expected: FAIL — `Cannot find module '../src/native-bridge.js'`

- [ ] **Step 3: Write the bridge**

Create `src/native-bridge.js`:

```js
/* Native file access bridge for the desktop (Tauri) shell.
 *
 * In a plain browser this defines window.nativeApp = null and everything else
 * in the app runs exactly as before. Inside the Tauri shell,
 * app.withGlobalTauri exposes window.__TAURI__ with the dialog and fs plugin
 * APIs, and this file wraps them in the tiny surface the app needs:
 *
 *   nativeApp.pickFile()                      -> path string, null on cancel
 *   nativeApp.readFile(path)                  -> file text (utf-8)
 *   nativeApp.saveAs({ suggestedName, data }) -> chosen path, null on cancel
 *   nativeApp.writeFile(path, data)           -> write to a known path (write-back)
 *
 * data is a string (written as utf-8) or a Uint8Array (raw bytes, for PNG exports).
 */
function makeNativeApp(tauri) {
  if (!tauri || !tauri.dialog || !tauri.fs) return null;
  return {
    async pickFile() {
      const p = await tauri.dialog.open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
      });
      return p || null;
    },
    async readFile(path) {
      return tauri.fs.readTextFile(path);
    },
    async saveAs({ suggestedName, data }) {
      const p = await tauri.dialog.save({
        defaultPath: suggestedName || "untitled.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!p) return null;
      await this.writeFile(p, data);
      return p;
    },
    async writeFile(path, data) {
      if (typeof data === "string") await tauri.fs.writeTextFile(path, data);
      else await tauri.fs.writeFile(path, data);
    },
  };
}

if (typeof window !== "undefined") window.nativeApp = makeNativeApp(window.__TAURI__);
if (typeof module !== "undefined") module.exports = { makeNativeApp };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tools/test-native-bridge.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Wire the bridge into build.sh and the template**

In `build.sh`, add the bridge to the `LIBS` dict (it is not a heavy lib, so it ships in both builds):

```python
LIBS = {
    "/*__MARKED__*/":  "vendor/marked.min.js",
    "/*__PURIFY__*/":  "vendor/purify.min.js",
    "/*__HLJS__*/":    "vendor/highlight.min.js",
    "/*__KATEX__*/":   "vendor/katex.min.js",
    "/*__MERMAID__*/": "vendor/mermaid.min.js",
    "/*__NATIVE_BRIDGE__*/": "src/native-bridge.js",
}
```

In `src/index.template.html`, immediately after the line `<script>/*__MERMAID__*/</script>` (line 885) and before the main app `<script>` at line 886, add:

```html
<script>/*__NATIVE_BRIDGE__*/</script>
```

(The app script must load after the bridge so `window.nativeApp` exists; it is set synchronously at parse time.)

- [ ] **Step 6: Verify the build inlines the bridge and the browser build is unaffected**

Run: `./build.sh`
Expected: both files build; then verify:

Run: `grep -c "makeNativeApp" index.html index-lite.html`
Expected: ≥ 2 in each (definition + the `window.nativeApp = makeNativeApp(...)` call)

Open `index.html` in Chrome; open a `.md` via the picker, edit, Ctrl+S — behavior must be exactly as before (`nativeApp` is null, FSA paths run).

- [ ] **Step 7: Commit**

```bash
git add src/native-bridge.js tools/test-native-bridge.js build.sh src/index.template.html index.html index-lite.html
git commit -m "Add native file bridge (window.nativeApp) for the desktop shell"
```

---

### Task 2: Wire the bridge into the Open path

**Files:**
- Modify: `src/index.template.html` (`fileHandle` declaration ~line 898, `loadContent` ~1323, `openFromFile`/`openPicker` ~1338–1355)

- [ ] **Step 1: Add the `nativePath` state next to `fileHandle`**

Replace:

```js
  let fileHandle = null;     // FileSystemFileHandle when opened via picker/drop (Chromium)
```

with:

```js
  let fileHandle = null;     // FileSystemFileHandle when opened via picker/drop (Chromium)
  let nativePath = null;     // absolute path when opened via the desktop bridge
```

- [ ] **Step 2: Extend `loadContent` with an optional 4th parameter**

Replace the `loadContent` function with:

```js
  function loadContent(text, name, handle, path) {
    editor.value = text.replace(/\r\n/g, "\n");
    filenameEl.value = name || "untitled.md";
    fileHandle = handle || null;
    nativePath = path || null;
    setDirty(false);
    render();
    saveDraft();
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
    previewPane.scrollTop = 0;
    setStatus("Opened " + filenameEl.value + ((fileHandle || nativePath) ? " — Save writes back to the original file" : ""));
  }
```

All existing callers pass three args and are unchanged — `path` defaults to `null`.

- [ ] **Step 3: Add `openFromNativePath` after `openFromFile`**

```js
  async function openFromNativePath(path) {
    try {
      const text = await nativeApp.readFile(path);
      loadContent(text, path.split(/[/\\]/).pop(), null, path);
    } catch (e) {
      setStatus("Couldn't read " + (path || "file"));
    }
  }
```

- [ ] **Step 4: Make `openPicker` try the native dialog first**

Replace `openPicker` with:

```js
  async function openPicker() {
    if (nativeApp) {
      const path = await nativeApp.pickFile();   // null on cancel
      if (path) await openFromNativePath(path);
      return;
    }
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "Markdown", accept: { "text/markdown": [".md", ".markdown", ".mdown", ".mkd"], "text/plain": [".txt"] } }],
          excludeAcceptAllOption: false,
        });
        await openFromFile(await handle.getFile(), handle);
      } catch (e) { /* user cancelled */ }
    } else {
      $("file-input").click();
    }
  }
```

(The drop handler at ~line 1552 is intentionally untouched: in WebView2 — Chromium — `getAsFileSystemHandle` already works, and in WebKit webviews it degrades to a plain `File` exactly like today.)

- [ ] **Step 5: Verify — build, unit test, browser regression**

Run: `node --test tools/test-native-bridge.js && ./build.sh`
Expected: all pass / both builds succeed.

Browser regression: open `index.html` in Chrome and Firefox. Chrome: Open picker shows the FSA dialog and a file picked via the picker gets "— Save writes back to the original file" in the status. Firefox: Open uses the file input fallback. No console errors in either.

- [ ] **Step 6: Commit**

```bash
git add src/index.template.html index.html index-lite.html
git commit -m "Route Open through the native dialog in the desktop shell"
```

---

### Task 3: Wire the bridge into Save / Save As

**Files:**
- Modify: `src/index.template.html` (`save` ~line 1369, `saveAs` ~line 1386)

- [ ] **Step 1: Make `save()` write back to `nativePath` first**

Replace `save` with:

```js
  async function save() {
    if (nativePath) {
      try {
        await nativeApp.writeFile(nativePath, editor.value);
        setDirty(false);
        setStatus("Saved to " + filenameEl.value);
        return;
      } catch (e) {
        setStatus("Couldn't write to the original file — choose where to save it");
      }
    }
    if (fileHandle) {
      try {
        if (fileHandle.queryPermission && (await fileHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
          if ((await fileHandle.requestPermission({ mode: "readwrite" })) !== "granted") throw new Error("denied");
        }
        await writeToHandle(fileHandle);
        setDirty(false);
        setStatus("Saved to " + filenameEl.value);
        return;
      } catch (e) {
        setStatus("Couldn't write to the original file — choose where to save it");
      }
    }
    await saveAs();
  }
```

- [ ] **Step 2: Make `saveAs()` use the native save dialog when in the shell**

Replace `saveAs` with:

```js
  async function saveAs() {
    if (nativeApp) {
      try {
        const path = await nativeApp.saveAs({ suggestedName: filenameEl.value || "untitled.md", data: editor.value });
        if (!path) return;    // user cancelled
        fileHandle = null;
        nativePath = path;    // subsequent Ctrl+S writes back here
        filenameEl.value = path.split(/[/\\]/).pop();
        setDirty(false);
        setStatus("Saved to " + filenameEl.value);
      } catch (e) {
        setStatus("Couldn't save: " + e.message);
      }
      return;
    }
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filenameEl.value || "untitled.md",
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
        });
        await writeToHandle(handle);
        fileHandle = handle;
        filenameEl.value = handle.name;
        setDirty(false);
        setStatus("Saved to " + handle.name);
      } catch (e) { /* user cancelled */ }
    } else {
      download();
    }
  }
```

- [ ] **Step 3: Verify — build, unit test, browser regression**

Run: `node --test tools/test-native-bridge.js && ./build.sh`
Expected: all pass.

Browser regression in Chrome: type in a new document → Ctrl+Shift+S (Save As) → FSA dialog, file is saved, subsequent Ctrl+S writes back to it. Open a file via drop → edit → Ctrl+S writes back. No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.template.html index.html index-lite.html
git commit -m "Route Save/Save As through native dialogs in the desktop shell"
```

---

### Task 4: Route blob saves (download + exports) through the native dialog

**Files:**
- Modify: `src/index.template.html` (`saveBlob` ~line 1404, `download` ~line 1416)

Anchor downloads (`<a download>`) have no reliable behavior inside a webview without a browser download manager, so `saveBlob` — shared by `download()`, `exportHtml`, `exportPng`, `downloadDiagramSvg`, `downloadTableCsv` — goes through the native save dialog in the shell. Export callers are untouched; they already fire `saveBlob` and don't need its result.

- [ ] **Step 1: Make `saveBlob` async and native-aware**

Replace `saveBlob` with:

```js
  async function saveBlob(blob, name) {
    if (nativeApp) {
      try {
        const path = await nativeApp.saveAs({ suggestedName: name, data: new Uint8Array(await blob.arrayBuffer()) });
        if (path) setStatus("Saved " + name);
      } catch (e) {
        setStatus("Couldn't save: " + e.message);
      }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
```

- [ ] **Step 2: Update `download()` for the async `saveBlob`**

Replace `download` with:

```js
  async function download() {
    const name = filenameEl.value || "untitled.md";
    await saveBlob(new Blob([editor.value], { type: "text/markdown;charset=utf-8" }), name);
    if (!nativeApp) setStatus("Downloaded " + name);   // the native path reports "Saved …" itself
    setDirty(false);
  }
```

- [ ] **Step 3: Verify — build, unit test, browser regression**

Run: `node --test tools/test-native-bridge.js && ./build.sh`
Expected: all pass.

Browser regression in Chrome: Export → HTML and PNG both download via the anchor path as before; "Downloaded …" status appears. Code-block and table download buttons work. No console errors (in particular: no unhandled promise rejections).

- [ ] **Step 4: Commit**

```bash
git add src/index.template.html index.html index-lite.html
git commit -m "Route blob saves and exports through the native dialog in the desktop shell"
```

---

### Task 5: Tauri v2 project scaffold

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Create: `tools/build-desktop.sh`
- Create: `package.json` (repo root)
- Modify: `tools/make-icons.py` (add a 1024px render)
- Modify: `.gitignore`

- [ ] **Step 1: Install the CLI and generate icons**

Run: `npm install -D @tauri-apps/cli` (creates `package.json` with the devDependency; then add the root `package.json` content from Step 7 — or create it first, either way the final file is the Step 7 one)

In `tools/make-icons.py`, in the `__main__` block, add a 1024 render next to the existing loop:

```python
if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (192, 512):
        write_png(OUT / f"icon-{size}.png", size, render(size))
    write_png(OUT / "icon-maskable-512.png", 512, render(512, maskable=True))
    write_png(OUT / "icon-1024.png", 1024, render(1024))   # Tauri icon source
```

Run:
```bash
python3 tools/make-icons.py
npx tauri icon pwa/icon-1024.png
```
Expected: `src-tauri/icons/` created with `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, `icon.icns`, `Square*.png` (the `tauri icon` CLI creates `src-tauri/icons` relative to CWD; run it from the repo root).

- [ ] **Step 2: Rust manifest and entry points**

Create `src-tauri/Cargo.toml`:

```toml
[package]
name = "free-md-viewer"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"

[lib]
name = "free_md_viewer_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

Create `src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

Create `src-tauri/src/main.rs`:

```rust
// Prevents an extra console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    free_md_viewer_lib::run()
}
```

Create `src-tauri/src/lib.rs`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Tauri config**

Create `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Free MD Viewer",
  "version": "0.1.0",
  "identifier": "com.kingsbridge.freedmdviewer",
  "build": {
    "frontendDist": "../dist-desktop"
  },
  "app": {
    "windows": [
      {
        "title": "Free MD Viewer",
        "width": 1280,
        "height": 840,
        "minWidth": 700,
        "minHeight": 480,
        "center": true
      }
    ],
    "withGlobalTauri": true,
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico",
      "icons/icon.icns"
    ]
  }
}
```

Notes: no `build.devUrl` — `tauri dev` serves `frontendDist` directly (rebuild the web assets first, no HMR). `withGlobalTauri` is what gives the bridge `window.__TAURI__` without any frontend bundler. `csp: null` keeps the inline scripts/data-URI fonts working.

- [ ] **Step 4: Capabilities (plugin permissions)**

Create `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window: native file dialogs and full-disk read/write for documents",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    { "identifier": "fs:allow-read-text-file", "allow": [{ "path": "**" }] },
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "**" }] },
    { "identifier": "fs:allow-write-file", "allow": [{ "path": "**" }] }
  ]
}
```

- [ ] **Step 5: Desktop staging script**

Create `tools/build-desktop.sh`:

```bash
#!/usr/bin/env bash
# Stages the full web build for the Tauri shell. The shell ships the FULL
# build (Mermaid + KaTeX always available); the lite build stays web-only.
set -euo pipefail
cd "$(dirname "$0")/.."
./build.sh
rm -rf dist-desktop
mkdir -p dist-desktop
cp index.html dist-desktop/index.html
echo "staged dist-desktop/index.html"
```

Run: `chmod +x tools/build-desktop.sh && ./tools/build-desktop.sh`
Expected: `dist-desktop/index.html` exists and is ~3.6 MB.

- [ ] **Step 6: Root package.json and .gitignore**

Create root `package.json`:

```json
{
  "name": "free-md-viewer",
  "private": true,
  "scripts": {
    "build:web": "./build.sh",
    "build:desktop": "./tools/build-desktop.sh",
    "tauri": "tauri",
    "test": "node --test tools/test-native-bridge.js"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

(If Step 1's `npm install -D` already created a package.json, merge into this shape and keep the installed `@tauri-apps/cli` version.)

Append to `.gitignore`:

```
dist-desktop/
src-tauri/target/
src-tauri/gen/schemas/
```

- [ ] **Step 7: Verify the Rust side compiles**

Run: `cd src-tauri && cargo check && cd ..`
Expected: compiles with no errors (first run downloads crates; may take a few minutes).

- [ ] **Step 8: Commit**

```bash
git add src-tauri package.json package-lock.json tools/build-desktop.sh tools/make-icons.py pwa/icon-1024.png .gitignore
git commit -m "Add Tauri v2 shell scaffold (dialogs + fs plugins, global Tauri API)"
```

---

### Task 6: End-to-end desktop verification

**Files:** none (verification only; fix bugs found and commit them)

- [ ] **Step 1: Run the app in the shell**

Run: `npm run build:desktop && npm run tauri dev`
Expected: a "Free MD Viewer" window opens showing the app.

- [ ] **Step 2: Run the desktop feature checklist**

In the dev window (create test files under `~/md-test/` first, e.g. `a.md`, `b.md`):

1. **Open** — toolbar Open → native OS file dialog appears → pick `a.md` → renders, status says "— Save writes back to the original file".
2. **Save write-back** — type a line, Ctrl+S → status "Saved to a.md" → verify on disk: `grep <your line> ~/md-test/a.md`.
3. **Save As** — Ctrl+Shift+S → native save dialog, suggested name from filename → save as `c.md` → status updates, filename shows `c.md` → edit again, Ctrl+S writes to `c.md` (not `a.md`).
4. **Cancel paths** — Open → cancel (nothing happens, no error); Save As → cancel (document unchanged, still dirty).
5. **Export** — Export → HTML: native save dialog, choose a name, verify the saved `.html` opens standalone in a browser. Export → PNG: same, verify the image is valid.
6. **Download button** — with an untitled doc, the download path (Export menu → Download) uses the native save dialog, not a broken anchor.
7. **Regression: console clean** — devtools (right-click → Inspect works in `tauri dev`) shows no errors/warnings in the console at any point.

If any step fails: fix in `src/index.template.html` (re-run `npm run build:desktop`) or in `src-tauri/` (permissions in `capabilities/default.json` are the usual culprit — e.g. an unhandled `forbidden path` error means a missing fs permission), re-verify, and commit:

```bash
git add -A
git commit -m "Fix desktop verification issue: <what>"
```

- [ ] **Step 3: Build a release bundle**

Run: `npm run tauri build`
Expected: on Linux, an AppImage and/or .deb in `src-tauri/target/release/bundle/` (install AppImage tooling if the AppImage target errors — `deb` alone is fine, disable others in `bundle.targets`). Run the produced AppImage once and repeat checklist steps 2–3. The Windows installer is produced the same way on a Windows machine or CI (Task 8); on Windows expect `src-tauri/target/release/bundle/nsis/*.exe`.

- [ ] **Step 4: Commit any fixes**

```bash
git status --short   # nothing should be uncommitted after fixes
```

---

### Task 7 (optional): Open `.md` files handed to the app by the OS

File associations + `freemdviewer some.md` on the command line. Requires the release bundles from Task 6 to actually be installed; do this last and test on a real machine.

**Files:**
- Modify: `src-tauri/tauri.conf.json` (bundle.fileAssociations)
- Modify: `src-tauri/src/lib.rs` (RunEvent::Opened handler)
- Modify: `src/index.template.html` (listen for the event)

- [ ] **Step 1: Declare the association**

In `src-tauri/tauri.conf.json`, inside `"bundle"`, add:

```json
    "fileAssociations": [
      { "ext": ["md", "markdown", "mdown", "mkd"], "name": "Markdown", "description": "Markdown document", "role": "Editor" }
    ]
```

- [ ] **Step 2: Forward opened paths to the webview**

Replace `run()` in `src-tauri/src/lib.rs` with:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(
            tauri::generate_context!(),
            |app_handle, event| {
                if let tauri::RunEvent::Opened(paths) = event {
                    for p in paths {
                        let _ = app_handle.emit("file-opened", p.to_string_lossy().to_string());
                    }
                }
            },
        )
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Listen in the app**

In `src/index.template.html`, immediately after the `drop` handler block (after the `});` closing `window.addEventListener("drop", ...)` ~line 1568), add:

```js
  // The desktop shell forwards files handed to it by the OS (association / CLI arg).
  if (nativeApp && window.__TAURI__.event) {
    window.__TAURI__.event.listen("file-opened", (e) => openFromNativePath(e.payload));
  }
```

- [ ] **Step 4: Verify**

Run: `cargo check` (in `src-tauri`), `npm run build:desktop && npm run tauri dev`
Expected: `freemdviewer-dev ~/md-test/a.md` (or the installed app binary with a path) opens the window with `a.md` loaded. On Windows/macOS after installing a release bundle: double-click a `.md` file opens it in the app.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/lib.rs src/index.template.html index.html index-lite.html
git commit -m "Open .md files passed by the OS or command line"
```

---

### Task 8 (optional): Multi-platform CI + README

**Files:**
- Create: `.github/workflows/desktop.yml`
- Modify: `README.md` (new "Desktop app" section)

- [ ] **Step 1: CI workflow**

Create `.github/workflows/desktop.yml`:

```yaml
name: Desktop
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            args: ""
          - os: ubuntu-latest
            args: "--bundles deb"
          - os: macos-latest
            args: ""
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Install deps
        run: npm install
      - name: Linux system deps
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - name: Build
        run: |
          npm run build:desktop
          npx tauri build ${{ matrix.args }}
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.os }}
          path: src-tauri/target/release/bundle/**
```

- [ ] **Step 2: README section**

In `README.md`, after the Features section, add:

```markdown
## Desktop app

The same single-file app ships as a native desktop app via [Tauri](https://tauri.app)
(`src-tauri/`), with native open/save dialogs and write-back on Windows, macOS and
Linux. The web build is unchanged — in a plain browser `window.nativeApp` is null and
all the original code paths run.

```bash
npm install            # one-time (adds @tauri-apps/cli)
npm run build:desktop  # builds the web app and stages dist-desktop/
npm run tauri dev      # run it
npm run tauri build    # installers: NSIS on Windows, dmg on macOS, AppImage/deb on Linux
```
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run build:web`
Expected: bridge tests pass, web build succeeds. Push a tag to trigger CI (or just review the workflow) — full matrix runs are optional at plan-execution time.

```bash
git add .github/workflows/desktop.yml README.md
git commit -m "Add desktop CI matrix and README section"
```

---

## Self-review notes

- **Spec coverage:** Tauri v2 wrapper ✓ (Tasks 5–6), small `window.app`-style native bridge for the native save dialog ✓ (Tasks 1–4, named `window.nativeApp` to avoid clashing with `window.app`-free code; surface is the minimal 4 methods). Open write-back ✓ (Tasks 2, 3), exports ✓ (Task 4), cross-platform packaging ✓ (Tasks 6, 8). Optional extras: file association (Task 7), CI (Task 8).
- **Name consistency:** bridge methods `pickFile / readFile / saveAs({suggestedName, data}) / writeFile(path, data)` used identically in `src/native-bridge.js`, its test, and all template call sites; template state `nativePath` declared once (Task 2) and used in Tasks 2–4; `openFromNativePath` defined in Task 2 and reused in Task 7.
- **Known limitations (accepted):** in WebKit-based webviews (macOS/Linux), drag-&-drop from the OS yields a plain `File` with no write-back (same as today's browser fallback); the FSA write-back path remains the fast path on WebView2/Windows where it also works.
