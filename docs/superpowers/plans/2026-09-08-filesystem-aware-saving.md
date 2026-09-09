# Filesystem-aware Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable safe capability-based Windows saving on validated filesystems, including WSL where its security guarantees can be preserved, without direct overwrite or delete-then-rename fallback.

**Architecture:** Keep document conflicts, fingerprints, save results, and recovery orchestration in `document_io.rs`; isolate Windows capability and publication mechanics in a child module. Select a strategy before publication, preserve native ACL-aware saves, and reject unknown or unsafe cases. A mandatory Windows/provider experiment precedes compatibility enablement: lack of Windows ACL support alone never authorizes replacement.

**Tech Stack:** Rust, `windows-sys` 0.61, Windows filesystem/security APIs, Tauri 2, `tempfile`, Cargo tests, Windows PowerShell, Linux `stat`/`getfacl` for independent WSL validation.

---

## Approved input and execution boundary

**Historical plan:** the user subsequently approved an explicit, session-scoped compatibility save option instead of blanket refusal. See `docs/superpowers/specs/2026-09-09-wsl-compatibility-mode.md` and the current validation guide. The original preservation gate below documents the v0.3.8 decision, not the current opt-in policy.

Read `docs/superpowers/specs/2026-09-08-filesystem-aware-saving-design.md` completely before execution.

This is a **gated implementation plan**, not a claim that a safe generic WSL replacement primitive has already been established. Tasks 1–3 produce diagnostic evidence and an explicit proceed/stop decision. Tasks 4–7 describe the implementation contracts and regression tests if that decision is positive. Their provider-specific adapter must be finalized against the experiment's documented API results before coding it. Do not invent a security adapter just to complete a checklist.

If Windows APIs cannot observe/preserve the required Linux security metadata, stop and report that the approved contract cannot currently support that case. Diagnostics and fail-closed selection are useful partial progress, but they do **not** complete the WSL-saving feature. Changing the security contract requires user approval.

No production WSL subprocesses, blanket suppression of OS error 1, provider-name allowlists, direct writes to an existing destination, or delete/move-aside-then-rename sequence are permitted.

## Files and responsibilities

| File | Responsibility/change |
| --- | --- |
| `src-tauri/src/document_io.rs` | Stage-specific errors; save-context integration; existing digest guards and recovery; regression tests |
| `src-tauri/src/document_io/windows_save.rs` (new) | Pure policy, Windows capability inspection, security preparation, and platform primitives |
| `src-tauri/src/document_io/provider_tests.rs` (new) | Ignored Windows-native disposable-fixture tests; can access parent-private helpers without public production APIs |
| `src-tauri/Cargo.toml` | Add `windows-sys` feature gates only if the chosen documented APIs require them |
| `src-tauri/Cargo.lock` | Update only if dependency resolution actually changes |
| `docs/testing/filesystem-aware-saving.md` (new) | Provider experiment, exact commands, results/limitations, manual security validation |
| `tools/test-native-bridge.js` | Existing frontend save-result/error contract checks; add a regression only if current coverage misses dirty-state preservation |
| `.github/workflows/desktop.yml` | Preserve native tests on all three OSes; opt-in provider tests must not silently become claimed CI coverage |

Do not edit generated `index.html` or `index-lite.html` for backend error wording. No save-result schema or IPC changes are planned.

## Task 1: Establish the baseline and disposable reproduction

**Files:** read `src-tauri/src/document_io.rs`, `src-tauri/Cargo.toml`, `.github/workflows/desktop.yml`; create `docs/testing/filesystem-aware-saving.md`.

- [x] **1.1 Create an isolated implementation worktree.** Inspect existing worktrees first; verify `.worktrees` is ignored. Keep unrelated `mcp-server.log` untouched.

```bash
git status --short
git worktree list
git check-ignore .worktrees
git worktree add .worktrees/filesystem-aware-saving -b feat/filesystem-aware-saving
```

Execute subsequent commands in that worktree. If the branch/directory exists, inspect and reuse only after confirming it belongs to this task; do not delete it.

- [x] **1.2 Run the current baseline.** Install frontend dependencies in the new worktree with `npm ci`, build frontend assets with `bash tools/build-desktop.sh`, then run:

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: both exit 0. Record failures before any implementation. Linux requires the system dependencies already listed in `desktop.yml`. Do not treat Linux tests or Windows cross-compilation as execution of the Windows path.

