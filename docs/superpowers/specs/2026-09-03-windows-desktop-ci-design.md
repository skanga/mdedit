# Windows desktop CI design

## Goal

Make the existing Desktop GitHub Actions workflow reliably produce Windows bundles, including an NSIS installer.

## Design

- Keep the existing Bash/Python frontend build as the canonical source of `index.html`, `index-lite.html`, and `dist-desktop/index.html`.
- Install Python explicitly on every Actions runner.
- Invoke `tools/build-desktop.sh` explicitly through Git Bash so Windows does not ask `cmd.exe` to execute a POSIX script.
- Preserve the existing OS matrix and artifact upload. The Windows job uses Tauri's configured Windows bundle targets; Linux remains limited to `deb`.
- Create a new public repository at `skanga/markdown-editor`, push only the `tauri-desktop-shell` branch, and trigger the workflow manually without creating a release tag.

## Verification

- Parse the workflow YAML and inspect its rendered diff.
- Run the frontend build and repository tests locally.
- Confirm generated bundles match their source template.
- Push the branch, dispatch the Desktop workflow, and inspect the Windows job and uploaded artifacts.

## Constraints

- Exclude `mcp-server.log` and compiler output.
- Preserve all existing source changes.
- Do not push to the unrelated `hattray/markdown-editor` repository.
