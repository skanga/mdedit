# Filesystem-aware saving design

## Status and scope

The user approved capability-based Windows saving with no direct-overwrite fallback and approved the proposed design in conversation. This document records that design for review before the detailed implementation plan. No implementation is included.

**Goal:** Allow safe document saves through Windows filesystem providers such as the WSL bridge while preserving existing native Windows save protections.

**Non-goals:** Direct writes to an existing destination, delete-then-rename replacement, invoking WSL subprocesses to perform production saves, generic network filesystem support claims, unrelated document-I/O refactoring, and changing native Linux/macOS save behavior.

## Evidence and limits of the diagnosis

The reported destination is on `U:`, mapped to `\\wsl.localhost\Ubuntu-24.04`.

In `src-tauri/src/document_io.rs`:

- `write_temporary_with_hooks` wraps every `open_temporary_file` error as a temporary-creation failure.
- Windows `open_temporary_file` first calls `read_document_security_descriptor`, which uses `GetFileSecurityW`, then creates a temporary file with that descriptor via `CreateFileW`.
- Windows replacement uses `ReplaceFileW` and `complete_replacement`; new-document publication uses `MoveFileExW` without replacement permission.
- `save_document_path_with_identity_hooks` fingerprints before writing and immediately before publication. It preserves missing/conflict outcomes and retains certain recovery files after errors.

Consequently, the message does not identify the failing Windows API. Unsupported security operations are a hypothesis, not a reproduced root cause. Diagnostic and provider-validation work must precede enabling a compatibility strategy.

## Safety contract

1. Never open an existing destination for truncation or content writing.
2. Never remove or move aside the existing destination merely to make room for publication. Existing recovery of partial `ReplaceFileW` outcomes remains supported.
3. Create unique temporary files in the resolved destination directory with exclusive creation, write all bytes, and successfully flush before publication.
4. Preserve current external-change checks and exclusive new-file publication. Document the existing check-to-rename race; do not claim compare-and-swap semantics.
5. Preserve native Windows ACL behavior on ACL-capable filesystems. Do not silently omit ACL handling when its outcome is unknown.
6. Native permission behavior is a separate requirement from Windows ACL capability. No-Windows-ACL does not mean no access controls.
7. Access denied, sharing violations, read-only state, disk-full conditions, disconnected providers, and unexpected errors must not activate a weaker strategy.
8. Unknown capabilities or inability to preserve required security or perform safe replacement cause an actionable failure.
9. A replacement error can have side effects. Classify the destination and remaining copies before any recovery action; do not blindly retry through a different strategy.
10. Do not delete third-party files or the only known recoverable copy. Report retained paths when recovery cannot be completed.
11. Do not promise crash durability or atomicity beyond documented provider semantics. Successful disposable-fixture tests alone cannot prove crash safety.

## Architecture

Keep conflict detection, document identities, save results, and recovery orchestration in `src-tauri/src/document_io.rs`.

Introduce a narrowly scoped Windows save-policy module at `src-tauri/src/document_io/windows_save.rs`. It owns capability inspection, policy selection, Windows security preparation, and platform publication primitives. Avoid moving unrelated read/path/fingerprint code. Policy decisions should be pure and injectable so their error classification can be tested without a WSL installation.

Evaluate the resolved target filesystem, using its containing directory for a new destination. Drive letters, UNC spelling, and provider names are diagnostic context, not the decision rule. Inspect advertised volume capabilities through documented Windows APIs and distinguish a supported result from an inspection failure. A volume security flag is evidence about Windows ACL support, not evidence that replacement or Linux permission preservation works.

Inspect per save initially; do not add a drive-letter cache that can become stale after remapping or reconnection. Recheck any facts necessary at publication; queries do not eliminate mount or metadata races.

### Policy outcomes

| Evidence | Outcome |
| --- | --- |
| Windows persistent ACLs supported | Existing security-descriptor preparation and `ReplaceFileW`/recovery strategy |
| Windows ACLs explicitly absent, compatible security and safe replacement established | Same-directory native-permission temporary file and validated rename-replacement strategy |
| Capability inspection fails, facts conflict, or compatible publication/security is unavailable | Stop with contextual error; no downgrade |

The compatibility path is selected before destination mutation. Unsupported error codes must be interpreted by operation and corroborating capability evidence; Windows error 1 alone is not authorization to omit security protections.

There is no generic Windows volume flag proving safe overwrite-rename support. The implementation plan must begin with a bounded provider experiment to choose a documented primitive and establish the compatibility path's preconditions. If those preconditions cannot be satisfied, that provider remains unsupported with a clear error; weakening this contract requires a new design decision.