**Initial checkpoint (2026-09-08):** Steps 1.1–1.2 completed. Frontend: 336 tests passed; Linux native: 82 tests passed, with 1 separate performance diagnostic ignored. Windows cargo/rustc were absent; the Build Tools installer subsequently stopped at UAC.

**User-authorized execution update:** Proceed without local Windows validation; Windows tests may run in GitHub Actions. Local Linux tests remain enabled. Implemented diagnostics, conservative capability-based creation admission, a hosted-Windows round-trip test, and a dispatch-only WSL-provider workflow. Current local results: 90 Rust tests and 336 frontend tests pass; formatting and diff checks pass. Existing-file non-ACL replacement remains safely rejected: no runtime adapter exists to preserve native Linux permissions. This is partial implementation, not completion of Tasks 5–6 or a fix for the original WSL save. The policy intentionally has no speculative `NativeCompatible` branch or caller-supplied validation boolean. See `docs/testing/filesystem-aware-saving.md` for code scope, CI setup, and remaining work.

- [ ] **1.3 Prepare Windows-native execution.** In Windows PowerShell verify `cargo --version`, `rustc -vV`, and `wsl.exe -l -v`. Use a Windows Rust toolchain and a Windows checkout/worktree containing this branch. Record Windows build, Rust target, WSL version and distro. Never test saves on the reported real `usage.md`.

- [ ] **1.4 Create WSL fixtures from Linux.** Use this command in Ubuntu and record the printed directory:

```bash
fixture=$(mktemp -d "$HOME/mdedit-save-probe.XXXXXX")
chmod 0755 "$fixture"
printf 'original\n' > "$fixture/default.md"
printf 'original\n' > "$fixture/private.md"
printf 'original\n' > "$fixture/executable.md"
chmod 0600 "$fixture/private.md"
chmod 0750 "$fixture/executable.md"
stat -c '%n %a %u %g' "$fixture" "$fixture"/*.md
printf 'Fixture directory: %s\n' "$fixture"
```

Add a named-user access ACL fixture with `setfacl` when available and a different-owner/group fixture only when the test environment supports it. Record absent facilities as untested. Do not use `chmod` or `setfacl` on real documents.

- [ ] **1.5 Document before-state and baseline failure.** Open copies of the fixture through mapped `U:` and direct `\\wsl.localhost\Ubuntu-24.04` paths in the Windows app. Record exact save errors and verify original content remains unchanged. Repeat ordinary existing/new saves in a local NTFS scratch directory. Save these observations in the test document, including a table with columns: provider, path form, capability flags, failing API/code, content outcome, security outcome, retained artifacts, validation status.

- [ ] **1.6 Commit documentation only after checking its diff.**

```bash
git add docs/testing/filesystem-aware-saving.md
git diff --cached --check
git commit -m "docs: record filesystem save reproduction and test matrix"
```

## Task 2: Identify the failing operation without changing save policy

**Files:** modify `src-tauri/src/document_io.rs` and its test module.

- [x] **2.1 Add a failing contextual-error test.** Place this in the existing `tests` module:

```rust
#[test]
fn operation_error_preserves_stage_api_and_os_code() {
    let source = io::Error::from_raw_os_error(1);
    let original_kind = source.kind();
    let error = operation_error("read security", "GetFileSecurityW", source);
    assert_eq!(error.kind(), original_kind);
    let detail = error.to_string();
    assert!(detail.contains("read security"));
    assert!(detail.contains("GetFileSecurityW"));
    assert!(detail.contains("os error 1"));
}
```

Run `cargo test --manifest-path src-tauri/Cargo.toml operation_error_preserves_stage_api_and_os_code`. Expected initially: compilation failure for the missing helper.

- [x] **2.2 Add the minimal context helper.** It preserves the original kind and renders the raw code before wrapping; do not use the wrapper's `raw_os_error()` for later capability classification.

```rust
fn operation_error(stage: &str, api: &str, error: io::Error) -> io::Error {
    let code = error.raw_os_error()
        .map(|code| format!("; os error {code}"))
        .unwrap_or_default();
    io::Error::new(error.kind(), format!("{stage}: {api}: {error}{code}"))
}
```

Capability policy must consume raw errors before this display boundary. A custom typed error is unnecessary unless integration requires machine-readable codes beyond it.

