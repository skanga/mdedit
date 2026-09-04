# MDedit Windows Portable Executable Design

## Goal

Publish a single-file Windows x64 build of MDedit alongside the existing NSIS and MSI installers.

## Distribution format

The portable build will be the raw Tauri release executable produced by the Windows job. CI will copy `src-tauri/target/release/mdedit.exe` to the user-facing filename `MDedit-portable-x64.exe` and upload it as a dedicated GitHub Actions artifact named `mdedit-windows-portable`.

The artifact will contain only that executable. It will not install MDedit, write installer registry entries, create shortcuts, or register Markdown file associations.

“Portable” describes application deployment, not completely stateless operation. MDedit may still use the standard WebView/application-data locations for preferences and draft restoration.

## Runtime requirement

The portable executable will use the system Microsoft Edge WebView2 runtime, as ordinary Tauri applications do. Supported Windows 10 and Windows 11 systems normally include WebView2. Unlike the NSIS/MSI installers, the raw executable will not bootstrap a missing runtime.

A fixed WebView2 runtime will not be bundled because it requires a large multi-file payload and conflicts with the single-file requirement.

## CI changes

The existing Windows matrix job will retain its normal Tauri build, producing NSIS and MSI bundles. After the build, a Windows-only step will:

1. Verify that `src-tauri/target/release/mdedit.exe` exists.
2. Copy it to a staging directory as `MDedit-portable-x64.exe`.
3. Upload that staging file using `actions/upload-artifact` with the name `mdedit-windows-portable`.

The existing platform bundle artifacts remain unchanged.

## Documentation

The README download table will add `mdedit-windows-portable`. The Windows section will explain:

- It is a single executable and requires no installation.
- It does not create shortcuts or file associations.
- It relies on the system WebView2 runtime.
- The NSIS installer remains recommended for most users.

## Verification

The project identity test will assert the portable artifact name, source executable path, staged filename, and Windows-only condition in the workflow. Local JavaScript, Rust, formatting, generated-asset, and legacy-identity checks must remain green.

After pushing, the Windows Actions job must succeed. Downloading `mdedit-windows-portable` must yield exactly one file named `MDedit-portable-x64.exe`; the regular Windows artifact must still contain MDedit-branded NSIS and MSI installers.

## Non-goals

- Bundling a fixed WebView2 runtime
- Making settings or restored drafts reside beside the executable
- Adding an updater to the portable build
- Replacing the NSIS or MSI installers
- Code signing
