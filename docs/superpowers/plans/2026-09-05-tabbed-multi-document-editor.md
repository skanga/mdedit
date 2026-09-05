# Tabbed Multi-Document Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tabbed multi-document workspace that restores all document and view state safely across quits, restarts, and crashes.

**Architecture:** Pure JavaScript document and session models drive the existing webview UI. A controller coordinates file, tab, recovery, conflict, and quit workflows through an injected native bridge. Rust commands provide canonical file identity, guarded document writes, and atomic per-document recovery files in Tauri's application-data directory.

**Tech Stack:** Vanilla JavaScript, Node `node:test`, HTML/CSS, Tauri 2, Rust 2021, Serde, SHA-256, and Playwright for browser interaction and performance tests.

---

## Source map

Create these files:

- `src/document-model.js` — one document's durable and transient state.
- `src/session-model.js` — tab ordering, active document, and session invariants.
- `src/recovery-scheduler.js` — coalesced idle and maximum-interval checkpoints.
- `src/session-controller.js` — open, save, close, quit, restore, and conflict workflows.
- `src/workspace-view.js` — tab DOM, per-document textareas, dialogs, and focus.
- `src-tauri/src/recovery.rs` — atomic app-data recovery storage.
- `src-tauri/src/document_io.rs` — canonical reads and guarded writes.
- `tools/test-document-model.js` — document-model unit tests.
- `tools/test-session-model.js` — session-model unit tests.
- `tools/test-recovery-scheduler.js` — scheduler unit tests.
- `tools/test-session-controller.js` — controller workflow tests.
- `tools/test-workspace-view.js` — DOM-adapter unit tests.
- `tests/browser/tabs.spec.js` — browser interaction and accessibility tests.
- `tests/browser/performance.spec.js` — explicit large-session performance test.
- `playwright.config.js` — generated-frontend browser test configuration.
- `docs/testing/tabbed-editor-smoke-checklist.md` — desktop platform checks.

Modify these files:

- `src/index.template.html:1-2219` — tab strip, dialogs, workspace binding, active-document routing, and startup.
- `src/native-bridge.js:1-50` — multi-file dialogs and Tauri command wrappers.
- `build.sh:37-53` — inline new frontend modules in dependency order.
- `tools/test-native-bridge.js:1-86` — bridge contract tests.
- `tools/test-project-identity.js` — generated-output and UI-structure assertions.
- `package.json:4-9` and `package-lock.json` — test scripts and Playwright dependency.
- `src-tauri/Cargo.toml:9-13` and `src-tauri/Cargo.lock` — serialization, hashing, UUID, and temporary-directory test dependencies.
- `src-tauri/src/lib.rs:1-67` — modules, managed recovery store, commands, and launch routing.
- `src-tauri/capabilities/default.json` — permissions required by the final bridge only.
- `.github/workflows/desktop.yml` — execute the expanded unit and Rust suites in the existing matrix.
- `index.html` and `index-lite.html` — tracked regenerated artifacts. `dist-desktop/index.html` is rebuilt for verification but remains ignored.

## Task 1: Extract the document model

**Files:**

- Create: `src/document-model.js`
- Create: `tools/test-document-model.js`
- Modify: `package.json:4-9`

- [ ] **Step 1: Write failing document-model tests**

