# Tabbed multi-document editor technical design

## 1. Design objective

Implement the approved [tabbed multi-document editor requirements](./2026-09-04-tabbed-multi-document-editor-design.md) without replacing MDedit's Markdown renderer, export features, native file associations, or self-contained frontend build.

The design introduces a testable document/session core in JavaScript and a small native persistence and file-safety layer in Rust. The active workspace remains one application window with one shared preview. Each document owns independent editor state and browser undo history.

## 2. Current architecture and constraints

MDedit currently has these relevant characteristics:

- `src/index.template.html` contains the interface, renderer, editor behavior, file workflows, and single-document state.
- `build.sh` inlines source and vendored libraries into `index.html` and `index-lite.html`. The desktop build stages the full generated file in `dist-desktop/`.
- `src/native-bridge.js` wraps Tauri dialog and filesystem APIs with `pickFile`, `readFile`, `saveAs`, and `writeFile`.
- The frontend stores one draft in the `mdedit-draft-v1` local-storage value after a 400 ms idle delay.
- The Tauri shell already queues startup files and emits `file-opened` for files received by the running single instance.
- The project uses Node's built-in test runner for JavaScript and ordinary Rust tests for the Tauri crate.

The implementation must preserve one source template for the full and lite builds. Generated HTML files remain build products and must not become hand-maintained sources.

## 3. Architectural approach

### 3.1 Chosen approach

Use a frontend session model backed by Tauri-managed recovery files:

```text
Native file launch / toolbar / tabs / keyboard / window close
                              |
                              v
                     SessionController
                  /        |        |        \
                 v         v        v         v
          SessionModel  WorkspaceView  DocumentIO  RecoveryScheduler
                 \                         |        /
                  \                        v       /
                   \----------------> nativeApp bridge
                                           |
                                           v
                                  Tauri commands in Rust
                      |               |
                      v               v
              app-data snapshots   user documents
```

The controller is the only component that coordinates multi-step actions such as Save All, tab closure, application quit, restoration, and conflict resolution. Views send commands to the controller and render its state. They do not perform document writes directly.

### 3.2 Rejected approaches

Do not expand the current local-storage draft into a multi-document database. Browser storage has unsuitable size and durability characteristics for 50 documents of up to 5 MB each.

Do not create one native window per document. That model conflicts with the approved tabbed workspace and complicates restoration and quit confirmation.

Do not move Markdown parsing and rendering into Rust. The existing renderer and export pipeline already operate in the webview and remain appropriate there.

## 4. Source organization

Add focused JavaScript modules under `src/`:

| File | Responsibility |
| --- | --- |
| `src/document-model.js` | Document state, revisions, dirty-state reconciliation, and serialization |
| `src/session-model.js` | Ordered documents, active document, untitled numbering, and tab operations |
| `src/recovery-scheduler.js` | Per-document debounce, continuous-typing checkpoints, coalescing, and flush |
| `src/session-controller.js` | Open, save, Save All, close, quit, restore, and conflict workflows |
| `src/workspace-view.js` | Tab strip, editor surfaces, dialogs, focus, and workspace state capture/apply |
| `src/native-bridge.js` | Browser/native capability boundary and Tauri command wrappers |

Each logic module uses the project's existing browser/CommonJS compatibility pattern: expose its browser API under one `window.MDEdit` namespace and export testable functions through `module.exports` when CommonJS is present. The files must not require a runtime module loader.

`build.sh` receives explicit markers for the new files and inlines them in dependency order before the application bootstrap code in `src/index.template.html`. The lite and full outputs use the same session implementation. In plain-browser builds, the session controller falls back to the existing single-draft behavior; native multi-document recovery is a desktop capability for this phase.

Add focused Rust modules:

| File | Responsibility |
| --- | --- |
| `src-tauri/src/recovery.rs` | App-data paths, atomic recovery reads/writes, fallback snapshots, validation, and deletion |
| `src-tauri/src/document_io.rs` | Canonical paths, file fingerprints, guarded reads, and conflict-aware writes |
| `src-tauri/src/lib.rs` | Tauri setup, command registration, launch-file routing, and close integration |

## 5. In-memory model

### 5.1 Document model

Each `DocumentModel` contains:

