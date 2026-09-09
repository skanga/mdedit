# Persistent app-wide compatibility saving

## Approved behavior

The user selected an app-wide setting rather than permanent per-file approvals. Add **Editor → Allow compatibility saving** to the desktop preferences. It is off by default, warns before enabling, survives restarts, and can be disabled. Turning it off clears prior session approvals and restores the existing per-file confirmation behavior.

The setting authorizes only the existing native compatibility path after the backend requests consent. It never forces compatibility on an ACL-capable filesystem, skips the native preflight, removes the expected-digest guard, or permits direct overwrite/delete-then-rename. No native save API or Rust behavior needs to change.

## Implementation design

- `SessionController`: add a boolean setter for app-wide permission, default false. Only skip the per-file dialog after a valid `compatibility-required` response. Continue sending the exact resolved path and captured digest/content. Turning the setting off clears cached paths and invalidates outstanding per-file consent dialogs. It cannot cancel a write already submitted to native code.
- `editor-enhancements.js`: add a desktop-only preference through narrow injected callbacks (update controller, confirm enabling, report persistence error). Use a dedicated `mdedit-allow-compatibility-saving-v1` localStorage key so ordinary editor preference writes cannot accidentally restore this security-related choice. Only the exact stored value `1` means enabled.
- Initialize the controller from the stored choice before user save actions are available. Missing, invalid, or unreadable storage defaults off.
- Enabling: show an app-wide warning with Cancel focused by default; explain folder-default temporary permissions, ownership/access-ACL changes and potentially broader readability. State that the choice applies to all eligible files and survives restarts. Persist the choice before enabling it in memory. Cancel or persistence failure leaves existing choices unchanged.
- Disabling: turn it off in memory and clear session approvals immediately, then remove the stored opt-in. If persistence fails, report that the setting is off for this session but may return after restart; never silently claim the change was saved.
- Disable the checkbox while its confirmation is pending. Do not show this setting in the plain-browser editor, whose save path is unaffected.
- `index.template.html`: wire preference callbacks to the controller and existing dialog/status UI. Regenerate built HTML rather than editing it by hand.

## Verification checklist

- [x] Controller: default behavior unchanged; app-wide choice works across documents and Save As, preserves tokens/digests and ordinary errors/conflicts, clears session approvals when disabled, and rejects stale dialog approval after disable.
- [x] Browser: checkbox default off; cancel and enable warning behavior; persistence across reloads; saves of multiple paths without repeated prompts; disabling restores prompts; invalid/unavailable storage and failed preference writes; no checkbox in plain browser.
- [x] Frontend/unit: 353 passed. Browser: 70 passed. Native regression: 98 passed, with one separate performance diagnostic ignored. Formatting and diff checks passed; generated HTML rebuilt; preference/warning screenshots visually inspected. Native code is unchanged; the new UI has not run in Windows release CI. No version bump, push, or release performed.