```js
// tools/test-document-model.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { DocumentModel, emptyWorkspace } = require("../src/document-model.js");

const EMPTY_SHA = "empty-sha";

test("a blank untitled document starts clean", () => {
  const doc = new DocumentModel({
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "Untitled 1",
    content: "",
    savedContentSha256: EMPTY_SHA,
  });
  assert.equal(doc.dirty, false);
  assert.deepEqual(doc.workspace, emptyWorkspace());
});

test("editing advances the revision and becomes tentatively dirty", () => {
  const doc = new DocumentModel({ id: "doc-1", displayName: "a.md", content: "a", savedContentSha256: "sha-a" });
  doc.applyContent("ab");
  assert.equal(doc.editRevision, 1);
  assert.equal(doc.content, "ab");
  assert.equal(doc.dirty, true);
  assert.equal(doc.recoveryStatus, "pending");
});

test("fingerprint reconciliation recognizes undo back to saved content", () => {
  const doc = new DocumentModel({ id: "doc-1", displayName: "a.md", content: "a", savedContentSha256: "sha-a" });
  doc.applyContent("ab");
  doc.applyContent("a");
  doc.reconcileDirty("sha-a", doc.editRevision);
  assert.equal(doc.dirty, false);
});

test("an old save completion cannot clear a newer edit", () => {
  const doc = new DocumentModel({ id: "doc-1", displayName: "a.md", content: "a", savedContentSha256: "sha-a" });
  doc.applyContent("first");
  const savedRevision = doc.editRevision;
  doc.applyContent("second");
  doc.recordSave({ editRevision: savedRevision, contentSha256: "sha-first", diskSha256: "disk-first" });
  assert.equal(doc.dirty, true);
  assert.equal(doc.savedContentSha256, "sha-first");
});

test("snapshot validation clamps selection and rejects malformed data", () => {
  const doc = DocumentModel.fromSnapshot({
    schemaVersion: 1,
    documentId: "doc-1",
    snapshotRevision: 2,
    editRevision: 3,
    displayName: "a.md",
    path: null,
    canonicalPath: null,
    content: "abc",
    savedContentSha256: "sha-abc",
    expectedDiskSha256: null,
    fileStatus: "normal",
    workspace: { ...emptyWorkspace(), selectionStart: 99, selectionEnd: 100 },
  });
  assert.equal(doc.workspace.selectionStart, 3);
  assert.equal(doc.workspace.selectionEnd, 3);
  assert.throws(() => DocumentModel.fromSnapshot({ schemaVersion: 2 }), /schema version/i);
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `node --test tools/test-document-model.js`

Expected: FAIL with `Cannot find module '../src/document-model.js'`.

- [ ] **Step 3: Implement the document model**

Use one browser/CommonJS wrapper and export `DocumentModel`, `emptyWorkspace`, and `SNAPSHOT_SCHEMA_VERSION`:

```js
// src/document-model.js
(function initDocumentModel(root, factory) {
  const api = factory();
  if (typeof module !== "undefined") module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";
  const SNAPSHOT_SCHEMA_VERSION = 1;
  const FILE_STATUSES = new Set(["normal", "externally-changed", "missing", "read-error"]);

  function emptyWorkspace() {
    return {
      selectionStart: 0, selectionEnd: 0, editorScrollTop: 0, previewScrollTop: 0,
      viewMode: "split", tocOpen: false,
      find: { open: false, query: "", replacement: "", matchIndex: -1 },
    };
  }

  function clampInteger(value, low, high) {
    return Math.max(low, Math.min(high, Number.isInteger(value) ? value : low));
  }

  class DocumentModel {
    constructor(input) {
      if (!input || typeof input.id !== "string" || typeof input.displayName !== "string") {
        throw new TypeError("document id and display name are required");
      }
      this.id = input.id;
      this.displayName = input.displayName;
      this.path = input.path || null;
      this.canonicalPath = input.canonicalPath || null;
      this.content = typeof input.content === "string" ? input.content : "";
      this.editRevision = Number.isInteger(input.editRevision) ? input.editRevision : 0;
      this.persistedRevision = Number.isInteger(input.persistedRevision) ? input.persistedRevision : -1;
      this.snapshotRevision = Number.isInteger(input.snapshotRevision) ? input.snapshotRevision : 0;
      this.savedContentSha256 = input.savedContentSha256;
      this.expectedDiskSha256 = input.expectedDiskSha256 || null;
      this.dirty = Boolean(input.dirty);
      this.fileStatus = FILE_STATUSES.has(input.fileStatus) ? input.fileStatus : "normal";
      this.workspace = Object.assign(emptyWorkspace(), input.workspace || {});
      this.recoveryStatus = input.recoveryStatus || "clean";
    }

    applyContent(content) {
      if (content === this.content) return false;
      this.content = content;
      this.editRevision += 1;
      this.dirty = true;
      this.recoveryStatus = "pending";
      return true;
    }

    reconcileDirty(contentSha256, editRevision) {
      if (editRevision !== this.editRevision) return false;
      this.dirty = contentSha256 !== this.savedContentSha256;
      return true;
    }

    recordSave(result) {
      this.savedContentSha256 = result.contentSha256;
      this.expectedDiskSha256 = result.diskSha256;
      this.fileStatus = "normal";
      this.dirty = this.editRevision !== result.editRevision;
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
      if (!value || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error("unsupported snapshot schema version");
      if (typeof value.content !== "string" || typeof value.documentId !== "string") throw new Error("invalid document snapshot");
      const workspace = Object.assign(emptyWorkspace(), value.workspace || {});
      workspace.selectionStart = clampInteger(workspace.selectionStart, 0, value.content.length);
      workspace.selectionEnd = clampInteger(workspace.selectionEnd, workspace.selectionStart, value.content.length);
      return new DocumentModel({ ...value, id: value.documentId, workspace, persistedRevision: value.editRevision });
    }
  }

  return { DocumentModel, emptyWorkspace, SNAPSHOT_SCHEMA_VERSION };
});
```

Add `tools/test-document-model.js` to the existing `npm test` command.

- [ ] **Step 4: Run the document and existing JavaScript tests**

Run: `node --test tools/test-document-model.js tools/test-native-bridge.js tools/test-project-identity.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the document model**

```bash
git add src/document-model.js tools/test-document-model.js package.json
git commit -m "Add multi-document state model"
```

## Task 2: Add session invariants and tab operations

**Files:**

- Create: `src/session-model.js`
- Create: `tools/test-session-model.js`
- Modify: `package.json:4-9`

- [ ] **Step 1: Write failing session-model tests**

```js
// tools/test-session-model.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionModel } = require("../src/session-model.js");

const makeDoc = (id, name, canonicalPath = null) => ({ id, displayName: name, canonicalPath });

test("new untitled documents have stable unique names", () => {
  const session = new SessionModel({ idFactory: (() => { let n = 0; return () => `doc-${++n}`; })() });
  assert.equal(session.createUntitled().displayName, "Untitled 1");
  assert.equal(session.createUntitled().displayName, "Untitled 2");
  assert.deepEqual(session.tabOrder, ["doc-1", "doc-2"]);
  assert.equal(session.activeDocumentId, "doc-2");
});

test("canonical paths cannot be owned by two tabs", () => {
  const session = new SessionModel();
  session.add(makeDoc("a", "a.md", "/docs/a.md"));
  assert.throws(() => session.add(makeDoc("b", "copy.md", "/docs/a.md")), /already open/i);
  assert.equal(session.findByCanonicalPath("/docs/a.md").id, "a");
});

test("closing the active tab selects its right neighbor, then its left", () => {
  const session = new SessionModel();
  session.add(makeDoc("a", "a.md"));
  session.add(makeDoc("b", "b.md"));
  session.add(makeDoc("c", "c.md"));
  session.activate("b");
  assert.equal(session.remove("b").nextActiveId, "c");
  assert.equal(session.remove("c").nextActiveId, "a");
});

test("reorder and keyboard move preserve the active tab", () => {
  const session = new SessionModel();
  for (const id of ["a", "b", "c"]) session.add(makeDoc(id, `${id}.md`));
  session.activate("b");
  session.move("b", -1);
  assert.deepEqual(session.tabOrder, ["b", "a", "c"]);
  assert.equal(session.activeDocumentId, "b");
});

test("manifest round-trip validates every referenced document", () => {
  const session = SessionModel.fromManifest({
    schemaVersion: 1, generation: 7, activeDocumentId: "a", nextUntitledNumber: 3,
    tabs: [{ documentId: "a", displayName: "a.md", snapshotRevision: 2 }],
  });
  assert.equal(session.toManifest().generation, 7);
  assert.throws(() => SessionModel.fromManifest({ schemaVersion: 1, tabs: [], activeDocumentId: "missing" }), /manifest/i);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tools/test-session-model.js`

Expected: FAIL with `Cannot find module '../src/session-model.js'`.

- [ ] **Step 3: Implement `SessionModel`**

Implement `add`, `createUntitled`, `activate`, `remove`, `move`, `findByCanonicalPath`, `toManifest`, and `fromManifest`. Every structural mutation increments `generation`. `move(id, delta)` clamps the destination to the tab range. `remove` returns `{ removed, nextActiveId }` and may temporarily leave an empty internal model so the controller can create the replacement untitled document in the same user operation.

Use `crypto.randomUUID()` in the browser and Node's `randomUUID()` in tests through the injected `idFactory`. Use manifest schema version `1`. Validate unique IDs, unique non-null canonical paths, a valid active ID, non-negative integer revisions, and `nextUntitledNumber >= 1`.

```js
class SessionModel {
  constructor({ idFactory = null } = {}) {
    this.documents = new Map();
    this.tabOrder = [];
    this.activeDocumentId = null;
    this.nextUntitledNumber = 1;
    this.generation = 0;
    this.idFactory = idFactory || (() => crypto.randomUUID());
  }

  move(id, delta) {
    const from = this.tabOrder.indexOf(id);
    if (from < 0) throw new Error(`unknown document: ${id}`);
    const to = Math.max(0, Math.min(this.tabOrder.length - 1, from + delta));
    if (to === from) return false;
    this.tabOrder.splice(from, 1);
    this.tabOrder.splice(to, 0, id);
    this.generation += 1;
    return true;
  }
}
```

- [ ] **Step 4: Run session and document tests**

Run: `node --test tools/test-document-model.js tools/test-session-model.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the session model**

```bash
git add src/session-model.js tools/test-session-model.js package.json
git commit -m "Add tab session model"
```

## Task 3: Implement atomic recovery storage in Rust

**Files:**

- Create: `src-tauri/src/recovery.rs`
- Modify: `src-tauri/src/lib.rs:1-48`
- Modify: `src-tauri/Cargo.toml:9-15`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: Add dependencies and failing recovery tests**

Add these dependencies:

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-single-instance = "2"
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"
```

At the bottom of `src-tauri/src/recovery.rs`, add tests for these cases:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_document_ids_that_can_escape_the_store() {
        assert!(validate_document_id("../../outside").is_err());
        assert!(validate_document_id("not-a-uuid").is_err());
        assert!(validate_document_id("11111111-1111-4111-8111-111111111111").is_ok());
    }

    #[test]
    fn rotates_current_data_and_loads_the_latest_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().to_path_buf());
        let id = "11111111-1111-4111-8111-111111111111";
        store.write_document(id, 1, br#"{"snapshotRevision":1}"#).unwrap();
        store.write_document(id, 2, br#"{"snapshotRevision":2}"#).unwrap();
        assert_eq!(store.load_document(id, 2).unwrap(), br#"{"snapshotRevision":2}"#);
        assert!(store.document_previous_path(id).is_file());
    }

    #[test]
    fn falls_back_to_previous_when_current_json_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().to_path_buf());
        let id = "11111111-1111-4111-8111-111111111111";
        store.write_document(id, 1, br#"{"snapshotRevision":1}"#).unwrap();
        store.write_document(id, 2, br#"{"snapshotRevision":2}"#).unwrap();
        std::fs::write(store.document_path(id), b"{").unwrap();
        assert_eq!(store.load_document(id, 1).unwrap(), br#"{"snapshotRevision":1}"#);
    }

    #[test]
    fn manifest_rotation_preserves_a_valid_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(dir.path().to_path_buf());
        store.write_manifest(1, br#"{"generation":1}"#).unwrap();
        store.write_manifest(2, br#"{"generation":2}"#).unwrap();
        assert_eq!(store.load_manifest().unwrap(), br#"{"generation":2}"#);
    }
}
```

- [ ] **Step 2: Run the focused Rust test and verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml recovery::tests -- --nocapture`

Expected: FAIL because `src-tauri/src/recovery.rs` and its types are not defined.

- [ ] **Step 3: Implement recovery storage**

Implement:

```rust
pub struct RecoveryStore { root: PathBuf }

impl RecoveryStore {
    pub fn new(root: PathBuf) -> Self;
    pub fn load_manifest(&self) -> Result<Vec<u8>, String>;
    pub fn write_manifest(&self, generation: u64, bytes: &[u8]) -> Result<(), String>;
    pub fn load_document(&self, id: &str, revision: u64) -> Result<Vec<u8>, String>;
    pub fn write_document(&self, id: &str, revision: u64, bytes: &[u8]) -> Result<(), String>;
    pub fn delete_document(&self, id: &str) -> Result<(), String>;
    pub fn root(&self) -> &Path;
}
```

`validate_document_id` must parse a UUID and require its canonical hyphenated lowercase representation. `atomic_rotate_write` must create the directory, write a UUID-suffixed temporary file with `create_new(true)`, call `sync_all`, replace the previous file with the current file, rename temporary to current, and attempt a directory sync on Unix. Loaders parse JSON and verify the requested `generation` or `snapshotRevision`; they try current first and previous second.

Expose commands that accept JSON strings and return JSON strings. Construct the store during Tauri setup from `app.path().app_data_dir()?.join("session-v1")`, manage it as `tauri::State<RecoveryStore>`, and register the commands in `generate_handler!`.

- [ ] **Step 4: Run Rust tests and formatting**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0.

Run: `cargo test --manifest-path src-tauri/Cargo.toml recovery::tests`

Expected: 4 tests PASS.

- [ ] **Step 5: Commit recovery storage**

```bash
git add src-tauri/src/recovery.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Add atomic session recovery storage"
```

## Task 4: Add conflict-aware native document I/O

**Files:**

- Create: `src-tauri/src/document_io.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing document-I/O tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_returns_content_identity_and_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, b"a\r\nb\n").unwrap();
        let result = read_document_path(&path).unwrap();
        assert_eq!(result.content, "a\r\nb\n");
        assert_eq!(result.size, 5);
        assert_eq!(result.canonical_path, canonical_comparison_path(&path).unwrap());
    }

    #[test]
    fn guarded_save_rejects_an_external_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, b"first").unwrap();
        let expected = sha256_hex(b"first");
        std::fs::write(&path, b"external").unwrap();
        let result = save_document_path(&path, Some(&expected), b"editor").unwrap();
        assert!(matches!(result, SaveDocumentResult::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
    }

    #[test]
    fn guarded_save_replaces_an_unchanged_file_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, b"first").unwrap();
        let expected = sha256_hex(b"first");
        let result = save_document_path(&path, Some(&expected), b"editor").unwrap();
        assert!(matches!(result, SaveDocumentResult::Saved { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"editor");
    }

    #[test]
    fn a_missing_expected_file_is_reported_without_recreation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.md");
        let result = save_document_path(&path, Some("old-sha"), b"editor").unwrap();
        assert!(matches!(result, SaveDocumentResult::Missing));
        assert!(!path.exists());
    }

    #[test]
    fn an_existing_file_requires_an_expected_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.md");
        std::fs::write(&path, b"existing").unwrap();
        let result = save_document_path(&path, None, b"editor").unwrap();
        assert!(matches!(result, SaveDocumentResult::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
    }
}
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml document_io::tests -- --nocapture`

Expected: FAIL because the document I/O functions are not defined.

- [ ] **Step 3: Implement the document I/O types and commands**

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentResult {
    pub path: String,
    pub canonical_path: String,
    pub content: String,
    pub sha256: String,
    pub size: u64,
    pub modified_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum SaveDocumentResult {
    Saved { canonical_path: String, sha256: String, size: u64, modified_ms: Option<u128> },
    Conflict { actual_sha256: String, size: u64, modified_ms: Option<u128> },
    Missing,
}
```

Use `sha2::Sha256`. `read_document_path` must reject invalid UTF-8 with the affected path in the error. `canonical_comparison_path` canonicalizes existing paths; for a new Save As path, canonicalize the parent and append the filename. Apply consistent Windows case folding behind `#[cfg(windows)]`.

`save_document_path` must fingerprint an existing destination immediately before replacement. When `expected_sha256` is `Some`, return `Conflict` or `Missing` instead of writing on a mismatch. When `expected_sha256` is `None`, create a missing destination but return `Conflict` for an existing destination. Write through a UUID-named temporary file in the same directory, preserve existing permissions, call `sync_all`, and rename into place.

Register `read_document`, `save_document`, and `canonicalize_document_path` Tauri commands.

- [ ] **Step 4: Run Rust verification**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

- [ ] **Step 5: Commit native document I/O**

```bash
git add src-tauri/src/document_io.rs src-tauri/src/lib.rs
git commit -m "Guard document writes against external changes"
```

## Task 5: Expand and test the native bridge

**Files:**

- Modify: `src/native-bridge.js:1-50`
- Modify: `tools/test-native-bridge.js:1-86`

- [ ] **Step 1: Add failing bridge contract tests**

Extend `fakeTauri()` with `core.invoke` call recording. Add:

```js
test("pickFiles normalizes one, many, and canceled selections", async () => {
  const { tauri } = fakeTauri();
  const app = makeNativeApp(tauri);
  tauri.dialog.open = async () => "C:\\notes\\a.md";
  assert.deepEqual(await app.pickFiles(), ["C:\\notes\\a.md"]);
  tauri.dialog.open = async () => ["a.md", "b.md"];
  assert.deepEqual(await app.pickFiles(), ["a.md", "b.md"]);
  tauri.dialog.open = async () => null;
  assert.deepEqual(await app.pickFiles(), []);
});

test("document and recovery methods invoke the matching Rust commands", async () => {
  const { tauri, calls } = fakeTauri();
  const app = makeNativeApp(tauri);
  await app.readDocument("a.md");
  await app.saveDocument({ path: "a.md", expectedSha256: "old", content: "new" });
  await app.writeRecoveryDocument("doc-id", 4, "{}");
  await app.writeRecoveryManifest(8, "{}");
  assert.deepEqual(calls.invoke.map((entry) => entry[0]), [
    "read_document", "save_document", "write_recovery_document", "write_recovery_manifest",
  ]);
});

test("chooseSavePath does not write before the controller checks ownership", async () => {
  const { tauri, calls } = fakeTauri();
  const path = await makeNativeApp(tauri).chooseSavePath({ defaultDir: "C:\\notes", suggestedName: "a.md" });
  assert.equal(path, "C:\\notes\\out.md");
  assert.deepEqual(calls.writeFile, []);
});
```

- [ ] **Step 2: Run the bridge tests and verify failure**

Run: `node --test tools/test-native-bridge.js`

Expected: FAIL because `pickFiles`, `readDocument`, and recovery methods do not exist.

- [ ] **Step 3: Implement the bridge contract**

Require `tauri.dialog`, `tauri.fs`, and `tauri.core`. Change the picker to `multiple: true`. Keep `saveAs` and `writeFile` for exports, but route document operations through `core.invoke`:

```js
async pickFiles() {
  const value = await tauri.dialog.open({
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
  });
  return value == null ? [] : Array.isArray(value) ? value : [value];
},
async readDocument(path) { return tauri.core.invoke("read_document", { path }); },
async saveDocument(input) { return tauri.core.invoke("save_document", input); },
async canonicalizeDocumentPath(path) { return tauri.core.invoke("canonicalize_document_path", { path }); },
async loadRecoveryManifest() { return tauri.core.invoke("load_recovery_manifest"); },
async loadRecoveryDocument(documentId, snapshotRevision) {
  return tauri.core.invoke("load_recovery_document", { documentId, snapshotRevision });
},
async writeRecoveryDocument(documentId, revision, json) {
  return tauri.core.invoke("write_recovery_document", { documentId, revision, json });
},
async writeRecoveryManifest(generation, json) {
  return tauri.core.invoke("write_recovery_manifest", { generation, json });
},
async deleteRecoveryDocument(documentId) {
  return tauri.core.invoke("delete_recovery_document", { documentId });
},
async recoveryDirectory() { return tauri.core.invoke("recovery_directory"); },
```

- [ ] **Step 4: Run bridge and Rust tests**

Run: `node --test tools/test-native-bridge.js && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests PASS.

- [ ] **Step 5: Commit the bridge**

```bash
git add src/native-bridge.js tools/test-native-bridge.js
git commit -m "Expose session storage through native bridge"
```

## Task 6: Add the recovery scheduler

**Files:**

- Create: `src/recovery-scheduler.js`
- Create: `tools/test-recovery-scheduler.js`
- Modify: `package.json:4-9`

- [ ] **Step 1: Write scheduler tests with a fake clock**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { RecoveryScheduler } = require("../src/recovery-scheduler.js");

function fakeClock() {
  let now = 0;
  let next = 1;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; jobs.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    async advance(ms) {
      now += ms;
      const ready = [...jobs.entries()].filter(([, job]) => job.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, job] of ready) { jobs.delete(id); await job.fn(); }
    },
  };
}

test("idle edits coalesce into one write after one second", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });
  scheduler.changed("a", 1);
  await clock.advance(500);
  scheduler.changed("a", 2);
  await clock.advance(999);
  assert.deepEqual(writes, []);
  await clock.advance(1);
  assert.deepEqual(writes, [["a", 2]]);
});

test("continuous typing checkpoints by ten seconds", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });
  for (let revision = 1; revision <= 10; revision += 1) {
    scheduler.changed("a", revision);
    await clock.advance(999);
  }
  await clock.advance(10);
  assert.deepEqual(writes, [["a", 10]]);
});

test("edits during a write coalesce to the latest revision", async () => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const scheduler = new RecoveryScheduler({ write: async (id, revision) => { writes.push(revision); if (revision === 1) await first; } });
  const pending = scheduler.flush("a", 1);
  scheduler.changed("a", 2);
  scheduler.changed("a", 3);
  release();
  await pending;
  await scheduler.flush("a", 3);
  assert.deepEqual(writes, [1, 3]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tools/test-recovery-scheduler.js`

Expected: FAIL because `RecoveryScheduler` is not defined.

- [ ] **Step 3: Implement the scheduler state machine**

Use a `Map` keyed by document ID. Each entry holds `latestRevision`, `persistedRevision`, `idleTimer`, `maximumTimer`, `inFlight`, and `failed`. `changed` resets only the idle timer; it creates the maximum timer only when none exists. `flush` cancels timers, serializes one write per document, and loops once more when `latestRevision` advanced during the write. `flushAll` waits for every known document and rejects with document IDs whose writes fail.

Expose callbacks `onStatus(id, status, error)` and methods `changed`, `flush`, `flushAll`, `forget`, and `retry`.

- [ ] **Step 4: Run scheduler tests**

Run: `node --test tools/test-recovery-scheduler.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit the scheduler**

```bash
git add src/recovery-scheduler.js tools/test-recovery-scheduler.js package.json
git commit -m "Schedule bounded document recovery writes"
```

## Task 7: Implement session restore and open workflows

**Files:**

- Create: `src/session-controller.js`
- Create: `tools/test-session-controller.js`
- Modify: `package.json:4-9`

- [ ] **Step 1: Write failing restoration and open tests**

Start `tools/test-session-controller.js` with these shared helpers. Later controller tasks extend the same fakes instead of creating a second harness:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionController } = require("../src/session-controller.js");

function readResult(path) {
  const name = path.split(/[\\/]/).pop();
  return { path, canonicalPath: `/canonical/${name.toLowerCase()}`, content: `# ${name}`, sha256: `disk-${name}`, size: name.length, modifiedMs: 1 };
}

function snapshotFor(id) {
  return JSON.stringify({
    schemaVersion: 1, documentId: id, snapshotRevision: id === "b" ? 4 : 1,
    editRevision: 0, displayName: `${id}.md`, path: null, canonicalPath: null,
    content: id, savedContentSha256: `content-${id}`, expectedDiskSha256: null,
    fileStatus: "normal",
    workspace: {
      selectionStart: 0, selectionEnd: 0, editorScrollTop: 0, previewScrollTop: 0,
      viewMode: "split", tocOpen: false,
      find: { open: false, query: "", replacement: "", matchIndex: -1 },
    },
  });
}

function makeController(overrides = {}) {
  let id = 0;
  const io = Object.assign({
    loadRecoveryManifest: async () => null,
    loadRecoveryDocument: async (documentId) => snapshotFor(documentId),
    writeRecoveryDocument: async () => {},
    writeRecoveryManifest: async () => {},
    deleteRecoveryDocument: async () => {},
    recoveryDirectory: async () => "/recovery",
    readDocument: async (path) => readResult(path),
  }, overrides.io || {});
  const scheduler = Object.assign({
    changed() {}, async flush() {}, async flushAll() {}, forget() {}, retry() {},
  }, overrides.scheduler || {});
  const view = Object.assign({
    renderTabs() {}, ensureEditor() {}, removeEditor() {}, activateEditor() {},
    setDocumentStatus() {}, showRecoveryError() {},
  }, overrides.view || {});
  const dialogs = Object.assign({
    async closeDirty() { return "cancel"; }, async quitDirty() { return "cancel"; },
    showConflict() {},
  }, overrides.dialogs || {});
  const legacyStorage = overrides.legacy || { getItem: () => null, removeItem() {} };
  return new SessionController({
    io, scheduler, view, dialogs, legacyStorage,
    hashText: async (text) => `content-${text}`,
    idFactory: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    inactiveLoadConcurrency: 4,
    renderer: overrides.renderer,
    exporter: overrides.exporter,
  });
}
```

Add these tests:

```js
test("restore loads active first and preserves manifest order", async () => {
  const calls = [];
  const io = {
    loadRecoveryManifest: async () => JSON.stringify({
      schemaVersion: 1, generation: 2, activeDocumentId: "b", nextUntitledNumber: 3,
      tabs: [
        { documentId: "a", displayName: "a.md", snapshotRevision: 1 },
        { documentId: "b", displayName: "b.md", snapshotRevision: 4 },
      ],
    }),
    loadRecoveryDocument: async (id) => { calls.push(id); return snapshotFor(id); },
  };
  const controller = makeController({ io });
  await controller.restore();
  assert.equal(calls[0], "b");
  assert.deepEqual(controller.session.tabOrder, ["a", "b"]);
  assert.equal(controller.session.activeDocumentId, "b");
});

test("opening an existing canonical path activates instead of duplicating", async () => {
  const controller = makeController({
    io: { readDocument: async () => ({ path: "A.md", canonicalPath: "/docs/a.md", content: "a", sha256: "sha-a" }) },
  });
  await controller.openPaths(["A.md", "A.md"]);
  assert.equal(controller.session.tabOrder.length, 1);
  assert.equal(controller.session.activeDocumentId, controller.session.tabOrder[0]);
});

test("one read failure does not block later selected files", async () => {
  const controller = makeController({
    io: { readDocument: async (path) => { if (path === "bad.md") throw new Error("denied"); return readResult(path); } },
  });
  const result = await controller.openPaths(["good.md", "bad.md", "last.md"]);
  assert.equal(result.opened.length, 2);
  assert.deepEqual(result.failed.map((item) => item.path), ["bad.md"]);
  assert.equal(controller.activeDocument().displayName, "last.md");
});

test("legacy draft imports as dirty and pathless only after no manifest", async () => {
  const legacy = { getItem: () => JSON.stringify({ name: "old.md", text: "legacy" }), removeItem: () => {} };
  const controller = makeController({ io: { loadRecoveryManifest: async () => null }, legacy });
  await controller.restore();
  assert.equal(controller.activeDocument().path, null);
  assert.equal(controller.activeDocument().dirty, true);
});
```

- [ ] **Step 2: Run the controller test and verify failure**

Run: `node --test tools/test-session-controller.js`

Expected: FAIL because `SessionController` is not defined.

- [ ] **Step 3: Implement restoration and opening**

Constructor dependencies must be explicit:

```js
new SessionController({
  io, scheduler, view, dialogs, legacyStorage, hashText,
  idFactory, inactiveLoadConcurrency: 4,
});
```

Implement `restore`, `restoreManifest`, `loadSnapshot`, `importLegacyDraft`, `openPaths`, `openReadResult`, `activeDocument`, `createUntitled`, and `persistManifest`.

Register the live `file-opened` listener before `restore`. Load the active snapshot first. Queue at most four inactive reads, and let selecting a loading tab move it to the front. Validate snapshots through `DocumentModel.fromSnapshot`. Keep failed recovery files in place and include `recoveryDirectory()` in the error detail.

On open, canonicalize through `readDocument`, detect an existing owner before constructing a second model, continue after individual failures, and activate the final successfully opened or already-owned path.

- [ ] **Step 4: Run controller and model tests**

Run: `node --test tools/test-document-model.js tools/test-session-model.js tools/test-recovery-scheduler.js tools/test-session-controller.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit restore and open workflows**

```bash
git add src/session-controller.js tools/test-session-controller.js package.json
git commit -m "Restore tab sessions and open multiple files"
```

## Task 8: Build the tab strip and independent editor surfaces

**Files:**

- Create: `src/workspace-view.js`
- Create: `tools/test-workspace-view.js`
- Modify: `src/index.template.html:1-851`
- Modify: `build.sh:37-53`

- [ ] **Step 1: Write failing view-adapter tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { tabDescriptor, captureEditorState } = require("../src/workspace-view.js");

test("tab descriptors expose selected, dirty, conflict, and position state", () => {
  const first = tabDescriptor(
    { id: "a", displayName: "a.md", dirty: true, fileStatus: "normal" },
    { activeId: "a", index: 0, size: 2 },
  );
  const second = tabDescriptor(
    { id: "b", displayName: "b.md", dirty: false, fileStatus: "externally-changed" },
    { activeId: "a", index: 1, size: 2 },
  );
  assert.equal(first.selected, true);
  assert.equal(first.position, 1);
  assert.equal(first.statusText, "Unsaved changes");
  assert.equal(second.statusText, "File changed outside MDedit");
  assert.equal(second.closeLabel, "Close b.md");
});

test("editor state capture is independent of the DOM implementation", () => {
  const editor = { selectionStart: 3, selectionEnd: 5, scrollTop: 22 };
  const captured = captureEditorState(editor);
  assert.equal(captured.selectionStart, 3);
  assert.equal(captured.selectionEnd, 5);
  assert.equal(captured.editorScrollTop, 22);
});
```

- [ ] **Step 2: Run the view test and verify failure**

Run: `node --test tools/test-workspace-view.js`

Expected: FAIL because `tabDescriptor` and `captureEditorState` do not exist.

- [ ] **Step 3: Add tab and dialog markup**

Insert below `</header>`:

```html
<div id="document-tabs-wrap">
  <div id="document-tabs" role="tablist" aria-label="Open documents"></div>
  <button id="btn-add-tab" type="button" aria-label="New document" title="New document">+</button>
</div>
<div id="dialog-backdrop" hidden></div>
<section id="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>
  <h2 id="dialog-title"></h2>
  <p id="dialog-message"></p>
  <div id="dialog-documents"></div>
  <div id="dialog-actions"></div>
</section>
```

Replace the single textarea with an editor-surface host:

```html
<div id="editor-surfaces"></div>
```

Add CSS for a 36 px tab row, horizontal overflow, visible focus, selected state, dirty/conflict labels, 32 px minimum close targets, hidden inactive surfaces, modal focus layer, and existing light/dark variables. Preserve the 700 px window minimum and phone breakpoints.

- [ ] **Step 4: Implement `WorkspaceView` and inline modules**

Export pure `tabDescriptor` and `captureEditorState` helpers, then implement `WorkspaceView`. `WorkspaceView` receives element references and callbacks. Implement `renderTabs`, `ensureEditor`, `removeEditor`, `editorFor`, `activateEditor`, `captureWorkspace`, `applyWorkspace`, `showDialog`, `closeDialog`, `setDocumentStatus`, and `focusActiveEditor`.

Use tab-strip event delegation. Emit controller intents instead of mutating models. Keep every textarea mounted with `data-document-id`; inactive surfaces use `hidden`. Set each close button label to `Close <displayName>`. Add offscreen text for unsaved and conflict states.

Add build markers in this order:

```python
"/*__DOCUMENT_MODEL__*/": "src/document-model.js",
"/*__SESSION_MODEL__*/": "src/session-model.js",
"/*__RECOVERY_SCHEDULER__*/": "src/recovery-scheduler.js",
"/*__SESSION_CONTROLLER__*/": "src/session-controller.js",
"/*__WORKSPACE_VIEW__*/": "src/workspace-view.js",
"/*__NATIVE_BRIDGE__*/": "src/native-bridge.js",
```

Add matching `<script>` markers before the application bootstrap script.

- [ ] **Step 5: Build and run view tests**

Run: `node --test tools/test-workspace-view.js && bash ./build.sh`

Expected: tests PASS; `index.html` and `index-lite.html` build without missing markers.

- [ ] **Step 6: Commit the tab workspace**

```bash
git add src/workspace-view.js tools/test-workspace-view.js src/index.template.html build.sh index.html index-lite.html
git commit -m "Add accessible document tab workspace"
```

## Task 9: Route editing, view state, rendering, and exports by document

**Files:**

- Modify: `src/index.template.html:852-2219`
- Modify: `src/document-model.js`
- Modify: `src/session-controller.js`
- Modify: `tools/test-session-controller.js`

- [ ] **Step 1: Add failing active-document isolation tests**

```js
function deferredRenderer() {
  const pending = new Map();
  return {
    render(input) {
      return new Promise((resolve) => pending.set(input.documentId, resolve));
    },
    resolve(documentId, html) { pending.get(documentId)({ html, documentId }); },
  };
}

function deferredExporter() {
  let resolveExport;
  return {
    export() { return new Promise((resolve) => { resolveExport = resolve; }); },
    resolve(value) { resolveExport(value); },
  };
}

function trackingView() {
  return {
    owner: null,
    lastDocumentStatus: null,
    renderTabs() {}, ensureEditor() {}, removeEditor() {}, activateEditor() {},
    setPreview(documentId) { this.owner = documentId; },
    previewOwner() { return this.owner; },
    setDocumentStatus(id, message) { this.lastDocumentStatus = { id, message }; },
  };
}

test("an editor input changes only its owning document", async () => {
  const controller = makeController();
  const a = controller.createUntitled();
  const b = controller.createUntitled();
  controller.onEditorInput(a.id, "alpha");
  assert.equal(controller.session.documents.get(a.id).content, "alpha");
  assert.equal(controller.session.documents.get(b.id).content, "");
});

test("stale render completion cannot replace the active preview", async () => {
  const renders = deferredRenderer();
  const controller = makeController({ renderer: renders, view: trackingView() });
  const a = controller.createUntitled();
  const first = controller.renderDocument(a.id);
  const b = controller.createUntitled();
  renders.resolve(a.id, "<p>alpha</p>");
  await first;
  assert.notEqual(controller.view.previewOwner(), a.id);
  assert.equal(controller.session.activeDocumentId, b.id);
});

test("an export completion reports against its starting document", async () => {
  const exporter = deferredExporter();
  const controller = makeController({ exporter, view: trackingView() });
  const a = controller.createUntitled();
  const pending = controller.exportActive("html");
  const b = controller.createUntitled();
  exporter.resolve({ name: "Untitled 1.html" });
  await pending;
  assert.equal(controller.view.lastDocumentStatus.id, a.id);
  assert.equal(controller.session.activeDocumentId, b.id);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tools/test-session-controller.js`

Expected: FAIL because active-document routing methods are missing.

- [ ] **Step 3: Replace global document variables with controller lookups**

Remove `fileHandle`, `nativePath`, and global `dirty`. Replace direct `editor` reads with `view.editorFor(documentId)` or model content. Route input, filename, find, table-of-contents, view buttons, statistics, save/export names, and scroll synchronization through `activeDocument()`.

On every activation:

1. Capture outgoing workspace state.
2. Queue its recovery flush without awaiting disk I/O.
3. Change the active ID and show its textarea.
4. Restore workspace state with `requestAnimationFrame`.
5. Persist the manifest selection.
6. Start the new render.

Wrap renders in `{ token, documentId, editRevision }`. Before any synchronous preview assignment, Mermaid completion, export completion, or status update, verify the captured identity is still valid. Add an LRU preview cache limited to five entries and 20 MB of serialized HTML.

- [ ] **Step 4: Run unit and generated-output tests**

Run: `npm test && bash ./build.sh`

Expected: all JavaScript tests PASS and both generated files rebuild.

- [ ] **Step 5: Commit active-document routing**

```bash
git add src/index.template.html src/document-model.js src/session-controller.js tools/test-session-controller.js index.html index-lite.html
git commit -m "Isolate editor and preview state per tab"
```

## Task 10: Implement save, conflict, close, and quit workflows

**Files:**

- Modify: `src/session-controller.js`
- Modify: `src/workspace-view.js`
- Modify: `src/index.template.html`
- Modify: `tools/test-session-controller.js`
- Modify: `src-tauri/src/lib.rs`
- Modify: `index.html`
- Modify: `index-lite.html`

- [ ] **Step 1: Add failing workflow tests**

```js
function savedInput(name, content, diskSha256) {
  return {
    path: `/docs/${name}`, canonicalPath: `/docs/${name.toLowerCase()}`,
    content, sha256: diskSha256, size: content.length, modifiedMs: 1,
  };
}

function deferredSaveIO() {
  let finish;
  return {
    saveDocument() { return new Promise((resolve) => { finish = resolve; }); },
    resolveSaved(value) {
      finish({ status: "saved", canonicalPath: "/docs/a.md", size: 5, modifiedMs: 2, ...value });
    },
  };
}

function fakeDialogs(values = {}) {
  return {
    last: null,
    quitCalls: 0,
    async closeDirty() { return values.closeChoice || "cancel"; },
    async quitDirty() { this.quitCalls += 1; return values.quitChoice || "cancel"; },
    showConflict(_document, actions) { this.last = { actions }; },
  };
}

function dirtyController({ closeChoice = "cancel", quitChoice = "cancel", flushError = null } = {}) {
  const dialogs = fakeDialogs({ closeChoice, quitChoice });
  const scheduler = {
    flushAllCalls: 0,
    changed() {}, async flush() {}, forget() {}, retry() {},
    async flushAll() { this.flushAllCalls += 1; if (flushError) throw flushError; },
  };
  const io = {
    chooseSavePath: async () => "/docs/untitled.md",
    canonicalizeDocumentPath: async () => "/docs/untitled.md",
    saveDocument: async () => ({
      status: "saved", canonicalPath: "/docs/untitled.md",
      sha256: "disk-saved", size: 5, modifiedMs: 2,
    }),
    writeRecoveryDocument: async () => {}, writeRecoveryManifest: async () => {},
    deleteRecoveryDocument: async () => {}, loadRecoveryManifest: async () => null,
  };
  const controller = makeController({ io, scheduler, dialogs });
  controller.createUntitled().applyContent("dirty");
  return controller;
}

test("save keeps later edits dirty", async () => {
  const io = deferredSaveIO();
  const controller = makeController({ io });
  const doc = controller.openReadResult(savedInput("a.md", "old", "disk-old"));
  controller.onEditorInput(doc.id, "first");
  const pending = controller.saveDocument(doc.id);
  controller.onEditorInput(doc.id, "second");
  io.resolveSaved({ sha256: "disk-first" });
  await pending;
  assert.equal(doc.dirty, true);
  assert.equal(doc.content, "second");
});

test("conflict never writes and offers reload, keep, or save as", async () => {
  const dialogs = fakeDialogs();
  const controller = makeController({
    io: { saveDocument: async () => ({ status: "conflict", actualSha256: "external" }) }, dialogs,
  });
  const doc = controller.openReadResult(savedInput("a.md", "editor", "old"));
  const result = await controller.saveDocument(doc.id);
  assert.equal(result.status, "conflict");
  assert.equal(doc.fileStatus, "externally-changed");
  assert.deepEqual(dialogs.last.actions, ["reload", "keep-editing", "save-as"]);
});

test("dirty tab close implements save, discard, and cancel", async () => {
  for (const choice of ["save", "discard", "cancel"]) {
    const controller = dirtyController({ closeChoice: choice });
    const id = controller.session.activeDocumentId;
    const result = await controller.closeDocument(id);
    assert.equal(controller.session.documents.has(id), choice === "cancel");
    assert.equal(result.closed, choice !== "cancel");
  }
});

test("quit uses one consolidated dirty-document decision", async () => {
  const controller = dirtyController({ quitChoice: "restore" });
  controller.createUntitled().applyContent("second");
  const result = await controller.requestQuit();
  assert.equal(controller.dialogs.quitCalls, 1);
  assert.equal(controller.scheduler.flushAllCalls, 1);
  assert.equal(result.allowClose, true);
});

test("quit stops when recovery persistence fails", async () => {
  const controller = dirtyController({ quitChoice: "restore", flushError: new Error("disk full") });
  const result = await controller.requestQuit();
  assert.equal(result.allowClose, false);
});
```

- [ ] **Step 2: Run workflow tests and verify failure**

Run: `node --test tools/test-session-controller.js`

Expected: FAIL in the missing save, close, conflict, and quit methods.

- [ ] **Step 3: Implement save and Save All**

Implement `saveDocument`, `saveAs`, and `saveAll` as serialized controller operations. Capture content and `editRevision` before I/O. Mark clean only when the completion revision is current. For Save As, choose a path, canonicalize it, and reject an owner collision by activating the owner. Attempt `readDocument(chosenPath)` after the picker returns: pass its fingerprint to `saveDocument` when the destination exists, and pass `null` only when the destination is confirmed missing. This preserves the native picker's overwrite confirmation without creating an unchecked write path.

Stop Save All on picker cancellation or error. Return `{ savedIds, remainingIds, canceled, error }` so the dialog can name unsaved documents.

- [ ] **Step 4: Implement close, conflict, and quit**

Implement `closeDocument`, `resolveConflict`, `requestQuit`, and `allowNativeClose`. Reconcile fingerprints before deciding whether documents are dirty. After explicit discard, persist the manifest without the tab before deleting its snapshot. Create a replacement untitled document when the final tab closes.

Subscribe to Tauri close requests in the bootstrap:

```js
let allowCloseOnce = false;
await window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (event) => {
  if (allowCloseOnce) { allowCloseOnce = false; return; }
  event.preventDefault();
  const result = await controller.requestQuit();
  if (!result.allowClose) return;
  allowCloseOnce = true;
  await window.__TAURI__.window.getCurrentWindow().close();
});
```

Disable duplicate save/close commands while a controller operation lock is held. Trap focus within the HTML dialog, restore prior focus on cancel, and make Escape equivalent to Cancel only where cancellation is safe.

- [ ] **Step 5: Run complete unit verification**

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml && bash ./build.sh`

Expected: all JavaScript and Rust tests PASS, and both tracked frontend files rebuild.

- [ ] **Step 6: Commit lifecycle workflows**

```bash
git add src/session-controller.js src/workspace-view.js src/index.template.html tools/test-session-controller.js src-tauri/src/lib.rs index.html index-lite.html
git commit -m "Protect multi-document save and quit workflows"
```

## Task 11: Add multi-file inputs and tab keyboard accessibility

**Files:**

- Modify: `src/index.template.html`
- Modify: `src/workspace-view.js`
- Modify: `src/session-controller.js`
- Modify: `tools/test-workspace-view.js`
- Modify: `tools/test-session-controller.js`

- [ ] **Step 1: Write failing keyboard and multi-file tests**

```js
test("tab key combinations map to unambiguous commands", () => {
  const { commandForKey } = require("../src/workspace-view.js");
  assert.equal(commandForKey({ key: "Tab", ctrlKey: true, shiftKey: false }), "next-tab");
  assert.equal(commandForKey({ key: "Tab", ctrlKey: true, shiftKey: true }), "previous-tab");
  assert.equal(commandForKey({ key: "ArrowLeft", altKey: true, shiftKey: true }), "move-tab-left");
  assert.equal(commandForKey({ key: "ArrowRight", altKey: true, shiftKey: true }), "move-tab-right");
  assert.equal(commandForKey({ key: "w", ctrlKey: true, metaKey: false }), "close-tab");
});

test("browser files open in supplied order and activate the final file", async () => {
  const controller = makeController();
  const files = [
    { name: "a.md", text: async () => "a" },
    { name: "b.md", text: async () => "b" },
  ];
  await controller.openBrowserFiles(files);
  const names = controller.session.tabOrder.map((id) => controller.session.documents.get(id).displayName);
  assert.deepEqual(names, ["a.md", "b.md"]);
  assert.equal(controller.activeDocument().displayName, "b.md");
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test tools/test-workspace-view.js tools/test-session-controller.js`

Expected: FAIL because `commandForKey` and `openBrowserFiles` are not defined.

- [ ] **Step 3: Implement keyboard behavior and announcements**

Export `commandForKey(event)` and use it to connect `Control+Tab`, `Control+Shift+Tab`, platform close-tab shortcut, and `Alt+Shift+Left/Right`. Preserve the existing Save, Save As, Open, and Find shortcuts. Add roving `tabindex` to tabs. Announce active position, close outcome, dirty state, conflict, and persistence failure through the existing status live region.

Do not let the tab-switch shortcut trigger textarea indentation. At tab-strip boundaries, keyboard move leaves order unchanged.

- [ ] **Step 4: Route every multi-file source through one controller method**

Implement `openBrowserFiles(files)` by awaiting each `File.text()` in input order and passing each result through the same duplicate-safe document-add path as native reads. Set native dialog `multiple: true`, add `multiple` to `#file-input`, iterate all dropped `DataTransferItem` entries, and preserve picker/drop order. Register the live `file-opened` event before restore. After restore, invoke `take_pending_files` once and call `openPaths(paths)`.

- [ ] **Step 5: Run tests and rebuild**

Run: `npm test && bash ./build.sh`

Expected: all JavaScript tests PASS and generated outputs contain the tab shortcuts and multi-file markup.

- [ ] **Step 6: Commit multi-file accessibility**

```bash
git add src/index.template.html src/workspace-view.js src/session-controller.js tools/test-workspace-view.js tools/test-session-controller.js index.html index-lite.html
git commit -m "Add keyboard tabs and multi-file input"
```

## Task 12: Add browser and performance coverage

**Files:**

- Create: `playwright.config.js`
- Create: `tests/browser/tabs.spec.js`
- Create: `tests/browser/performance.spec.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install Playwright and add scripts**

Run: `npm install --save-dev @playwright/test`

Run: `npx playwright install chromium`

Add:

```json
{
  "scripts": {
    "test": "node --test tools/test-*.js",
    "test:browser": "playwright test tests/browser/tabs.spec.js",
    "test:performance": "playwright test tests/browser/performance.spec.js --workers=1"
  }
}
```

- [ ] **Step 2: Configure a generated-frontend test server**

```js
// playwright.config.js
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests/browser",
  use: { baseURL: "http://127.0.0.1:4173", headless: true },
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 3: Write interaction and accessibility tests**

Inject a fake `window.__TAURI__` with `page.addInitScript`, then test:

```js
const { test, expect } = require("@playwright/test");

async function installFakeTauri(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    window.__TAURI__ = {
      dialog: {
        open: async () => null,
        save: async () => null,
      },
      fs: {
        readTextFile: async () => "",
        writeTextFile: async () => {},
        writeFile: async () => {},
      },
      core: {
        invoke: async (command) => {
          if (command === "load_recovery_manifest") return null;
          if (command === "take_pending_files") return [];
          if (command === "recovery_directory") return "/fake-recovery";
          return null;
        },
      },
      event: {
        listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); },
      },
      window: {
        getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, close: async () => {} }),
      },
    };
  });
}

test("tabs retain content, selection, view, and accessible state", async ({ page }) => {
  await installFakeTauri(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New document" }).click();
  await page.locator('textarea:not([hidden])').fill("# second");
  await page.getByRole("tab", { name: /Untitled 1/ }).click();
  await page.locator('textarea:not([hidden])').fill("# first");
  await page.getByRole("tab", { name: /Untitled 2/ }).click();
  await expect(page.locator('textarea:not([hidden])')).toHaveValue("# second");
  await expect(page.getByRole("tab", { name: /Untitled 2/ })).toHaveAttribute("aria-selected", "true");
});

test("dirty close and consolidated quit trap focus and preserve cancel", async ({ page }) => {
  await installFakeTauri(page);
  await page.goto("/");
  await page.locator('textarea:not([hidden])').fill("dirty");
  await page.getByRole("button", { name: /Close Untitled 1/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('textarea:not([hidden])')).toHaveValue("dirty");
});
```

In the same file, add separately named tests with these exact assertions:

- `overflow keeps active tab and new-document button reachable`: open 30 tabs, select tab 30, and assert its bounding box and the add button intersect the tab-strip viewport after automatic scrolling.
- `roving focus and shortcuts follow tab order`: press the next, previous, move-left, move-right, and close shortcuts and assert `aria-selected`, `tabindex`, order, and focus after each key.
- `status announcements identify their document`: trigger save failure and external conflict from the fake bridge and assert the `role="status"` text contains the affected filename.
- `late Mermaid completion cannot cross documents`: delay `mermaid.render`, switch tabs, resolve the delay, and assert the active preview contains no text or SVG from the prior tab.
- `multi-file open continues after one failure`: return three picker paths with the middle read rejecting; assert tabs one and three exist, tab three is active, and the error names path two.
- `conflict actions preserve both versions`: return `status: "conflict"`, exercise Keep Editing and Save Editor Version As, and assert the original disk content is never sent to `save_document` without its expected fingerprint.

- [ ] **Step 4: Add the explicit performance test**

The fake recovery bridge returns 50 snapshots whose content is exactly 5 MiB. Warm one selection, execute 200 selections, and record `performance.now()` before the action and inside the next `requestAnimationFrame` that shows the selected textarea. Sort measurements and assert the 95th percentile is at most 100 ms. Attach JSON containing p50, p95, maximum, and `performance.memory.usedJSHeapSize` when available.

- [ ] **Step 5: Run browser verification**

Run: `bash ./build.sh && npm run test:browser`

Expected: all browser interaction tests PASS.

Run: `npm run test:performance`

Expected: p95 tab activation is at most 100 ms in the recorded local environment.

- [ ] **Step 6: Commit browser coverage**

```bash
git add package.json package-lock.json playwright.config.js tests/browser
git commit -m "Test tabbed editor interactions and performance"
```

## Task 13: Wire CI, capabilities, documentation, and final artifacts

**Files:**

- Create: `docs/testing/tabbed-editor-smoke-checklist.md`
- Modify: `.github/workflows/desktop.yml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `tools/test-project-identity.js`
- Modify: `README.md`
- Modify: `index.html`
- Modify: `index-lite.html`

- [ ] **Step 1: Add failing project-structure assertions**

```js
test("generated builds contain the tabbed session modules and accessible tab strip", () => {
  for (const file of ["index.html", "index-lite.html"]) {
    const html = readText(file);
    assert.match(html, /id="document-tabs" role="tablist"/);
    assert.match(html, /class SessionModel/);
    assert.match(html, /class RecoveryScheduler/);
    assert.match(html, /Quit and Restore Next Time/);
  }
});

test("the native capability description includes recovery and multi-document access", () => {
  const capability = readJson("src-tauri/capabilities/default.json");
  assert.match(capability.description, /multi-document/i);
  assert.match(capability.description, /recovery/i);
});
```

- [ ] **Step 2: Run project tests and verify the expected failure**

Run: `npm test`

Expected: FAIL until generated desktop output, capability text, and README are updated.

- [ ] **Step 3: Update CI and documentation**

Keep `npm test` in every desktop matrix job and ensure `cargo test --manifest-path src-tauri/Cargo.toml` runs before bundling. Run browser tests in one Linux job with Chromium installed. Keep the 250 MB performance suite as an explicit release/manual job so ordinary pull requests remain fast, and upload its JSON metrics.

Document tab creation, switching, Save All, dirty indicators, restoration, conflict choices, quit choices, and keyboard shortcuts in `README.md`. Create the smoke checklist with one section per platform covering startup file associations, second-instance opens, normal quit, forced termination, external edit, file deletion, and recovery-directory failure.

Update the capability description to state that the main window can access user-selected documents and local recovery data. Remove filesystem permissions that are no longer used after all document and recovery operations route through commands; retain raw-byte export permissions if export still uses the filesystem plugin.

- [ ] **Step 4: Regenerate all frontend artifacts**

Run: `bash ./build.sh && bash ./tools/build-desktop.sh`

Expected: `index.html`, `index-lite.html`, and `dist-desktop/index.html` are generated from the updated template and contain the inlined modules.

- [ ] **Step 5: Run the complete local quality gate**

Run: `npm test`

Expected: all Node tests PASS.

Run: `npm run test:browser`

Expected: all browser tests PASS.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: exit 0.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

Run: `npm run build:desktop`

Expected: desktop frontend staging succeeds.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Complete platform smoke checks**

Run every item in `docs/testing/tabbed-editor-smoke-checklist.md` on Windows, macOS, and Linux. Record the MDedit version, operating-system version, result, and recovery-data location for each platform. Any failure blocks release.

- [ ] **Step 7: Commit final integration**

```bash
git add .github/workflows/desktop.yml src-tauri/capabilities/default.json tools/test-project-identity.js README.md docs/testing/tabbed-editor-smoke-checklist.md index.html index-lite.html
git commit -m "Complete tabbed multi-document editor integration"
```

## Requirements traceability

| Requirement area | Plan tasks |
| --- | --- |
| Tabs, order, active document, untitled names | 2, 8, 11 |
| Per-document content and workspace state | 1, 8, 9 |
| Independent in-session undo | 8, 9, 12 |
| Native per-document recovery | 3, 5, 6, 7 |
| 1-second idle and 10-second continuous checkpoints | 6, 12 |
| Startup restoration and legacy migration | 3, 7, 13 |
| Multi-file open and duplicate paths | 2, 5, 7, 11 |
| Save, Save As, and Save All | 4, 5, 10 |
| External changes, missing files, and conflicts | 4, 10, 12 |
| Dirty-tab and application close choices | 8, 10, 12 |
| Keyboard and assistive-technology behavior | 8, 11, 12 |
| 50 documents, 5 MB each, 100 ms p95 | 12, 13 |
| Privacy, local-only data, and path safety | 3, 4, 13 |
| Generated builds and regression coverage | 8-13 |