```text
id                       stable random UUID
displayName              filename or unique untitled name
path                     user-facing absolute path, or null
canonicalPath            normalized comparison path, or null
content                  current normalized Markdown text
editRevision             increments after every content change
persistedRevision        latest revision confirmed in recovery storage
savedContentSha256       fingerprint of the last successful document save
expectedDiskSha256       fingerprint from the last successful disk read/write
dirty                    current content differs from savedContentSha256
fileStatus               normal | externally-changed | missing | read-error
workspace                selection, scroll, view, TOC, and find state
recoveryStatus           clean | pending | writing | failed
```

New untitled documents use the SHA-256 fingerprint of empty UTF-8 text as their saved-content baseline. This makes a new blank tab clean while the first content change makes it dirty.

Input marks a document tentatively dirty and increments `editRevision`. The scheduler calculates SHA-256 asynchronously at a persistence boundary. If an undo returns the content to `savedContentSha256`, the model becomes clean again. Before close or quit decides whether a prompt is needed, the controller reconciles pending dirty-state fingerprints.

### 5.2 Session model

`SessionModel` contains:

```text
documents                Map<documentId, DocumentModel>
tabOrder                 ordered document IDs
activeDocumentId         selected document ID
nextUntitledNumber       monotonic counter for unique labels
generation               increments after each structural mutation
```

Model methods enforce these invariants:

1. `tabOrder` contains every document ID exactly once.
2. `activeDocumentId` exists in `documents`.
3. At least one document exists after a user-visible operation completes.
4. No two documents own the same canonical path.
5. Untitled display names are unique within the session.

Structural methods return change descriptions for the view and persistence layers. They do not touch the DOM or filesystem.

### 5.3 Independent undo history

The existing textarea relies on the browser's native undo stack. Assigning a different document's value to one shared textarea would mix or discard undo history.

Create one source textarea per open document and keep inactive textareas mounted but hidden. Only the active textarea participates in layout, focus, rendering, and scroll synchronization. The session model mirrors each textarea's current value on input. The shared preview, table of contents, find bar, and export surface bind to the active document.

This approach keeps the existing undo behavior without introducing a new editor framework. The 50-document performance test must include memory measurement because the textarea and model can retain references to the same large strings. If the browser duplicates those strings enough to exceed the documented test budget, implementation must replace persistent textareas with a bounded application-level undo store before release; losing per-tab undo is not an acceptable fallback.

## 6. Persisted format

### 6.1 Directory layout

Store recovery data below Tauri's application-data directory:

```text
session-v1/
  manifest.json
  manifest.prev.json
  documents/
    <document-id>.json
    <document-id>.prev.json
```

Document IDs are generated UUIDs. Rust validates every ID before using it in a path. User filenames and user paths never become recovery filenames.

### 6.2 Manifest

The manifest is intentionally small:

```json
{
  "schemaVersion": 1,
  "generation": 42,
  "activeDocumentId": "6d8b...",
  "nextUntitledNumber": 4,
  "tabs": [
    {
      "documentId": "6d8b...",
      "displayName": "notes.md",
      "snapshotRevision": 18
    }
  ]
}
```

Keeping labels in the manifest lets startup render the full tab strip before loading every document snapshot.

### 6.3 Document snapshot

Each document has an independent snapshot:

```json
{
  "schemaVersion": 1,
  "documentId": "6d8b...",
  "snapshotRevision": 18,
  "editRevision": 27,
  "displayName": "notes.md",
  "path": "/documents/notes.md",
  "canonicalPath": "/documents/notes.md",
  "content": "# Notes\n",
  "savedContentSha256": "...",
  "expectedDiskSha256": "...",
  "fileStatus": "normal",
  "workspace": {
    "selectionStart": 4,
    "selectionEnd": 4,
    "editorScrollTop": 0,
    "previewScrollTop": 0,
    "viewMode": "split",
    "tocOpen": false,
    "find": {
      "open": false,
      "query": "",
      "replacement": "",
      "matchIndex": -1
    }
  }
}
```

Rust treats the snapshot JSON as versioned data but does not need to understand editor-only fields. It validates the envelope fields needed for safe file placement and fallback selection. JavaScript validates the complete schema before constructing a model.

Do not store rendered HTML, Mermaid output, preview DOM, or undo history. Recreate them from Markdown content after restoration.

## 7. Atomic persistence

### 7.1 Atomic write algorithm

For a manifest or document snapshot, Rust performs these steps in the target directory:

1. Validate the document ID and confirm that the payload is valid UTF-8 data that fits in the process address space.
2. Write the complete payload to a uniquely named temporary file.
3. Flush the temporary file to the operating system.
4. Rotate the current valid target to its `.prev.json` path.
5. Rename the temporary file to the current target.
6. Attempt to flush the containing directory on platforms that support it.
7. Return success only after the current target is in place.

