# Tabbed multi-document editor requirements

## 1. Purpose

Convert MDedit from a single-document editor into a tabbed multi-document editor. MDedit must restore the complete working session after a normal restart, application crash, or system interruption while keeping all document data local.

This document defines product behavior, persistence, failure handling, performance, accessibility, and acceptance criteria for this phase.

## 2. Definitions

- **Document**: One Markdown text buffer shown in a tab.
- **Saved document**: A document associated with a filesystem path.
- **Untitled document**: A document that has not been assigned a filesystem path.
- **Dirty document**: A document whose current content differs from its last successfully saved content.
- **Session**: The ordered tabs, active tab, document recovery data, and remembered workspace state.
- **Recovery snapshot**: MDedit's private local copy of document content and state used to restore a session.
- **Content fingerprint**: A value used to determine whether document content has changed since MDedit last read or wrote it.
- **External change**: A change, move, or deletion made to a saved document outside MDedit.
- **Canonical filesystem path**: An absolute, normalized path compared according to the host filesystem's case-sensitivity rules after resolving aliases that the platform exposes to MDedit.

## 3. Product principles

1. A user must be able to work with multiple documents in one MDedit window.
2. Switching documents must not lose document content or workspace state.
3. A normal application exit must not lose changes.
4. Recovery must preserve unsaved documents and unsaved edits to saved documents.
5. MDedit must never silently overwrite an externally changed file.
6. Documents, recovery snapshots, and session metadata must remain on the user's device.

## 4. User interface

### 4.1 Layout

The existing toolbar remains at the top of the window. It contains document commands and the Edit, Split, and Preview controls.

A tab strip appears directly below the toolbar. The active document workspace appears below the tab strip. Depending on the active document's view mode, the workspace contains the Markdown source editor, the rendered document, or both.

```text
+---------------- Toolbar: New | Open | Save | Export | View controls -------------+
| document.md *  | notes.md  | Untitled 2 *  | +                                  |
+-----------------------------------------------------------------------------------+
|                         Active document workspace                                |
|              Markdown editor, rendered document, or both                         |
+-----------------------------------------------------------------------------------+
```

The asterisk in this diagram represents the visual dirty indicator. The implementation may use a dot or another accessible visual treatment consistent with the existing interface.

### 4.2 Tab presentation

Each tab must show:

- The document's filename or untitled name.
- Whether the document is dirty.
- A close control with an accessible name that identifies the document.
- A selected state that is visually distinct and exposed to assistive technology.

The tab strip must include a control for creating a new document. Tabs must remain usable when they exceed the window width. The tab strip may scroll horizontally, but the active tab and new-document control must remain reachable by keyboard.

### 4.3 Active-document commands

Save, Save As, export, find and replace, table of contents, Edit, Split, Preview, and document statistics must apply to the active document only. Save All is the only command that operates on every dirty document.

The window title must identify the active document and indicate when it is dirty.

## 5. Document lifecycle

### 5.1 Create

1. New must create and activate an untitled tab.
2. Untitled names must be unique within the session, such as `Untitled 1`, `Untitled 2`, and `Untitled 3`.
3. Closing the last tab must create and activate a fresh untitled tab. The document workspace must never remain empty.

### 5.2 Open

1. Open, drag and drop, and operating-system file launches must support opening one or more Markdown files in one action when the initiating platform operation supplies multiple files.
2. Each successfully read file must open in a tab.
3. The last successfully opened file must become active.
4. If a canonical filesystem path is already open, MDedit must activate the existing tab instead of opening a duplicate.
5. A failure to read one file must not prevent other selected files from opening.
6. A read failure must identify the affected file and must not create a broken tab.
7. Files received while MDedit is starting must join the restored session without replacing its tabs.

### 5.3 Switch and reorder

