# Desktop Recent Documents Implementation Plan

**Goal:** Add the approved desktop-only Open Recent menu, retaining 20 successfully opened or saved files across launches.

**Architecture:** A native RecentDocumentsStore persists a versioned JSON list separately from session recovery. Reuse recovery's atomic rotation writer. Native bridge serializes recent-list operations; SessionController records only successful opens/saves without awaiting history persistence. A small menu module lists filenames/folders, activates an existing tab before reading disk, otherwise calls openPaths, and supports remove/clear. Browser builds keep the control hidden.

**Tech Stack:** Rust/Tauri, plain JavaScript and CSS, Node tests, Playwright.

- [x] Add Rust store tests for ordering, cap, canonical duplicates, reload, remove/clear, malformed data and write failure. Implement list/remember/remove/clear commands and register state in lib.rs. Do not store document contents.
- [x] Test bridge commands and non-blocking controller hooks. Record after valid opens and successful native Save/Save As, never on failed reads or save-destination probes. Serialize history operations so immediate menu loads include prior updates.
- [x] Add accessible desktop menu beside Open with filename and folder, native-themed controls, keyboard dismissal/navigation, remove and clear. Reopening a currently open canonical path activates that tab, including when its backing file disappeared. Failed opens retain the row and show an error plus a Remove action.
- [x] Add browser coverage for desktop-only visibility, ordering, duplicate dirty tabs, missing files, remove/clear, keyboard access, and both themes. Rebuild generated full/lite assets.
- [x] Run Node/browser/Rust tests, formatting and Clippy; inspect light/dark screenshots and review final diff.

**Boundaries:** No browser recents, pins, search, startup page, or automatic release. Clear affects only history; failed history writes never veto save/open/quit. History records canonical paths for identity and original absolute paths for display/reopening. Save As retains the old file entry as a separate recent file. Files absent at menu load remain listed until explicit removal. Corrupt history reports an error and can be reset with Clear.

## Verification

323 Node tests, 42 browser tests, and 75 native tests passed. Cargo formatting and Clippy (all targets, warnings denied) passed. Rebuilt full/lite HTML and desktop staging. Inspected 20-entry menu screenshots in light/dark with OS preference opposed. Review findings about native-thread dispatch and focus during delayed failures were fixed and rechecked.
