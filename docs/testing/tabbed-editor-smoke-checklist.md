# Tabbed editor release smoke checklist

Run this checklist against the packaged release candidate on every supported platform. Do not mark a release ready until every item passes. Attach logs or screenshots for failures; do not record an unrun item as passing.

Use two small Markdown fixtures with different names and content. Keep a copy outside MDedit so external changes and deletion are reversible.

## Windows

- MDedit version:
- Operating-system version:
- Package or executable tested:
- Result (Pass / Fail / Blocked):
- Recovery-data location (from recovery error details or the app-data directory):
- Tester and date:
- Notes / evidence:
- End-to-end 5 MiB recovery checkpoint duration (JS serialization + IPC + native disk, ms; read `window.__MDEDIT_RECOVERY_PERFORMANCE__` in the packaged app):

- [ ] **Startup file association:** Install the NSIS or MSI package, open each fixture from Explorer, and confirm both appear once in the expected tab order.
- [ ] **Second-instance open:** With MDedit already running, open the other fixture from Explorer and confirm the existing window gains one tab and becomes focused.
- [ ] **Normal quit:** Close the window with clean tabs, choose Cancel once, then Close; relaunch and verify the saved session state.
- [ ] **Forced termination:** Make distinct unsaved edits in two tabs, terminate MDedit from Task Manager, relaunch, and verify both edits, tab order, active tab, and workspace state restore.
- [ ] **External edit:** Change an open file with another editor, edit it in MDedit, save, and verify Reload Disk Version, Keep Editing, and Save Editor Version As are offered without overwriting unexpectedly.
- [ ] **File deletion:** Delete an open file externally, attempt to save it, and verify the tab remains open and can be saved to a new location.
- [ ] **Recovery-directory failure:** Make the recovery-data directory unwritable, edit a document, and verify a visible persistence failure identifies the recovery location and retry remains possible after permissions are restored.

## macOS

- MDedit version:
- Operating-system version:
- Package or executable tested:
- Result (Pass / Fail / Blocked):
- Recovery-data location (from recovery error details or the app-data directory):
- Tester and date:
- Notes / evidence:
- End-to-end 5 MiB recovery checkpoint duration (JS serialization + IPC + native disk, ms; read `window.__MDEDIT_RECOVERY_PERFORMANCE__` in the packaged app):

- [ ] **Startup file association:** Open each fixture with MDedit from Finder and confirm both appear once in the expected tab order.
- [ ] **Second-instance open:** With MDedit already running, open the other fixture from Finder and confirm the existing window gains one tab and becomes focused.
- [ ] **Normal quit:** Quit with clean tabs, choose Cancel once, then Close; relaunch and verify the saved session state.
- [ ] **Forced termination:** Make distinct unsaved edits in two tabs, force quit MDedit, relaunch, and verify both edits, tab order, active tab, and workspace state restore.
- [ ] **External edit:** Change an open file with another editor, edit it in MDedit, save, and verify Reload Disk Version, Keep Editing, and Save Editor Version As are offered without overwriting unexpectedly.
- [ ] **File deletion:** Delete an open file externally, attempt to save it, and verify the tab remains open and can be saved to a new location.
- [ ] **Recovery-directory failure:** Make the recovery-data directory unwritable, edit a document, and verify a visible persistence failure identifies the recovery location and retry remains possible after permissions are restored.

## Linux

- MDedit version:
- Operating-system version:
- Package or executable tested:
- Result (Pass / Fail / Blocked):
- Recovery-data location (from recovery error details or the app-data directory):
- Tester and date:
- Notes / evidence:
- End-to-end 5 MiB recovery checkpoint duration (JS serialization + IPC + native disk, ms; read `window.__MDEDIT_RECOVERY_PERFORMANCE__` in the packaged app):

- [ ] **Startup file association:** Open each fixture with MDedit from the desktop file manager and confirm both appear once in the expected tab order.
- [ ] **Second-instance open:** With MDedit already running, open the other fixture from the file manager and confirm the existing window gains one tab and becomes focused.
- [ ] **Normal quit:** Close the window with clean tabs, choose Cancel once, then Close; relaunch and verify the saved session state.
- [ ] **Forced termination:** Make distinct unsaved edits in two tabs, terminate the MDedit process, relaunch, and verify both edits, tab order, active tab, and workspace state restore.
- [ ] **External edit:** Change an open file with another editor, edit it in MDedit, save, and verify Reload Disk Version, Keep Editing, and Save Editor Version As are offered without overwriting unexpectedly.
- [ ] **File deletion:** Delete an open file externally, attempt to save it, and verify the tab remains open and can be saved to a new location.
- [ ] **Recovery-directory failure:** Make the recovery-data directory unwritable, edit a document, and verify a visible persistence failure identifies the recovery location and retry remains possible after permissions are restored.