- [x] **2.3 Add context at each native boundary.** Keep existing success/error conditions exactly as they are. Replace each bare `last_os_error()` return with the corresponding stage/API wrapper; for example, after the first `GetFileSecurityW` query has rejected all codes except `ERROR_INSUFFICIENT_BUFFER`:

```rust
return Err(operation_error("read security", "GetFileSecurityW(size query)", error));
```

For a failed `CreateFileW`:

```rust
return Err(operation_error(
    "create temporary file", "CreateFileW", io::Error::last_os_error(),
));
```

Use distinct labels for `GetFileSecurityW(descriptor)`, `GetSecurityDescriptorControl`, `ReplaceFileW`, and `MoveFileExW`. Capture the error immediately after the failed API; do not call another Windows function first.

- [x] **2.4 Split temporary write/flush context while retaining one cleanup path.** In the existing `write_result` closure preserve order and use:

```rust
if let Some(permissions) = permissions {
    file.set_permissions(permissions.clone())
        .map_err(|e| operation_error("prepare permissions", "File::set_permissions", e))?;
}
prepare(&file, &temporary)
    .map_err(|e| operation_error("prepare temporary file", "prepare hook", e))?;
writer(&mut file)
    .map_err(|e| operation_error("write temporary content", "writer", e))?;
file.sync_all()
    .map_err(|e| operation_error("flush temporary content", "File::sync_all", e))
```

Do not introduce retry behavior. Existing outer strings may stay for frontend compatibility; the nested context now explains the real boundary.

- [ ] **2.5 Run the focused test and full native suite.** Repeat the fixture save with the Windows build and record the actual failing API/code. Expected: same safe failure, now attributable to a specific operation. Do not proceed on the original ACL hypothesis if the evidence points elsewhere.

- [ ] **2.6 Commit the diagnostic change.**

```bash
git add src-tauri/src/document_io.rs docs/testing/filesystem-aware-saving.md
git diff --cached --check
git commit -m "fix: identify filesystem save operation failures"
```

## Task 3: Validate provider operations and make the compatibility decision

**Files:** create `src-tauri/src/document_io/provider_tests.rs`; modify `src-tauri/src/document_io.rs`; update `docs/testing/filesystem-aware-saving.md`.

- [ ] **3.1 Add an ignored Windows-native fixture harness.** Declare it beside the existing test module:

```rust
#[cfg(all(windows, test))]
mod provider_tests;
```

Start the new module with this test. It exercises the production save API, not a separate implementation of saving:

```rust
use super::*;

#[test]
#[ignore = "requires an explicit disposable Windows-accessible provider root"]
fn provider_existing_save_round_trip() {
    let root = std::env::var_os("MDEDIT_SAVE_TEST_ROOT")
        .expect("set MDEDIT_SAVE_TEST_ROOT to a disposable fixture parent");
    let scratch = tempfile::Builder::new()
        .prefix("mdedit-provider-")
        .tempdir_in(PathBuf::from(root))
        .expect("create provider scratch directory");
    // Retain evidence even on panic; cleanup is explicit after examination.
    let directory = scratch.keep();
    eprintln!("provider fixture retained at {}", directory.display());
    let destination = directory.join("document.md");
    fs::write(&destination, "original").unwrap();
    let initial = read_document_path(&destination).unwrap();
    let result = save_document_path(&destination, "editor", Some(&initial.sha256));
    eprintln!("save result: {result:?}");
    assert!(matches!(result, Ok(SaveDocumentResult::Saved { .. })));
    assert_eq!(fs::read(&destination).unwrap(), b"editor");
}
```

Run in Windows PowerShell, once per target root:

```powershell
$env:MDEDIT_SAVE_TEST_ROOT = 'U:\home\skanga'
cargo test --manifest-path src-tauri/Cargo.toml provider_existing_save_round_trip -- --ignored --nocapture
$env:MDEDIT_SAVE_TEST_ROOT = '\\wsl.localhost\Ubuntu-24.04\home\skanga'
cargo test --manifest-path src-tauri/Cargo.toml provider_existing_save_round_trip -- --ignored --nocapture
```

Use the actual username/home/root from Task 1 if different. Expected before compatibility work: reproduced WSL failure, NTFS success. The test must fail when explicitly invoked without its environment, not silently pass. Run serially when inspecting fixtures.

