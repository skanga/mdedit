# Windows Desktop CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and upload the Windows NSIS installer from GitHub Actions.

**Architecture:** Retain the existing frontend build scripts, but make their workflow invocation explicit and provide Python consistently across operating systems. Push the verified branch to a new public repository and use manual workflow dispatch.

**Tech Stack:** GitHub Actions, Bash, Python 3, npm, Rust, Tauri 2

---

### Task 1: Make the workflow portable

**Files:**
- Modify: `.github/workflows/desktop.yml`

- [ ] Add `actions/setup-python@v5` with Python 3.x after Node setup.
- [ ] Split the build step into a Bash frontend-staging step and a native Tauri step.
- [ ] Run the frontend step as `bash ./tools/build-desktop.sh` with `shell: bash`.
- [ ] Run the native step as `npx tauri build ${{ matrix.args }}`.

### Task 2: Verify locally

**Files:**
- Verify: `.github/workflows/desktop.yml`
- Verify: `index.html`, `index-lite.html`, `dist-desktop/index.html`

- [ ] Parse the workflow with Ruby's YAML parser.
- [ ] Run `npm test` and expect zero failures.
- [ ] Run `npm run build:desktop` and expect both web builds plus desktop staging.
- [ ] Confirm `dist-desktop/index.html` equals `index.html`.
- [ ] Run `git diff --check` and inspect the final diff.

### Task 3: Publish and dispatch

**Files:**
- Commit all relevant tracked source/generated changes and `src-tauri/Cargo.lock`.
- Exclude: `mcp-server.log`, `src-tauri/target/`, `src-tauri/target-windows/`.

- [ ] Create public repository `skanga/markdown-editor` without auto-generated files.
- [ ] Replace `origin` with `https://github.com/skanga/markdown-editor.git`.
- [ ] Commit the approved project and workflow changes.
- [ ] Push `tauri-desktop-shell` and set its upstream.
- [ ] Dispatch `.github/workflows/desktop.yml` against `tauri-desktop-shell`.
- [ ] Watch the Windows job and confirm its artifact contains an NSIS `*-setup.exe`.
