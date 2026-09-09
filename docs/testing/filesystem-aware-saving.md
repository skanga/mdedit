# Filesystem-aware saving: compatibility mode and evidence

## Current behavior

The original design required preservation of native security before allowing any existing-file replacement. v0.3.8 implemented a conservative refusal and better diagnostics, but did not solve existing-file WSL saving. The user subsequently approved an explicit opt-in tradeoff: allow permission/ownership changes on non-ACL filesystems while retaining temporary-file saving and no direct-overwrite or delete-then-rename fallback.

Compatibility save design: `docs/superpowers/specs/2026-09-09-wsl-compatibility-mode.md`.
Persistent setting design: `docs/superpowers/specs/2026-09-09-persistent-compatibility-setting.md`.
The original design/plan and `docs/releases/v0.3.8.md` are historical records, not the current consent policy.

### Persistent app-wide setting

Desktop **Editor → Allow compatibility saving** is off by default. Enabling it requires a warning with Cancel focused by default, explaining that it applies to all eligible files across restarts and may change permissions/ownership/access ACLs or broaden readability. With it enabled, the controller still waits for a native `compatibility-required` result and sends only the returned exact path with the original captured content and digest. Normal saves and errors are unchanged.

The opt-in is stored separately from ordinary editor preferences under localStorage key `mdedit-allow-compatibility-saving-v1`. Only the exact value `1` enables it; missing, malformed, or unreadable storage defaults off. This is app-profile storage, not data embedded in the portable executable or document recovery snapshots. The plain-browser editor does not offer the setting.

Enabling persists the preference before authorizing saves; cancellation or a failed write leaves the previous state unchanged and reports failure when necessary. Disabling revokes app-wide and cached per-file consent immediately and invalidates pending per-file approvals, then removes the stored opt-in. A removal failure is reported explicitly: it is off for the current session but may return on restart. An already-submitted native write cannot be canceled by changing the preference.

### User interaction

1. Save an existing file on a filesystem without persistent Windows ACLs.
2. Before creating any temporary, the native core returns `compatibility-required` with the exact, case-preserving resolved destination in `compatibilityPath`.
3. Unless app-wide compatibility saving is enabled or that path has session approval, the controller presents **Use compatibility saving?** with **Cancel** focused by default. The warning explains that temporary files use folder-default permissions and replacement can change permissions, ownership, or access ACLs and broaden access.
4. Choosing **Use Compatibility Saving** retries the same captured content and expected disk digest with the returned `compatibilityPath`.
5. The native core re-resolves the path, requires an exact consent-path match, and repeats conflict checks. Per-file approval is remembered only for that resolved path in the current controller/application session; only the separate app-wide opt-in can persist.

Cancel leaves the file and saved baseline unchanged. Save All stops on cancellation. With the app-wide setting off, Save As over a different existing destination requires separate consent; creating a new destination does not. Disposing the controller while the dialog is open prevents a retry. Edits typed during confirmation remain dirty if only the earlier capture was saved.

### Native strategies

- Persistent Windows ACLs: existing descriptor preparation and `ReplaceFileW`/backup recovery, even when consent was supplied.
- No Windows ACLs, no matching consent: request consent without creating a temporary file.
- No Windows ACLs, matching consent: create a same-directory temporary with native defaults, write and flush it, run the final conflict guard, close its handle, then call `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`. No copy-emulation flag, direct destination write, or destination deletion is allowed.
- Capability-query, flush, access-denied, and sharing errors remain errors. A failed publication never switches strategy or triggers another destructive operation.
- Compatibility publication has no backup. Classify the destination after the call; success requires both API success and editor bytes at the destination. Retain known recoverable temporaries on uncertain failures and keep the original API error in diagnostics.
- Cleanup does not delete a temporary with unrecognized contents simply because editor bytes are present at the destination.

Native Linux/macOS permission-preserving saves remain unchanged. Content guards are not atomic compare-and-swap; no provider crash-durability guarantee is claimed.

## Local evidence

### Regression checks

Latest regression commands run in `.worktrees/persistent-compatibility`:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
npm run test:browser
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Observed results:

- 98 Linux-native Rust unit tests passed; one separate performance diagnostic remains ignored as configured.
- 353 frontend/unit tests passed.
- 70 Chromium browser tests passed, including the actual confirmation UI, app-wide preference persistence across reloads, multiple-file saving, default Cancel/Escape behavior, consent forwarding, session reuse, storage failures, and the absence of this preference in plain-browser mode. Native calls use a fake Tauri backend in browser tests.
- Preference and warning screenshots were visually inspected at `test-results/compatibility-preference-enabled.png` and `test-results/compatibility-preference-warning.png`.
- Policy, permission-error handling, publication outcome/retention, serialization, cancellation, stale captures, conflicts, Save As, and Save All are covered.

Test-first evidence for compatibility mode includes missing native policy/outcome helpers, controller failures on an unhandled `compatibility-required` result, and a browser failure with the previous generated frontend lacking the dialog. The persistent-setting tests first failed on the missing controller setter and missing checkbox; they passed after implementation and frontend regeneration.