1. Selecting a tab must capture the outgoing document's state before displaying the incoming document.
2. Each document must retain independent content, dirty state, selection, scroll positions, view state, and find state while the application is running.
3. Users must be able to reorder tabs by drag and drop.
4. Reordering must preserve the active document.
5. Restoring a session must preserve tab order.

### 5.4 Save

1. Save must write only the active document.
2. Save on an untitled document must request a destination.
3. Save As must request a destination and associate the active tab with the chosen path after a successful write.
4. A successful save must update the filename, filesystem path, saved-content fingerprint, dirty state, recovery snapshot, and window title.
5. A canceled destination picker must leave the document open and unchanged.
6. A failed write must keep the document dirty and identify the document and failure.
7. Save must check for an external change before overwriting an existing path.

### 5.5 Save All

1. Save All must process every dirty document.
2. MDedit must request a destination for each dirty untitled document.
3. A canceled destination picker or failed write must stop Save All.
4. Documents saved before the interruption remain saved. MDedit must keep every unsaved or failed document open and dirty.
5. The result must identify which documents remain unsaved.

### 5.6 Close a tab

1. Closing a clean tab must be immediate.
2. Closing a dirty tab must present Save, Don't Save, and Cancel.
3. Save must close the tab only after a successful write.
4. Don't Save must explicitly discard that tab's unsaved content and remove its recovery data after the updated session is safely persisted.
5. Cancel or a failed save must leave the tab open and dirty.
6. If the closed tab was active, MDedit must activate an adjacent tab.

### 5.7 Quit the application

Every application-close request must show one consolidated confirmation.

If every document is clean, the confirmation must offer **Close** and **Cancel**. Close must persist the latest session state before closing; Cancel must return to the editor.

If one or more documents are dirty, MDedit must show one consolidated confirmation with these actions:

- **Save All & Quit**: Save every dirty document, requesting destinations for untitled documents, and quit only if all saves and the final session persistence succeed.
- **Quit and Restore Next Time**: Persist all dirty content and state to recovery storage, then quit without writing the document files.
- **Discard All & Quit**: Explicitly discard every unsaved edit, remove its pending recovery data after the updated session is safely persisted, and quit.
- **Cancel**: Return to the editor without closing the window.

MDedit must stop quitting if a save, destination selection, or required recovery write fails. It must not show a separate quit confirmation for every dirty tab.

## 6. Remembered state

### 6.1 Session state

MDedit must remember:

- Tab order.
- Active tab.
- The next untitled-document number needed to avoid duplicate names.
- The version of the persisted session format.

### 6.2 Per-document state

MDedit must remember for every open document:

- Stable internal document ID.
- Filesystem path, when assigned.
- Display name.
- Current Markdown content.
- Last successfully saved content fingerprint.
- Last-known on-disk fingerprint and available file metadata.
- Dirty state derived from current and last-saved content.
- Cursor position and selection range.
- Markdown editor scroll position.
- Preview scroll position.
- Edit, Split, or Preview mode.
- Table-of-contents visibility.
- Whether find and replace is open, its query and replacement text, and its current match index. If that index is invalid after restoration, MDedit must select the first current match or show no match.

If a saved document's selection or scroll position is outside the restored content, MDedit must clamp it to a valid position.

### 6.3 Application-wide state

Theme and reader settings remain application-wide preferences. Changing one of these settings affects all tabs and survives application restarts.

### 6.4 Undo history

Each open document must have independent undo and redo behavior while the application remains running. Restoring undo and redo history after an application restart is outside this phase.

## 7. Persistence and recovery

### 7.1 Required component boundaries

The implementation must separate these responsibilities even if they remain in one frontend bundle:

- A document model owns one document's content, file identity, dirty state, and remembered workspace state.
- A session coordinator owns the ordered document collection, active-document identity, lifecycle commands, and quit flow.
- A persistence adapter stores and restores versioned session metadata and per-document recovery snapshots through the native Tauri boundary.
- The editor, preview, tabs, dialogs, and toolbar render session state and issue commands without becoming the authoritative store for document data.

