# MDedit Rename and Desktop README Design

## Goal

Establish **MDedit** as the single project name throughout the application, build metadata, installers, documentation, and GitHub repository. Rewrite the README to present MDedit strictly as a Tauri desktop application.

## Canonical identity

Use these identifiers consistently:

- Product name: `MDedit`
- GitHub repository: `https://github.com/skanga/mdedit`
- npm package and desktop binary: `mdedit`
- Rust crate and library identifier: `mdedit`
- Tauri bundle identifier: `com.skanga.mdedit`

The local checkout directory may remain `markdown-editor`. Its path is workspace infrastructure rather than product metadata, and renaming an active checkout could disrupt tooling.

## Rename scope

Replace old project names and identifiers in all tracked application and project files, including:

- App titles, dialogs, help content, metadata, and user-facing copy
- npm package metadata and lockfile metadata
- Rust package, library, imports, and binary metadata
- Tauri product name, window title, identifier, and generated installer names
- Web manifests, service-worker comments, and cache/storage keys retained as implementation assets
- Source-code links, repository references, build scripts, and documentation

There is no installed user base or legacy data to preserve. Old `md-editor-*`, `md-viewer-*`, and equivalent persistence/cache identifiers will be replaced directly without migration or fallback code.

Generated HTML files will be regenerated from the renamed source template rather than maintained as divergent hand-edited copies.

## README

Rewrite `README.md` around MDedit as a native, cross-platform Tauri desktop application. The README will include:

- A concise desktop-product introduction
- Major capabilities: Markdown editing, live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports
- Download and installation guidance for GitHub artifacts or releases
- Windows NSIS and MSI package information
- Desktop development prerequisites for Windows, macOS, and Linux
- Clean installation, development, test, and desktop-build commands
- A concise project-structure overview and contribution guidance

The README will not document the browser or PWA build as a supported product. Browser-oriented files may remain where Tauri's frontend implementation requires them.

## GitHub metadata

Rename the public repository from `skanga/markdown-editor` to `skanga/mdedit`, then update the local `origin` URL to the canonical address.

Set the repository description to:

> A fast, private, cross-platform Markdown editor built with Tauri, featuring live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports.

## Verification

Before completion:

1. Search all tracked files for old product names, identifiers, and repository URLs. Any intentional historical occurrence must be explicitly justified; otherwise, remove it.
2. Run the npm clean build and automated tests.
3. Run applicable Rust formatting, checks, and tests when the local toolchain is available.
4. Confirm that Tauri resolves the `mdedit` binary and produces MDedit-branded bundle filenames.
5. Push the implementation and verify the GitHub Actions desktop matrix for Windows, macOS, and Linux.
6. Confirm that the Windows artifact contains MDedit-branded NSIS and MSI installers.
7. Confirm that the renamed public repository, canonical origin URL, and GitHub description are visible.

## Non-goals

- Preserving legacy local-storage, preference, or service-worker cache data
- Renaming the local checkout directory
- Advertising or documenting a browser/PWA product
- Adding unrelated features or visual redesign work
