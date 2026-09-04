# GitHub Releases Distribution Design

## Goal

Distribute MDedit through GitHub Releases instead of asking users to download temporary GitHub Actions artifacts. Publish the existing successful `v0.1.0` build as the first release and automate future releases from version tags.

## User experience

The README Download section links to `https://github.com/skanga/mdedit/releases/latest`. It identifies the appropriate download for each supported platform and explains the Windows installer choices. It does not direct users to Actions or mention GitHub sign-in requirements for workflow artifacts.

Each release exposes the user-facing packages directly:

- Windows x64 portable executable
- Windows x64 NSIS installer
- Windows x64 MSI installer
- macOS Tauri bundle
- Ubuntu/Debian `.deb` package

Release notes are generated from GitHub history. Builds remain unsigned, so the existing operating-system warning remains documented.

## Workflow architecture

The existing `.github/workflows/desktop.yml` remains the single desktop build workflow.

- A push of a `v*` tag runs the existing Windows, macOS, and Linux build matrix.
- Each matrix job uploads its bundle output as an internal workflow artifact.
- A final release job runs only for tag pushes and only after every build succeeds.
- The release job downloads the build artifacts, selects the distributable files, and creates the matching GitHub Release with generated release notes.
- A manually dispatched workflow still verifies builds and produces Actions artifacts, but it never creates a GitHub Release.

Keeping publication in a single downstream job avoids concurrent release creation or update races between matrix jobs.

## Initial release

Create tag `v0.1.0` at the verified commit and publish a non-draft, non-prerelease GitHub Release named `MDedit v0.1.0`. Use the outputs from the already successful GitHub Actions run when possible; verify every selected asset is nonempty and has the expected extension and platform identity before upload.

## Failure handling

- Missing expected build artifacts fail the publishing job.
- A failed matrix job prevents release publication.
- Manual workflow runs cannot publish accidentally.
- The GitHub-provided workflow token receives only the `contents: write` permission needed by the release job.
- Re-running a tag workflow must update or reuse the matching release without silently dropping existing assets.

## Verification

- Extend the project identity tests to assert that README download guidance targets GitHub Releases and no longer directs users to Actions artifacts.
- Assert the workflow contains a tag-gated release job dependent on the complete build matrix.
- Run the full local test suite and desktop frontend build.
- Trigger or observe a tagged GitHub Actions run and confirm all matrix jobs and the publishing job succeed.
- Inspect the published `v0.1.0` release and verify all five expected assets are downloadable and nonempty.

## Out of scope

- Code signing or notarization
- Automatic version-number mutation in project manifests
- Publishing browser/PWA files as release assets
- Replacing the existing manual build workflow
