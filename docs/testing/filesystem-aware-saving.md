# Filesystem-aware saving: validation record

## Execution checkpoint — 2026-09-08

Approved design: `docs/superpowers/specs/2026-09-08-filesystem-aware-saving-design.md`.
Approved plan: `docs/superpowers/plans/2026-09-08-filesystem-aware-saving.md`.

Implementation worktree: `.worktrees/filesystem-aware-saving`.
Branch: `feat/filesystem-aware-saving`.
Baseline commit: `eac961b`.

No application code has changed. Compatibility saving has not been implemented or validated.

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

## Resume requirements

1. Locate or provision a Windows Rust toolchain and required native build tools, with user approval for installation.
2. Resume plan Task 1.3, then create disposable fixtures and establish the actual Windows-side failure.
3. Complete stage-specific diagnostics and provider/security experiments before enabling compatibility behavior.
4. Preserve the approved no-direct-overwrite/no-delete-then-rename contract. Missing Windows ACL support is not evidence that Linux permissions can be preserved.
