# Explicit filesystem compatibility saves

## Approved change

The user approved replacing v0.3.8's blanket refusal with an explicit compatibility mode: preserve permissions where supported, but permit native permission/ownership changes after consent where preservation cannot be guaranteed. This supersedes the previous requirement to reject every non-ACL existing-file save. No direct-overwrite or delete-then-rename fallback is permitted. Windows/provider execution may occur in GitHub Actions rather than locally.

## Interaction

The default per-file interaction below remains available. The user subsequently approved a separate [persistent app-wide setting](2026-09-09-persistent-compatibility-setting.md); only that explicit opt-in can persist, while per-path approvals remain session-scoped.

A save that passes its initial content guard but would replace an existing file on a filesystem without Windows ACLs returns `compatibility-required` before creating a temporary file. The result carries the exact resolved destination as `compatibilityPath` (case preserved).

The controller asks whether to use compatibility saving for that file for this application session. The warning explicitly says temporary files use folder-default permissions, and the replacement may change permissions, ownership, or access ACLs and expose the file more broadly. Cancel is the default; confirmation is explicit. No choice is persisted to recovery or browser storage.

A confirmed retry sends `compatibilityPath` with the same captured content and original expected digest. The backend re-resolves the destination and accepts consent only for an exact path match. Existing digest guards run again; changed content yields conflict, not an unchecked overwrite. Subsequent saves still preflight capabilities; a matching session approval can avoid repeating the dialog. Save As to another path requires separate approval if replacement is needed. New-file creation requires no compatibility consent.

A canceled/disposed/stale operation does not write, advance the saved baseline, close a dirty tab, or report success. Save All stops on cancellation. If the destination changes again during the confirmation retry, do not loop or silently transfer approval.

## Native behavior

- ACL-capable filesystem: unchanged security-descriptor preparation and `ReplaceFileW` recovery, even when consent was supplied.
- No persistent Windows ACLs + no matching consent: structured consent request, no temporary file created.
- No persistent Windows ACLs + matching consent: temporary file with native folder defaults; write and flush; final conflict guard; close temporary handle; `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` in the same directory, without copy-emulation flags.
- Failed capability query, access denied, unsupported flush, sharing violation, and publication failure are errors, never triggers for a second strategy.
- Classify the destination after compatibility publication. Report success only if editor bytes are present after an API success. On error, retain the original API error and known recoverable temporary, report observed state, and do not issue another destructive operation.
- Compatibility publication has no backup artifact. Never pretend a `ReplaceFileW` backup was created. Never remove a third-party temporary merely because the destination contains editor bytes.
- Keep native Linux/macOS saves unchanged. Do not claim provider crash durability or atomic compare-and-swap semantics.

## Working checklist

- [x] Add native policy and outcome regression tests; implement consent-aware preparation and rename publication.
- [x] Add controller tests for confirmation, cancellation, session scope, conflicts, stale captures, and Save As; implement the shared consent flow.
- [x] Change WSL provider tests to require a real confirmed round trip, rather than accepting refusal as success.
- [x] Update current documentation and regenerate frontend bundles with the build script.
- [x] Run local native/frontend/browser checks and review the diff. Local results: 98 Rust, 347 frontend, and 64 browser tests passed. A Windows API probe succeeded on both UNC and mapped WSL fixtures and demonstrated mode changes from 0600 to 0644. Compiled Windows Rust execution remains pending CI; no release was performed.