- [ ] **3.2 Probe advertised capabilities on the resolved directory.** Evaluate documented `GetVolumePathNameW` plus `GetVolumeInformationW`, or directory-handle `GetVolumeInformationByHandleW` where supported. Record which API works for mapped, UNC, extended-length, and new-file-parent paths. A failed query stays unknown; do not substitute zero flags. Record `FILE_PERSISTENT_ACLS` separately from filesystem/provider labels.

Use a nonmutating query first. If an API requires opening a directory, use a directory handle with appropriate sharing and backup-semantics flags and close it through RAII. Reference the Microsoft documentation for the exact chosen API in the evidence document. Neither persistent-ACL absence nor a filesystem name establishes safe rename behavior.

- [ ] **3.3 Probe candidate replacement only on two new scratch files.** Begin with documented `MoveFileExW` using `MOVEFILE_REPLACE_EXISTING`, without `MOVEFILE_COPY_ALLOWED`. Compare it with the current `ReplaceFileW` on separate fixture pairs. Write and sync the candidate before closing its handle and calling the API. Capture raw return/code and inspect all file identities after both success and failure. Do not run a second operation against a failed experiment's paths.

Candidate call for the probe, not authorization for production use:

```rust
let from = windows_path(&temporary);
let to = windows_path(&destination);
let result = unsafe {
    windows_sys::Win32::Storage::FileSystem::MoveFileExW(
        from.as_ptr(),
        to.as_ptr(),
        windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING,
    )
};
let result = if result == 0 {
    Err(io::Error::last_os_error())
} else {
    Ok(())
};
eprintln!("MoveFileExW(replace, no copy): {result:?}");
```

In the probe, `temporary` and `destination` are `PathBuf`s created in the same retained scratch directory. Add a control where the destination must not be replaced and call the existing `publish_new`; assert it leaves the existing bytes intact.

- [ ] **3.4 Validate security before admitting the candidate.** Pause the disposable test after empty temporary creation and again after writing but before publication. Inspect Linux modes, numeric owner/group, `getfacl -p`, and readability by a distinct unprivileged Linux identity where available. Check the `0600` original in a `0755` directory, executable mode, default/access ACLs, read-only conditions, and changed permissions immediately before publication. Verify destination metadata after replacement.

A test-only stdin pause is acceptable for this experiment; production code must not include it. A useful pause block in the ignored harness is:

```rust
eprintln!("Inspect retained fixture now; press Enter to continue.");
let mut answer = String::new();
io::stdin().read_line(&mut answer).unwrap();
```

Windows `fs::Permissions` exposing only a read-only bit is not evidence of Linux mode/ACL preservation. If replacing the file changes its ownership or widens access, reject that strategy for that case. Do not add a post-write chmod repair: exposure may already have occurred.

- [ ] **3.5 Record the go/no-go decision before writing a production compatibility adapter.** The evidence document must specify: exact capability API and flags; documented publication semantics and selected flags; runtime security inspection/preparation mechanism; supported security cases; explicit rejection cases; provider versions tested; and failure-artifact behavior. Include documentation URLs and distinguish empirical observations from guarantees.

**Proceed only if all are true:** the runtime can identify the required capabilities without path-name heuristics; temporary security can be established before content is written; required destination metadata is preserved; same-filesystem replacement does not need deletion/copy fallback; and ambiguous results can retain recoverable copies. If any are false or unobservable, stop compatibility enablement and report the blocker. A manual Linux check is test evidence, not a runtime capability detector.

- [ ] **3.6 Commit the harness and evidence.**

```bash
git add src-tauri/src/document_io.rs src-tauri/src/document_io/provider_tests.rs docs/testing/filesystem-aware-saving.md
git diff --cached --check
git commit -m "test: add explicit Windows filesystem save probes"
```

## Task 4: Isolate a fail-closed capability policy

**Prerequisite:** Task 3's decision is recorded. Implementing the pure policy is safe even when compatibility remains blocked, but do not claim the feature complete in that case.

**Files:** create `src-tauri/src/document_io/windows_save.rs`; modify `src-tauri/src/document_io.rs`.

- [ ] **4.1 Declare the child module on Windows and during unit tests.**

```rust
#[cfg(any(windows, test))]
mod windows_save;
```

Keep Windows imports and FFI functions individually `#[cfg(windows)]`; pure policy tests must run on Linux/macOS.