On an edit, the active document model changes first, then the visible workspace updates, then persistence is scheduled. On a tab switch, the outgoing workspace state is captured before the incoming document model is rendered. Filesystem reads and writes pass through the native bridge and update session state only after they succeed.

### 7.2 Storage

1. Recovery snapshots and session metadata must use MDedit's local application-data directory.
2. Multi-document recovery must not depend on browser `localStorage` capacity.
3. Session data must have an explicit schema version.
4. MDedit must migrate any older session schema explicitly supported by the release or preserve it and start with a safe fallback. It must never delete unreadable recovery data automatically.
5. Persistence must use atomic replacement so an interrupted write cannot destroy the last valid snapshot.
6. The previous valid snapshot must remain available until its replacement succeeds.

### 7.3 Legacy draft migration

On the first launch with no multi-document session, MDedit must check for the existing `mdedit-draft-v1` local-storage draft. If a valid legacy draft exists, MDedit must import it as one tab and safely persist the new session before removing the legacy value. An invalid legacy draft must remain untouched and must not prevent startup.

### 7.4 Write policy

1. MDedit must persist only a changed document rather than rewriting every document in the session.
2. After typing stops, MDedit must persist the changed document within 1 second.
3. During uninterrupted typing, MDedit must checkpoint the changed document at least once every 10 seconds.
4. MDedit must persist small structural and metadata changes immediately, including tab creation, tab closure, tab reordering, active-tab changes, and file-path changes.
5. MDedit must flush pending document and metadata changes when the user switches tabs, the window loses focus, or the application begins a normal quit or restart.
6. MDedit must skip a content write when the content fingerprint has not changed.
7. Persistence must not block typing or tab switching.

A normal quit or restart must lose no acknowledged edits. A sudden process or system failure may lose no more than 10 seconds of uninterrupted typing. When the user pauses for at least 1 second before the failure, all edits made before that pause must be recoverable.

### 7.5 Startup restoration

On startup, MDedit must:

1. Load the most recent valid session metadata.
2. Restore every tab in its saved order, including untitled documents and unsaved edits to saved documents.
3. Restore each document's remembered state.
4. Restore the active tab.
5. Check saved documents for external changes without discarding the recovery snapshot.
6. Add files supplied by the operating-system launch after the restored tabs, applying the duplicate-path rule.
7. Create a fresh untitled document only if no valid restorable tab exists.

MDedit must not require a recovery prompt when the session is valid. Restoration is the normal startup behavior.

## 8. External filesystem changes

1. MDedit must compare a saved document's current on-disk state with its last-known state before saving and during restoration.
2. If the file changed externally, MDedit must preserve the editor version and the disk version until the user chooses an action.
3. MDedit must not silently overwrite either version.
4. The conflict interface must allow the user to reload the disk version, keep editing the recovered editor version without writing it, or save the editor version to another path.
5. Reloading the disk version when the editor version is dirty must require explicit confirmation that the editor changes will be discarded.
6. If the file was moved or deleted, the tab and its recovered content must remain available. Save must request a new destination.
7. Conflict or missing-file status must be visible on the affected tab and announced accessibly.

Automatic merging and background file watching are not required. The required checks occur during startup restoration and before a write to the existing path.

## 9. Keyboard and accessibility requirements

1. Users must be able to create, open, save, switch, reorder, and close documents without a pointing device.
2. `Control+Tab` and `Control+Shift+Tab` must select the next and previous tabs on every supported platform.
3. `Ctrl+W` on Windows and Linux, or `Command+W` on macOS, must request closure of the active tab rather than closing the application window directly.
4. Existing New, Open, Save, Save As, and Find shortcuts must continue to work on the active document.
5. `Alt+Shift+Left Arrow` and `Alt+Shift+Right Arrow` must move the active tab one position left or right. At either end, the command must leave the tab in place.
6. Tabs must expose tab-list, tab, selected, position, and controlled-panel semantics to assistive technology.
7. Keyboard focus must remain visible. Activating a tab must place focus predictably without destroying the document's remembered selection.
8. Close controls, dirty indicators, conflicts, persistence failures, and save results must have text or accessible-name equivalents and must not depend on color alone.
9. Status and error messages must be announced through an appropriate live region without interrupting ordinary typing.