If the operation fails after rotation, the loader can recover from `.prev.json`. Temporary files left by an interruption are ignored and may be removed after a later successful load.

### 7.2 Ordering rules

Persistence order prevents the manifest from naming unusable state:

- **Add document:** write its first snapshot, then add it to the manifest.
- **Update content/state:** write only that document snapshot. Update the manifest only if its advertised snapshot revision or tab label changes.
- **Reorder/select:** write the manifest only.
- **Discard/close:** write the manifest without the document, then delete its current and previous snapshots on a best-effort basis.
- **Save As/path change:** write the updated document snapshot, then write any changed manifest label.

A snapshot write includes its `editRevision`. Completion updates `persistedRevision` only if it still matches that revision. A later edit therefore cannot be mistaken for persisted content when an older asynchronous write completes.

### 7.3 Scheduler

`RecoveryScheduler` owns one state machine per document:

```text
clean -> pending -> writing -> clean
                   |    ^
                   v    |
                 pending       edit arrived during write

any state -> failed            native write failed
failed -> pending              explicit or scheduled retry
```

On input, the scheduler starts or resets a 1-second idle timer. It also starts a 10-second maximum timer on the first unpersisted edit. The idle timer writes after a pause. The maximum timer checkpoints continuous typing. A document has at most one recovery write in flight, and later requests coalesce to the newest revision.

Tab switch, window blur, normal restart, and quit call `flush(documentId)` or `flushAll()`. Structural metadata uses a separate serialized queue so manifest generations cannot complete out of order.

Persistence errors remain sticky in the affected tab and global status area until a later successful checkpoint. Quit and Restore Next Time waits for `flushAll()` and refuses to close if it fails.

## 8. Native document I/O

### 8.1 Bridge contract

Extend `nativeApp` with these operations:

```text
pickFiles() -> string[]
readDocument(path) -> { path, canonicalPath, content, sha256, size, modifiedMs }
saveDocument({ path, expectedSha256, content })
  -> { status: "saved", canonicalPath, sha256, size, modifiedMs }
   | { status: "conflict", actualSha256, size, modifiedMs }
chooseSavePath({ defaultDir, suggestedName }) -> string | null
loadRecoveryManifest() -> current or previous manifest
loadRecoveryDocument(documentId, snapshotRevision) -> current or previous snapshot
writeRecoveryDocument(documentId, revision, json) -> void
writeRecoveryManifest(generation, json) -> void
deleteRecoveryDocument(documentId) -> void
recoveryDirectory() -> string
```

Binary export keeps the existing raw-byte save path. Document saving is separated from export saving so conflict checks cannot be skipped accidentally.

### 8.2 Read and path identity

Rust canonicalizes an existing path using the platform filesystem and returns both the display path and comparison path. On case-insensitive platforms, the comparison form is case-folded consistently. If canonicalization cannot resolve a missing path, the controller retains the last canonical path but marks the file missing.

`readDocument` reads UTF-8 content and fingerprints the exact bytes read. The frontend normalizes CRLF to LF for editing. The saved baseline uses the fingerprint of the normalized UTF-8 content MDedit will write, while `expectedDiskSha256` represents the exact last-observed disk bytes. This distinction prevents newline normalization from masquerading as an external change.

### 8.3 Conflict-aware save

For a saved path, Rust compares the current disk fingerprint with `expectedSha256` immediately before replacement. A mismatch returns `conflict` without writing. A match allows an atomic user-document write through a temporary file in the document's directory, followed by replacement of the destination. When replacing an existing file, preserve its platform permissions where the operating system exposes them.

The controller captures `content` and `editRevision` before starting the save. On success it updates the expected disk fingerprint and the saved-content fingerprint to the written content. It clears `dirty` only if the current edit revision still equals the written revision. Edits made during the write therefore remain dirty and recoverable.

Save As first obtains a path, canonicalizes it, and checks session ownership. If another open tab already owns that path, MDedit activates the existing tab, reports that the path is already open, and leaves the source tab unchanged.

### 8.4 External conflict workflow

When `saveDocument` returns a conflict, the controller marks that document `externally-changed`, writes its recovery snapshot, and opens a document-scoped conflict dialog. The actions are:

- **Reload Disk Version:** read the latest disk content and replace the editor version after explicit discard confirmation when dirty.
- **Keep Editing:** close the dialog without writing or clearing the conflict state.
- **Save Editor Version As:** choose a different path and write the editor content there.

The ordinary Save command cannot overwrite the conflicted path. This design intentionally omits a force-overwrite action.

## 9. Workspace and tabs

### 9.1 Tab strip

Insert the tab strip below the existing toolbar and above the find bar/workspace. Use the WAI-ARIA tab pattern:

- The strip has `role="tablist"`.
- Each tab has `role="tab"`, `aria-selected`, position metadata, and `aria-controls`.
- The active workspace has `role="tabpanel"` and references the active tab.
- Close buttons include the document name in their accessible label.
- Dirty and conflict states have visible and screen-reader text equivalents.

Use event delegation on the tab strip for selection, closure, and drag-and-drop. Keep the new-document button outside the `tab` role while keeping it adjacent to the list. When tabs overflow, scroll the active tab into view without moving focus unexpectedly.

### 9.2 Activation sequence

Tab activation follows one ordered path:

1. Capture the outgoing textarea's selection and editor scroll.
2. Capture preview scroll, view mode, table-of-contents state, and find state.
3. Queue a flush of the outgoing document without waiting for disk I/O.
4. Change `activeDocumentId`.
5. Hide the outgoing editor surface and show the incoming surface.
6. Apply the incoming view, preview, table-of-contents, find, and status state.
7. Restore scroll and selection after layout.
8. Focus the tab or editor according to the initiating action.
9. Queue immediate persistence of the manifest selection.

The editor surface must appear before Markdown preview work begins. This ordering protects the 100 ms loaded-tab target.

### 9.3 Rendering and export isolation

The Markdown renderer accepts `{ documentId, editRevision, content }`. Each render receives a monotonically increasing token. Synchronous and Mermaid completion code may update the shared preview only when the token, document ID, and revision still match the active document.

Keep a bounded, least-recently-used cache of sanitized previews, keyed by document ID and edit revision. Cache at most five documents or 20 MB of serialized preview HTML, whichever limit is reached first. Activation may show a matching cache immediately. It must clear the preview rather than display another document's stale output when no matching cache exists.

All export helpers capture the active document ID and revision at their start. Status messages and asynchronous completion must remain attached to that document even if the user changes tabs while an export runs.

### 9.4 Dialogs and application close

Implement HTML dialogs inside the app for dirty-tab closure, conflict resolution, and consolidated quit choices. Native message dialogs do not provide the required three-action semantics consistently across platforms.

Subscribe to Tauri's close-requested event. The handler prevents the first close, asks the controller to reconcile dirty state, and runs the approved quit flow. After successful persistence, set a one-use `allowClose` flag and request closure again. The second close consumes the flag and proceeds without reopening the dialog.

While a close or save flow is active, reject duplicate commands and disable the relevant controls. This prevents two dialogs or overlapping Save All operations.

## 10. Startup and migration

Startup proceeds in this order:

1. Register the live `file-opened` listener so no later operating-system event is missed.
2. Load and validate the current manifest, falling back to `manifest.prev.json` when required.
3. Render tab labels from the manifest.
4. Load the active document snapshot and show its workspace.
5. Load inactive snapshots in the background with bounded concurrency.
6. Check restored saved files against their expected disk fingerprints.
7. Pull Rust's queued startup paths and open them after the restored tabs.
8. Create a blank untitled tab only when no valid document was restored or opened.

Use four concurrent inactive-snapshot reads. This avoids a 50-file I/O burst while making tabs available quickly. A selected tab whose snapshot is still loading shows a document-specific loading state and receives priority in the queue.

If no multi-document manifest exists, read `mdedit-draft-v1`. Import valid legacy text as one dirty, pathless tab because the legacy value does not prove a writable file association or saved baseline. Preserve its legacy display name. Delete `mdedit-draft-v1` only after the new snapshot and manifest both persist successfully.

If neither current nor previous recovery data is valid, preserve all files, show a fresh untitled tab, and offer the recovery-directory location in the error details.

## 11. Multi-file input

Change the native open dialog to `multiple: true` and normalize its return value to an array. Process selected paths independently and preserve selection order.

Change browser file input and drag-and-drop handling to iterate over all supplied files. Where a browser file handle is available, retain it for write-back. The desktop build continues to prefer native paths.

The existing Rust startup queue and `file-opened` event already iterate over multiple paths. Route both through `SessionController.openPaths()` so startup, second-instance, macOS, dialog, and drop inputs share canonicalization, duplicate detection, partial-failure handling, and activation behavior.

