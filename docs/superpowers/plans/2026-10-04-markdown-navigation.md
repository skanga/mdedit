# Markdown navigation implementation plan

**Goal:** Distinguish same-named documents and open resolvable Markdown links in editor tabs.

**Design:** Show each saved document's full path in its tab tooltip and the active document's window title, retaining the dirty marker and untitled fallback. Do not add a path row. Preview links to local `.md`, `.markdown`, `.mdown`, and `.mkd` files resolve relative to the source document, or from an absolute native path. Only existing readable regular files become enabled. Opening uses the session controller, which focuses existing tabs without replacing edits. Browser-only sessions cannot resolve disk paths. External URLs and attachment downloads retain their behavior.

**Architecture:** Keep display changes in `src/workspace-view.js`. Add a small preview link module with native resolution in `src-tauri/src/desktop_files.rs` and a bridge method. Resolve asynchronously with ownership checks and recheck on activation. Rehydrate cached previews so their link handlers and filesystem checks remain current. Fragment/query suffixes do not form part of the filesystem path.

**Tech stack:** Existing JavaScript, Rust/Tauri, Node tests, and Playwright; no dependencies.

- [x] Add failing tooltip/title unit tests and browser navigation tests, including missing files, encoded relative paths, repeated opens, and Save As.
- [x] Implement tooltip/title changes, including path-only metadata updates.
- [x] Add and exercise native resolver tests for parent paths, encoding, absolute paths, unsupported schemes, directories, and missing files.
- [x] Implement preview link resolution and activation, isolate it from attachment downloads, and integrate normal/cached rendering.
- [x] Regenerate frontend assets; run Node tests, browser tests, Rust formatting/tests, and desktop build.
- [x] Review the diff and report any verification limitations.

## Verification

- `npm test`: 356 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`: 101 passed; one release performance diagnostic intentionally ignored.
- `npm run test:browser -- --workers=2`: 76 passed before the final Windows-drive URI fix.
- Final focused browser checks: 11 passed, including the added Windows-drive regression and attachment/export flows.
- `npm run build:desktop`, Cargo formatting, and `git diff --check`: passed.
- Full paths are stored without truncation and titles use a regular hyphen. Native Windows/macOS title-bar clipping was not manually inspected; browser tests use the Tauri test bridge.