- [ ] **4.2 Add failing policy tests in the new module.**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acl_capable_keeps_native_strategy() {
        assert_eq!(select_policy(AclSupport::Present, false), Ok(SavePolicy::WindowsAcl));
    }

    #[test]
    fn absent_acl_is_not_sufficient_evidence() {
        assert!(select_policy(AclSupport::Absent, false).is_err());
    }

    #[test]
    fn unknown_never_downgrades() {
        assert!(select_policy(AclSupport::Unknown, false).is_err());
        assert!(select_policy(AclSupport::Unknown, true).is_err());
    }

    #[test]
    fn validated_compatibility_requires_absent_acl() {
        assert_eq!(select_policy(AclSupport::Absent, true), Ok(SavePolicy::NativeCompatible));
    }
}
```

Run `cargo test --manifest-path src-tauri/Cargo.toml windows_save`. Expected initially: missing policy definitions.

- [ ] **4.3 Implement the pure selector.**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AclSupport { Present, Absent, Unknown }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SavePolicy { WindowsAcl, NativeCompatible }

pub(super) fn select_policy(
    acls: AclSupport,
    security_and_replacement_validated: bool,
) -> Result<SavePolicy, &'static str> {
    match (acls, security_and_replacement_validated) {
        (AclSupport::Present, _) => Ok(SavePolicy::WindowsAcl),
        (AclSupport::Absent, true) => Ok(SavePolicy::NativeCompatible),
        (AclSupport::Absent, false) => Err(
            "filesystem lacks Windows ACLs and safe native-security replacement is unavailable",
        ),
        (AclSupport::Unknown, _) => Err(
            "filesystem save capabilities could not be established; refusing unsafe replacement",
        ),
    }
}
```

The boolean is an internal policy input, not a user preference or persisted filesystem property. Production callers must derive it from Task 3's validated runtime preconditions; never pass `true` merely because a WSL test succeeded. If the preconditions cannot be implemented, compatibility must remain unavailable.

- [ ] **4.4 Implement the capability inspection adapter selected by Task 3.** Read capabilities for the resolved directory on every save; keep raw query errors until classification/display. Distinguish successful flags-without-ACL from failed queries. Tests must inject successful ACL flags, successful zero flags, error 1, access denied (5), sharing violation (32), and disconnected-provider errors. Assert each query error rejects selection without attempting temporary creation. Do not add an unsupported-error catch-all or drive-letter cache.

- [ ] **4.5 Move existing Windows-only mechanics without behavioral changes.** Move `windows_path`, `read_document_security_descriptor`, and native creation/publication primitives into the child module, preserving their code and safety comments. Keep identity-based `complete_replacement` in the parent. Use `pub(super)` only for the parent-facing adapter surface. Preserve the existing `with_prepared_security` ordering test. Avoid moving the entire recovery state machine.

- [ ] **4.6 Run focused and full native tests on all supported OSes, then commit.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml windows_save
cargo test --manifest-path src-tauri/Cargo.toml

git add src-tauri/src/document_io.rs src-tauri/src/document_io/windows_save.rs
git diff --cached --check
git commit -m "refactor: isolate fail-closed Windows save policy"
```

## Task 5: Thread one prepared policy through temporary creation and publication

**Files:** modify `src-tauri/src/document_io.rs`, `src-tauri/src/document_io/windows_save.rs`; extend their unit tests.

- [ ] **5.1 Add red ordering tests before changing the save path.** Extend the existing closure-based hooks rather than adding global mocks. Record events in a `RefCell<Vec<&'static str>>`; the expected successful order is:

```rust
let expected = [
    "initial fingerprint",
    "inspect capabilities",
    "prepare empty temporary security",
    "create temporary",
    "write",
    "flush",
    "final fingerprint",
    "revalidate required security",
    "publish selected strategy",
];
assert_eq!(events.borrow().as_slice(), expected.as_slice());
```

Include cases where security must be applied to an empty handle before writing; the assertion must reflect the actual validated API ordering while always keeping content after security. For query/security failure assert no create/write/publication events; for writer/flush failure assert no publication; for final conflict assert temporary cleanup and no publication. Assert no strategy reselection or destination-delete/direct-write events in any trace.

- [ ] **5.2 Prepare the save context after initial conflict checks.** Resolve symlinks first; retain existing early `Missing`/`Conflict` behavior. Use the resolved destination directory for inspection. Keep the selected policy and prepared security material together for the duration of this save. Thread this context into Windows temporary creation and publication; do not independently rediscover a potentially different strategy in each function. Use a narrow Windows-specific context rather than adding fields to serialized `SaveDocumentResult`.