## 12. Testing strategy

### 12.1 JavaScript unit tests

Use `node:test` with fake persistence, file I/O, clock, dialogs, and view ports. Cover:

- Session invariants, untitled numbering, activation, reorder, and adjacent-tab selection.
- Per-document dirty reconciliation and revision races during save and persistence.
- Duplicate canonical paths and Save As ownership collisions.
- Save, Save All, dirty-tab close, consolidated quit, cancel, and failure branches.
- Recovery scheduling at 1 second and 10 seconds, write coalescing, retry, and flush.
- Restoration, invalid snapshots, legacy draft migration, and partial file-open failures.
- Conflict, missing-file, and externally changed-file workflows.
- Stale render and export completion after a tab switch.

Keep model and controller tests DOM-free. Test workspace DOM behavior separately with a minimal browser test harness.

### 12.2 Rust unit tests

Use temporary directories and cover:

- Valid and invalid recovery document IDs.
- Atomic current/previous rotation and recovery after failure at each transition.
- Rejection of malformed identifiers and payloads that cannot be represented safely.
- Current-to-previous fallback for invalid JSON and revision mismatch.
- UTF-8 reads, canonicalization, exact-byte and normalized-content fingerprints.
- Successful conditional writes, external-change rejection, missing paths, and write failures.

### 12.3 Browser interaction tests

Load the generated frontend with a fake `nativeApp` and automate:

- Mouse and keyboard tab creation, activation, closure, overflow, and reordering.
- WAI-ARIA roles, selected state, accessible names, focus movement, and live messages.
- Independent selection, scroll, find, view, and table-of-contents state.
- Dialog focus trapping, Escape behavior, and destructive-action confirmation.
- Preview isolation during rapid switching and delayed Mermaid rendering.

### 12.4 Desktop integration tests

Verify on Windows, macOS, and Linux:

- Startup files, second-instance files, and multiple-file open dialogs.
- Normal close, canceled close, Save All & Quit, and Quit and Restore Next Time.
- Restart restoration and forced-process recovery.
- External edits, deleted files, and Save As.
- Application-data permissions and recovery fallback.

### 12.5 Performance test

Generate 50 documents containing 5 MB each. After all documents load and one warm-up selection completes, perform at least 200 tab selections. Record time from selection command to the first painted frame containing the selected editor.

At least 95 percent of measurements must be at or below 100 ms in the documented reference environment. Record peak process memory, snapshot write duration, and main-thread long tasks. Preview completion is recorded separately and does not count toward editor-selection latency.

## 13. Delivery sequence

Implement in dependency order:

1. Pure document/session models and unit tests.
2. Rust recovery storage and document I/O commands with unit tests.
3. Native bridge contracts and fake bridge tests.
4. Recovery scheduler and restoration flow.
5. Tab strip and per-document editor surfaces.
6. Active-document routing for rendering, find, view controls, saves, and exports.
7. Close, quit, Save All, and conflict dialogs.
8. Multi-file launch, picker, and drag-and-drop routing.
9. Browser interaction, desktop integration, accessibility, and performance verification.
10. Generated frontend assets and regression verification.

Each step keeps the application runnable and must preserve existing single-document behavior for the active tab.

## 14. Design risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Large content is duplicated between models, textareas, IPC, and JSON | Persist only changed documents; serialize off the input path; measure peak memory with the required workload |
| An older async write completes after a newer edit | Include edit revisions and use one coalescing write queue per document |
| Rapid switching leaks another document's preview or export result | Validate document ID, revision, and render token before every async UI update |
| Manifest and document snapshots become inconsistent | Apply snapshot-before-manifest and manifest-before-delete ordering; retain current and previous files |
| Close events recurse or show duplicate dialogs | Use one-use close authorization and a controller-level operation lock |
| External edits race with Save | Fingerprint immediately before atomic replacement and reject any observed mismatch |
| Persistent textareas consume excessive memory | Measure the 50-by-5-MB workload; replace with bounded app-managed undo if the target environment cannot support it |
| A persistence failure creates false confidence | Show sticky recovery failure state and refuse recovery-dependent quit |

## 15. Explicit non-goals

This design does not add split editor groups, multiple windows, cloud sync, collaboration, file-tree navigation, pinned tabs, recently closed tabs, restart-persistent undo history, automatic conflict merging, or continuous file watching.