## 10. Performance and capacity

MDedit must support a session containing at least 50 open documents of up to 5 MB of Markdown each.

Under that workload:

- In the project's documented performance-test environment, at least 95 percent of already-loaded tab selections must update the visible editor workspace within 100 ms across a run of at least 200 selections after a warm-up selection.
- Expensive preview rendering may complete asynchronously after the editor workspace appears.
- Typing, tab switching, and tab reordering must remain responsive while persistence occurs.
- Persistence work must be bounded to changed documents and metadata.

The 5 MB limit is an acceptance-test size, not a file-size rejection threshold. MDedit may open larger files but does not guarantee the same responsiveness for them.

## 11. Privacy and security

1. Documents, session metadata, and recovery snapshots must remain local.
2. This phase must not add accounts, telemetry, cloud sync, remote rendering, or remote document transmission.
3. Recovery filenames must not allow document names or paths to escape the application-data directory.
4. User-controlled content and filenames must be treated as data when rendered in tabs, dialogs, and status messages.
5. Existing Markdown sanitization and external-link protections must continue to apply independently to each document.

## 12. Failure handling

1. If recovery storage is unavailable, MDedit must warn the user that session recovery is not functioning.
2. MDedit must not offer Quit and Restore Next Time as a successful action unless the required recovery write succeeds.
3. A corrupt current snapshot must not prevent MDedit from attempting the previous valid snapshot.
4. If no snapshot can be read, MDedit must start with a fresh untitled document and identify the preserved recovery-data location for diagnosis.
5. A failure affecting one tab must not discard or reset other tabs.
6. Errors must identify the affected document and the action that failed.

## 13. Acceptance criteria

The phase is complete when automated tests and desktop integration checks demonstrate all of the following:

1. Users can create, open, select, reorder, save, Save As, Save All, and close multiple documents.
2. Opening the same canonical path twice produces one tab and activates it.
3. All active-document commands operate on the selected tab and do not mutate other tabs.
4. Each tab retains independent content, dirty state, selection, scroll positions, view mode, table-of-contents state, and find state.
5. Normal restart restores clean, dirty, saved, untitled, missing, and externally changed documents in the correct order and restores the active tab.
6. Forced termination recovery meets the 1-second idle and 10-second continuous-typing guarantees.
7. Closing a dirty tab implements Save, Don't Save, and Cancel correctly.
8. Every application close shows one consolidated confirmation: clean sessions offer Close and Cancel; dirty sessions offer Save All & Quit, Quit and Restore Next Time, Discard All & Quit, and Cancel.
9. Save failures and canceled destination pickers stop destructive close or quit actions.
10. External changes never result in a silent overwrite.
11. A corrupt or interrupted persistence write leaves a previous valid snapshot recoverable.
12. The 50-document, 5-MB-per-document capacity and 100-ms loaded-tab-switch target are verified.
13. Tab navigation, focus, labels, state, and status announcements pass keyboard-only and assistive-technology-oriented tests.
14. Existing Markdown editing, rendering, export, native file handling, theme, and reader features continue to pass their regression tests.

## 14. Out of scope

- Split editor groups or multiple tab rows.
- Multiple application windows sharing one session.
- Cloud sync or cross-device session transfer.
- Real-time collaboration.
- File-tree or project navigation.
- Pinned tabs, tab groups, and recently closed tabs.
- Restoring undo and redo history after restart.
- Automatic merging of editor and externally changed content.
- Continuous filesystem watching.
- Changing the existing Markdown feature set or export formats.