### Windows-to-WSL primitive probe

A Windows PowerShell probe invoked the actual `MoveFileExW` API on disposable WSL fixtures, using a .NET file stream opened with exclusive new-file creation, a content write, `Flush(true)`, and handle close before rename. This required no Windows Rust installation or elevation.

| Path | Publication | Destination bytes | Temporary after rename | Linux mode before/after |
| --- | --- | --- | --- | --- |
| `\\wsl.localhost\Ubuntu-24.04\tmp\mdedit-compat-probe.lFmIMz\unc` | Success | `editor` | Absent | `0600` → `0644` |
| `U:\tmp\mdedit-compat-probe.lFmIMz\mapped` | Success | `editor` | Absent | `0600` → `0644` |

Both fixtures retained numeric owner/group `1000:1000`; their parent directories were mode `0755`. Fixtures remain at `/tmp/mdedit-compat-probe.lFmIMz`; the one-off probe is `/tmp/mdedit-probe-compatibility.ps1` in this development environment. These temporary paths are evidence locations, not installed application dependencies.

This confirms that the chosen Windows rename primitive works through both UNC and mapped WSL paths and demonstrates the permission-widening risk disclosed by the dialog. It does **not** validate the compiled Windows Rust application, every Linux ACL/ownership configuration, or crash behavior. The reported real `usage.md` was not accessed or changed.

Environment previously inspected: Windows 10.0.26100.9168, WSL 2.6.3.0, kernel 6.6.87.2-1, Ubuntu-24.04 on WSL2. Windows Rust/MSVC setup remains unavailable locally after the earlier Build Tools installer stopped at UAC; no further installation was attempted.

## GitHub Actions

### Hosted native runner

Existing `.github/workflows/desktop.yml` runs Cargo tests on Windows, Linux, and macOS for pull requests, version tags, and manual dispatch, plus browser and release/performance gates as configured.

Normal Windows tests now cover:

- ACL-capable existing-file saving through the production save entry point.
- The compatibility rename primitive plus outcome classification on disposable local files.
- Rejection of cross-directory compatibility publication without modifying either candidate.

Pure policy/outcome tests also run on Linux/macOS. The WSL-provider tests remain ignored on ordinary hosted runners. The compiled Windows tests and package build passed in the [v0.3.9 release pipeline](https://github.com/skanga/mdedit/actions/runs/34372889230). The persistent-setting change does not modify native code; its new UI wiring has been tested locally but has not yet run in release CI.

### Configured WSL provider runner

`.github/workflows/filesystem-save-providers.yml` is manual-dispatch only; it does not automatically run pull-request code on a persistent self-hosted machine.

Before dispatch:

1. Configure a trusted Windows x64 runner with labels `self-hosted`, `Windows`, `X64`, and `wsl`.
2. Install MSVC/C++ prerequisites, Git Bash, PowerShell 7, and a working WSL distro. The workflow installs/selects Rust, Node, and Python.
3. Configure the `wsl-save-validation` GitHub environment with required reviewers; merely referencing the environment in YAML does not create protection rules.
4. Ensure the runner account can access the distro and mapped drive. A service account may not see an interactive user's distro or mappings.
5. Supply an existing disposable WSL parent as `unc_root`, and its mapped-drive alias as `mapped_root`. Tests create random child directories and retain them; they never remove the supplied parent.

The two matrix entries run serially, enforce a Windows-native Rust host, fail on an inaccessible root, and upload test/toolchain logs. A runner without matching labels leaves the job queued, not validated.

The updated provider test now **requires successful existing-file saving after matching consent** on non-ACL filesystems. A refusal is no longer accepted as a passing outcome. It also checks no temporary exists before consent, rejects a mismatched consent path, and verifies that consent does not bypass a stale-content conflict. New-file tests cover save and no-clobber behavior.

Manual equivalent in Windows PowerShell:

```powershell
$env:MDEDIT_SAVE_TEST_ROOT = '\\wsl.localhost\Ubuntu-24.04\home\skanga\mdedit-save-tests'
cargo test --manifest-path src-tauri/Cargo.toml --lib document_io::provider_tests::provider_ -- --ignored --nocapture --test-threads=1
```

Repeat with the mapped alias, an available `\\wsl$` alias, or a disposable FAT/exFAT root. Missing configuration fails explicitly. Inspect retained evidence before deleting only the printed random `mdedit-provider-*` child.

## Remaining validation and limitations

- Run the persistent-setting UI through release CI/a new Windows build. The v0.3.9 Windows Rust tests passed, but the local PowerShell probe is not a substitute for full compiled-app WSL integration.
- Check additional Linux ownership/access-ACL configurations and error cases using disposable fixtures. Compatibility mode intentionally does not promise preservation of those attributes.
- Native filesystem capability inspection must succeed. Unexpected provider errors are still reported rather than bypassed.
- Compatibility failures may leave an editor temporary for recovery. Error messages identify retained paths; no broad stale-file cleanup is performed.
- v0.3.9 contains session-scoped compatibility saving. The persistent app-wide setting has not been pushed or released by this implementation session.