## Temporary-file and metadata behavior

On ACL-capable volumes, preserve the current rule that the original security descriptor is prepared before a visible temporary file is created. Genuine descriptor or creation failures remain fatal.

On compatible non-Windows-ACL providers, use native permission behavior only after establishing that the temporary file does not expose document content more broadly and that publication does not broaden destination access. Validate existing Linux modes, ownership/group, and access ACL behavior where available, including a restrictive original inside a permissive parent. Ordinary inherited defaults are not automatically equivalent to the original's permissions.

For cases where required permissions cannot be observed or preserved safely through the available interface, refuse replacement and explain the limitation. Do not treat successful saving of an ordinary default-mode WSL fixture as proof that every WSL document is supported.

## Publication and recovery

Continue using `ReplaceFileW` and its existing backup-aware recovery on ACL-capable filesystems.

For the compatibility path, choose a documented same-filesystem rename-replacement primitive only after the provider experiment establishes its behavior. Do not enable cross-volume copy emulation or any destination deletion. Retain the existing final digest guard immediately before publication.

Keep new-document publication exclusive; an existing file or dangling leaf symlink must not be overwritten.

Use identity-based outcome classification for both strategies. Compatibility recovery must model its actual artifacts rather than pretending a `ReplaceFileW` backup exists. If an error leaves an unreadable or unexpected destination, retain identifiable candidates and report uncertainty. Do not run the native strategy first and then try compatibility replacement against potentially changed state.

## Diagnostics and public interface

Keep the existing `SaveDocumentResult` schema and frontend dirty-state behavior. Improve backend error context so the existing status display identifies:

- capability inspection;
- security-descriptor reading or validation;
- temporary-file creation;
- permission preparation;
- temporary writing or flushing;
- replacement/publication;
- recovery and retained paths.

Preserve the Windows API name, raw OS code, and underlying error text through context wrapping. Distinguish unsupported safe saving from permission denial. Never report a save as successful solely because the temporary write succeeded.

## Validation and acceptance

### Automated policy and failure tests

Cover supported/absent/unknown ACL capabilities; capability-query failure; operation-specific unsupported errors; access denied and sharing violations; security preparation before creation; temporary write/flush failure; and prevention of strategy switching after publication starts.

Retain and extend existing tests for conflicts, missing documents, exclusive new saves, symlinks, permission preservation, partial replacement, third-party destinations, and recovery cleanup. Assert that forbidden destructive operations are never requested by injected adapters. Assert diagnostic stages and original OS codes.

### Windows integration matrix

Use disposable fixture directories and a Windows-native test binary. Running Linux Rust tests inside WSL does not exercise the failing Windows code path.

- Native NTFS: existing/new saves, restrictive and protected ACLs, inheritance, read-only and denied operations.
- WSL Ubuntu: both mapped drive and direct UNC access; include `\\wsl.localhost` and available `\\wsl$` aliases to the same fixture.
- WSL metadata: default permissions, mode `0600` under a permissive directory, executable bits, ownership/group, and access ACLs where available. Verify before/after from Linux and test visibility while the temporary exists.
- One available non-ACL filesystem such as a disposable FAT/exFAT volume: existing/new saves and unsupported/error behavior.
- Injected failure cases: write, flush, publication, unreadable outcome, and conflicting third-party changes.

Record observed capability flags, exact failing APIs/codes, chosen strategy, content results, metadata results, and retained artifacts. Provider tests may be opt-in; missing infrastructure must be reported as skipped, not as validation. Current `.github/workflows/desktop.yml` already runs native Cargo tests on Windows, Linux, and macOS; preserve that coverage.

Acceptance requires Windows-native NTFS regression success, Windows-to-WSL saving for demonstrated safe cases through both mapped and UNC paths, explicit safe rejection of cases whose security cannot be preserved, and all existing document-I/O tests passing. Do not claim general SMB/NAS compatibility without provider-specific evidence.

## Implementation-plan sequence

1. Add precise diagnostic boundaries and a disposable Windows provider-validation harness; identify the actual reported failure and validate candidate APIs and permission behavior.
2. Add the capability model, pure selection tests, and Windows inspection adapter.
3. Integrate capability-aware security preparation and temporary creation with failure-injection tests.
4. Integrate only the validated compatibility publication primitive and its artifact-aware recovery tests.
5. Exercise the full native and provider matrix, document limitations and how to run opt-in tests, and verify unchanged frontend/save-result behavior.

Use test-first implementation steps and small reviewable commits. If stage 1 demonstrates that safe WSL security preservation cannot be achieved within these constraints, report that result and revisit the design rather than implementing a weaker fallback.
