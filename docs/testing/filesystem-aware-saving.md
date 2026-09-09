# Filesystem-aware saving: validation record

## Execution checkpoint — 2026-09-08

Approved design: `docs/superpowers/specs/2026-09-08-filesystem-aware-saving-design.md`.
Approved plan: `docs/superpowers/plans/2026-09-08-filesystem-aware-saving.md`.

Implementation worktree: `.worktrees/filesystem-aware-saving`.
Branch: `feat/filesystem-aware-saving`.
Baseline commit: `eac961b`.

At this baseline checkpoint, no application code had changed. See the implementation checkpoint below for subsequent changes; compatibility replacement remains unimplemented.

## Baseline checks

Commands run in the implementation worktree:

```bash
npm ci
bash tools/build-desktop.sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Results:

- Dependency installation and frontend build succeeded; generated files have no tracked diff.
- Frontend tests: 336 passed, 0 failed, 0 skipped.
- Linux-native unit tests: 82 passed, 0 failed.
- Native performance diagnostic: 1 ignored, as configured.
- Native main/doc tests: no tests, successful exit.

These results establish the unchanged baseline only. Linux-native tests do not exercise Windows security or publication APIs.

## Windows execution environment

Read-only inspection through Windows PowerShell established:

- Windows: 10.0.26100.9168 (reported by `wsl.exe --version`).
- WSL: 2.6.3.0.
- WSL kernel: 6.6.87.2-1.
- Ubuntu-24.04: running with WSL version 2.
- Neither `cargo` nor `rustc` is available through the inspected Windows PATH.
- Neither executable exists at its standard `%USERPROFILE%\.cargo\bin` location.

Task 1.3 is blocked pending access to a Windows Rust toolchain (and the Windows native build prerequisites). No toolchain was installed and no Windows build or Windows-native Rust test was attempted. A custom installation may exist elsewhere; its location must be supplied before use.

## Reproduction/evidence status

The user reports failure when saving through `U:`, mapped to `\\wsl.localhost\Ubuntu-24.04`. The existing error combines security-descriptor preparation and temporary creation, so the precise failing API remains unverified.

| Provider | Path form | Capability flags | Failing API/code | Content outcome | Security outcome | Retained artifacts | Validation status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WSL Ubuntu-24.04 | Mapped `U:` | Not queried | User reports OS error 1; exact API unknown | Not independently observed | Not tested | None created by this investigation | User report only |
| WSL Ubuntu-24.04 | Direct UNC | Not queried | Not tested | Not tested | Not tested | None created | Blocked on Windows-native setup |
| Local NTFS | Local Windows path | Not queried | Not tested | Not tested | Not tested | None created | Blocked on Windows-native setup |
| FAT/exFAT | No fixture provisioned | Not queried | Not tested | Not tested | Not tested | None created | Not run |

No disposable document fixture has been created yet. The real reported `usage.md` has not been accessed or modified.

## Implementation checkpoint — Windows validation delegated to Actions

The user authorized continuing without local Windows validation and running those tests in GitHub Actions. The attempted Visual Studio Build Tools installation ended with code 1602; its bootstrapper log reported that UAC may have been declined. No Windows Rust toolchain was installed. No additional installer or elevation attempts were made after validation was delegated.

### Implemented subset

- `document_io/windows_save.rs` queries the resolved directory with `GetVolumePathNameW` and `GetVolumeInformationW` for each save. A failed inspection is not treated as zero capability flags. Drive letters and provider names do not select policy.
- Existing-file saves require advertised persistent Windows ACLs and retain security-descriptor preparation, `ReplaceFileW`, and existing recovery. Native permission/security failures are not suppressed.
- New documents use native defaults, same-directory exclusive temporary creation, flushing, and exclusive publication. Unknown capability inspection still rejects the save.
- Existing-file replacement without Windows ACL support is explicitly rejected before creating a temporary file, because native Linux permissions/ownership cannot yet be preserved through an implemented adapter. The message suggests Save As with a new filename or a filesystem-native editor.
- Errors distinguish capability inspection, security reading/validation, temporary creation/preparation/writing/flushing, replacement, and new-file publication. Context preserves the error kind and displays the original OS error text/code. Raw error classification must occur before wrapping for display.
- Added pure policy/diagnostic/regression tests, a normal Windows-native round-trip test, and opt-in provider tests.

This is **partial implementation**, not a fix for replacing the reported existing WSL document. No non-ACL rename-replacement adapter, Linux metadata inspection/preparation, or compatibility recovery strategy has been enabled. Absence of Windows ACLs is not proof that a Linux file has no security metadata. The approved safety contract is unchanged.

### Checks actually run

- Test-first missing-helper/policy compilation failures were observed before implementation.
- Two diagnostic behavior tests then failed on the expected missing stage descriptions and passed after error context was added.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 90 Linux-native unit tests passed; 1 separate performance diagnostic ignored.
- `npm test`: 336 frontend tests passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `git diff --check`: passed.
- The new workflow parsed with PyYAML; dispatch-only trigger, read-only token permissions, protected-environment reference, WSL runner labels, and two path variants were checked.

Windows compilation/execution and all provider/security integration tests remain unrun locally. No GitHub workflow run has been launched or observed by this implementation session. YAML checks are not Windows validation.

## GitHub Actions coverage

### Regular hosted runner

Existing `.github/workflows/desktop.yml` runs Cargo tests on Windows, Linux, and macOS for pull requests, version tags, and manual dispatch. The Windows run includes `native_windows_existing_save_round_trip`, exercising capability inspection and the real existing-file save on the runner's ACL-capable temporary filesystem. Provider tests remain ignored there.

### Explicit WSL runner

New `.github/workflows/filesystem-save-providers.yml` is manual-dispatch only. It does not automatically run pull-request code on a persistent self-hosted machine.

Before dispatch:

1. Configure a trusted Windows x64 self-hosted runner with labels `self-hosted`, `Windows`, `X64`, and `wsl`.
2. Install MSVC/C++ build prerequisites, Git Bash, PowerShell 7, and a working WSL distro. The workflow installs/selects Rust, Node, and Python.
3. Configure the `wsl-save-validation` GitHub environment with required reviewers. Referencing an environment in YAML does not itself configure protection rules.
4. Ensure the runner account can access the running distro and the mapped drive. A Windows service account may not see an interactive user's WSL distro or drive mappings.
5. Create a disposable parent inside WSL and supply its UNC path as `unc_root` and its mapped-drive alias as `mapped_root` when dispatching the workflow. The tests create random child directories and leave them for inspection; they never remove the supplied parent.

The two matrix entries run serially, enforce a Windows-native Rust host, fail on an inaccessible root, and upload test/toolchain logs. A runner without the required labels will leave the job queued; it is not validated or silently skipped.

Provider tests exercise:

- New-file saving and rejection of a second create over that file.
- Existing-file saving when persistent ACLs are advertised, or explicit safe rejection with original contents preserved when they are absent.

**A passing safe-rejection test is not evidence that existing WSL files can be replaced.** Neither these tests nor the hosted NTFS test establish Linux mode, owner/group, access-ACL preservation, temporary-file exposure, or crash durability. The remaining security experiment from the approved plan is still required before compatibility replacement can be implemented.

To run the provider tests manually in Windows PowerShell with the same setup:

```powershell
$env:MDEDIT_SAVE_TEST_ROOT = '\\wsl.localhost\Ubuntu-24.04\home\skanga\mdedit-save-tests'
cargo test --manifest-path src-tauri/Cargo.toml --lib document_io::provider_tests::provider_ -- --ignored --nocapture --test-threads=1
```

Repeat with the mapped-drive alias and, if available, a `\\wsl$` alias or a disposable FAT/exFAT root. Supplying no root fails explicitly. Delete only a printed random `mdedit-provider-*` child after inspecting it, never the supplied parent.

## Remaining work

1. Observe the Windows CI results and run the configured WSL-provider workflow to identify actual capability/API behavior.
2. Establish a Windows-accessible way to inspect and preserve native security before temporary content is exposed; validate restrictive-mode, ownership/group, executable-bit, and access-ACL fixtures from Linux.
3. Only then implement and test a documented same-filesystem compatibility publication primitive and artifact-aware recovery, with no direct-overwrite or delete-then-rename fallback.
4. Until then, do not mark the full feature complete or report the original WSL error fixed.