- [ ] **5.3 Integrate the ACL branch first and verify no regression.** Existing security must still be prepared before visible temporary creation. Keep existing `ReplaceFileW` backup naming, flags, recovery, and native error behavior. Native descriptor access-denied must not enter the compatibility branch.

- [ ] **5.4 Integrate only Task 3's validated compatibility security adapter.** For an existing file, establish the required native permissions before content becomes visible and revalidate relevant destination security immediately before publication. For new files, preserve exclusive creation and validated native defaults without pretending an original security descriptor exists. Unobservable or unsupported required security must fail before publication. Do not use default parent permissions as a substitute for a restrictive original.

Before coding this provider-specific step, append its exact API sequence, flags, security representation, and unit-test fixtures from Task 3 to this plan. This is an evidence dependency, not permission to implement a speculative fallback.

- [ ] **5.5 Retain flush and conflict semantics.** `write_temporary_with_hooks` must still flush before the final fingerprint. Do not ignore a provider's unsupported flush; fail with context. Keep `save_document_path_with_identity_hooks` digest checks immediately adjacent to publication, including permission revalidation constraints. Explicitly retain the current non-CAS race limitation.

- [ ] **5.6 Run all native tests, verify NTFS fixtures, and commit.**

```bash
cargo test --manifest-path src-tauri/Cargo.toml

git add src-tauri/src/document_io.rs src-tauri/src/document_io/windows_save.rs
git diff --cached --check
git commit -m "feat: prepare filesystem-aware secure save temporaries"
```

## Task 6: Enable validated rename replacement with artifact-aware recovery

**Prerequisite:** the Task 3 security/publication gate and Task 5 adapter are satisfied. Do not execute this task if the compatibility security contract remains blocked.

**Files:** modify `src-tauri/src/document_io.rs`, `src-tauri/src/document_io/windows_save.rs`, and their tests.

- [ ] **6.1 Add regression assertions using the existing installer hook.** This complete test ensures an unsupported publication cannot become a successful direct overwrite:

```rust
#[test]
fn unsupported_publication_does_not_overwrite_original() {
    let directory = tempdir().unwrap();
    let destination = directory.path().join("document.md");
    fs::write(&destination, "original").unwrap();
    let expected = sha256(b"original");
    let result = save_document_path_with_identity_hooks(
        &destination,
        "editor",
        Some(&expected),
        |file, _| file.write_all(b"editor"),
        |_, _, _, _| Err(io::Error::from_raw_os_error(1)),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"original");
}
```

This is a regression guard and may already pass; do not describe it as a red test for a new adapter. Add adapter-specific red tests that request `NativeCompatible` with injected publication failure and verify exactly one publication call. Reuse existing identities and classification fixtures to cover original/editor/missing/third-party/unreadable outcomes.

- [ ] **6.2 Implement only the documented same-directory replacement primitive chosen in Task 3.** If it is `MoveFileExW`, use replacement permission but no copy-emulation flag, after closing the successfully synced temporary handle. If a different primitive is necessary, document why and its exact flag/handle contract before implementation. Do not force the candidate from Task 3 to work by deleting the destination or ignoring errors. Never try `ReplaceFileW` and then compatibility replacement blindly.

- [ ] **6.3 Implement recovery for actual artifacts.** Keep the `ReplaceFileW` backup-aware state machine unchanged. The compatibility path normally has only temporary and destination; never claim a backup exists. Required outcomes:

| Observed destination after publication | Action |
| --- | --- |
| Editor bytes after API success | Report saved only after classification; clean only known-owned artifacts |
| Original bytes after API success | Report inconsistent result and retain editor candidate |
| Original bytes after API error | Report original error; preserve original; apply existing safe cleanup/retention policy |
| Editor bytes after API error | Report original error plus observed outcome; never blindly retry |
| Missing destination | Retain recoverable candidate; optional recovery publication must be exclusive and followed by identity verification |
| Third-party or unreadable destination | Do not overwrite it; retain known candidates and report their paths |

If exclusive recovery races, inspect the resulting destination; never overwrite a competing file. A missing backup is not itself a compatibility recovery error.

- [ ] **6.4 Extend tests for cleanup and all uncertain outcomes.** Preserve existing `complete_replacement` tests. Assert retained paths refer to real remaining artifacts and that failure diagnostics retain the original API/code. Include an injected API success with unchanged destination and an API failure after editor bytes have appeared. Keep new-document publication no-clobber and symlink conflict behavior.

