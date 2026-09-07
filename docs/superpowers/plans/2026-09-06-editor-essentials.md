# Editor Essentials Implementation Plan

**Goal:** Implement approved features 1–7: formatting shortcuts, smart lists, local assets, external-change notifications/comparison, editor preferences, richer single-document search, and document utilities. Spellcheck and cross-tab search excluded.

**Architecture:** Preserve textarea and undo-aware replaceRange. Extract pure editing/search helpers and separate editor settings, desktop assets, and document utilities modules. Extend SessionController with guarded external reconciliation and recently closed saved-file descriptors. Native file commands run off UI thread and use validated paths; native metadata caching avoids repeatedly hashing unchanged documents.

**Implementation stages:**
- [x] Native asset import/read, external file probe, and reveal-in-file-manager commands with Rust tests. Root agent handles bridge wiring; native implementer owns new Rust module and lib registration.
- [x] Pure formatting transforms (bold/italic/link/inline/fenced code/headings), list continuation/exit, search matcher with case/whole-word/regex and safe replacement expansion; Node tests before integration.
- [x] Editor panel with formatting and font size, tab width, wrap and line-number controls persisted locally. Add search toggles and validation to existing find bar. All transforms use native undo insertion and active-document guards.
- [x] Clipboard/drop/picker asset insertion into saved-document assets directory, relative-image resolution into data URLs for preview/exports, attachment links and exported attachment embedding. Ask Save As for untitled documents before importing. Capture initiating doc/revision across async operations.
- [x] Periodic/focus-triggered desktop checks: clean documents reload through guarded controller update; dirty documents keep editor content and show comparison/Reload/Keep Editing/Save As. Ignore stale results and never overwrite edits made during reads.
- [x] Tab context menu with reopen closed saved file, copy path, reveal folder, Save As and Close. Preserve workspace on reopen; never resurrect deliberately discarded untitled edits.
- [x] Browser integration tests for undo, lists, preferences, search modes, assets/exports, external-change races, tab utilities and keyboard/theme behavior. Full Node/Rust/browser checks, native build validation, and review.

**Decisions:** Ctrl/Cmd+B/I/K/E for bold/italic/link/inline code, Ctrl/Cmd+Shift+C for fenced code, Ctrl/Cmd+Alt+1–6 headings. Enter continues lists/checklists, Shift+Enter stays a plain newline. Keep native browser undo. Preferences apply to all editor tabs; wrapping defaults on, line numbers off. Poll desktop file signatures every 3 seconds and on focus, skip overlapping passes. Clean-file reload also refreshes preview; dirty-file comparison is read-only until an explicit resolution. Existing recovery/saving conflict checks remain authoritative. No auto-release as part of feature development.


**Verification notes:** Regression tests cover native undo, list exit/continuation, settings persistence, per-tab regex options and snapshot compatibility, paste/picker/native-drop imports, cancellation and delayed imports, local image preview and HTML/PNG/PDF exports, asset freshness and Save As folder changes, clean external reload versus dirty comparison, deletion/recreation, and reopen/reveal actions. Chromium screenshots checked at the 700×480 desktop minimum in light and dark themes. Native commands are covered by Rust tests; actual Finder/Explorer/xdg-open launches and native clipboard/drag interactions on each release OS remain manual smoke checks.

**Review corrections:** Multi-backtick inline-code toggling, missing-file recreation with a previously cached conflict, tab-specific search flags, fresh asset bytes for exports, path-aware preview captures/cache, cache invalidation before disk reload, and immediate preview refresh after Save As to another folder.


**Final checks:** `npm test` — 334 passed; `npm run test:browser` — 58 passed; `cargo test --manifest-path src-tauri/Cargo.toml` — 82 passed (release-only recovery diagnostic ignored); `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` passed. `npm run build:desktop` generated both HTML builds and staged the desktop frontend. `git diff --check` passed.

`npm run test:performance` passed the existing 50 × 5 MiB / 200-activation benchmark: p95 51.7 ms, peak observed renderer JS heap 435,000,000 bytes. Nine activation outliers exceeded 100 ms, with a 5.4-second maximum; this is browser fake-bridge evidence, not a guarantee of native latency or total process memory.