- [ ] **6.5 Run unit tests and the explicitly invoked Windows provider tests.** Expected: NTFS still passes; WSL passes only for validated supported security cases; unsupported cases fail with an actionable reason and preserved original. Record any skipped provider rather than claiming it passed.

- [ ] **6.6 Commit verified publication changes.**

```bash
git add src-tauri/src/document_io.rs src-tauri/src/document_io/windows_save.rs src-tauri/src/document_io/provider_tests.rs docs/testing/filesystem-aware-saving.md
git diff --cached --check
git commit -m "feat: publish validated filesystem-compatible saves safely"
```

## Task 7: Complete the regression matrix and document support precisely

**Files:** extend `src-tauri/src/document_io/provider_tests.rs`; update `docs/testing/filesystem-aware-saving.md`; inspect `tools/test-native-bridge.js` and `.github/workflows/desktop.yml`.

- [ ] **7.1 Run the automatic regression suite.**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Use the existing three-OS native CI matrix. Do not add ignored provider tests to ordinary CI without provisioning the required provider. Confirm formatting failures are scoped to this change before altering unrelated formatting.

- [ ] **7.2 Run and record the provider/security matrix.** Existing and new documents on NTFS; restrictive/protected/inherited ACLs; read-only and denied access; WSL mapped and UNC paths (`wsl.localhost` and available `wsl$` alias); long/Unicode paths; default/private/executable/ACL/ownership fixtures; optional FAT/exFAT. Repeat the paused temporary-inspection test after integration, not only against the candidate probe.

For every explicit provider test, absence of required setup must fail or be clearly reported as not run. Use only retained scratch directories for cleanup; never recursively delete the environment-supplied parent root.

- [ ] **7.3 Check frontend error behavior.** Run `node --test tools/test-native-bridge.js` and manually trigger a safe rejection in the desktop app. The document remains dirty, the message names the failing stage, and the saved baseline must not advance on an error. Saved/conflict/missing serialization stays unchanged. Add a focused JS regression only if existing tests do not cover this behavior; no visual changes are required.

- [ ] **7.4 Finalize support documentation.** Replace experimental observations with dated actual results while retaining the original reproduction. Explain that mapped/UNC spelling is not a policy switch; some metadata cases may remain unsupported; permission errors never cause fallback; and Windows-side WSL tests are distinct from Linux-native tests. Describe how to locate retained temporary files and preserve unsaved edits via Save As. State existing digest-check race and provider durability limits.

- [ ] **7.5 Review scope and obtain code review before integration.** Inspect the entire diff for forbidden destructive paths, broad error matching, new unchecked unsafe calls, public API changes, lost recovery copies, and accidental weakening of native ACL ordering. Do not merge or release automatically.

```bash
git diff --check
git diff --stat
git status --short
```

- [ ] **7.6 Commit documentation/tests and present verification evidence.** Report exact test commands and results, Windows/WSL versions exercised, unsupported or skipped cases, and whether the full acceptance gate below is met. Do not equate policy tests passing with WSL support.

## Acceptance gate and coverage map

| Approved requirement | Tasks/evidence |
| --- | --- |
| Diagnose actual API, preserve OS code and stage | 1–3 |
| Capability-based, no path heuristics/cache/downgrade | 3–5 |
| Preserve NTFS ACL behavior and temporary security ordering | 4–5, 7 |
| Validate Linux mode/owner/group/ACL and temporary exposure | 3, 5, 7 |
| Same-directory synced temp; no direct overwrite/delete-then-rename | 5–6 and operation-trace tests |
| Existing/new save conflict and symlink safety | 5–7 and current native suite |
| No blind retry after mutation; artifact-aware recovery | 6 |
| Linux/macOS and public save-result behavior unchanged | 4–7 and three-OS/JS tests |
| Windows-native mapped/UNC WSL validation; non-ACL provider coverage | 1, 3, 7 |
| Honest limitations and no unsupported durability claims | 3, 7 |

The feature is complete only when Windows-native NTFS regression tests pass, safe WSL cases actually save through mapped and UNC paths, unsupported security cases fail without damaging originals, and existing native/frontend tests pass. If the provider/security experiment blocks compatibility, present a partial diagnostics result and request a design decision; do not label the WSL error fixed.
