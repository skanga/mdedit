# MDedit Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the complete Tauri desktop product to MDedit, replace the browser-first README with desktop documentation, rename the GitHub repository, and prove that all desktop bundles retain the new identity.

**Architecture:** Keep the existing HTML/CSS/JavaScript frontend and Rust/Tauri shell intact. Treat `src/index.template.html` as the source of truth for the UI and regenerate committed HTML artifacts with `build.sh`; enforce the canonical identity with a small Node test that reads structured metadata and selected source files. Make the external GitHub rename only after all local checks pass.

**Tech Stack:** Tauri 2, Rust, HTML/CSS/JavaScript, Node.js test runner, npm, Python 3 build helper, Bash, GitHub Actions, GitHub CLI

---

## File map

- Create `tools/test-project-identity.js`: regression contract for package, Tauri, UI, documentation, and workflow naming.
- Modify `package.json` and `package-lock.json`: canonical npm identity and expanded test command.
- Modify `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/src/main.rs`: Rust package/library/binary identity.
- Modify `src-tauri/tauri.conf.json`: product, window, bundle, and installer identity.
- Modify `src/index.template.html`: canonical product text, repository links, desktop-oriented help/welcome copy, and persistence keys.
- Modify `build.sh`: MDedit lite-build title substitution.
- Modify `pwa/manifest.json` and `pwa/sw.js`: rename retained frontend metadata and cache key.
- Regenerate `index.html`, `index-lite.html`, `manifest.json`, and `sw.js`: committed build outputs generated from the renamed sources.
- Modify `.github/workflows/desktop.yml`: deterministic install/test steps and MDedit-branded artifact names.
- Replace `README.md`: Tauri-only product, download, build, test, and contribution documentation.
- Rename GitHub repository and update local `origin`: external project identity.

### Task 1: Lock the package and Tauri identity with a regression test

**Files:**
- Create: `tools/test-project-identity.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write the failing metadata identity test**

Create `tools/test-project-identity.js` with:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const json = (name) => JSON.parse(read(name));

test("package and Tauri metadata use the canonical MDedit identity", () => {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  const cargo = read("src-tauri/Cargo.toml");
  const cargoLock = read("src-tauri/Cargo.lock");
  const main = read("src-tauri/src/main.rs");
  const tauri = json("src-tauri/tauri.conf.json");

  assert.equal(pkg.name, "mdedit");
  assert.equal(lock.name, "mdedit");
  assert.equal(lock.packages[""].name, "mdedit");
  assert.match(cargo, /^name = "mdedit"$/m);
  assert.match(cargo, /\[lib\]\s+name = "mdedit_lib"/m);
  assert.match(cargoLock, /^name = "mdedit"$/m);
  assert.match(main, /mdedit_lib::run\(\)/);
  assert.equal(tauri.productName, "MDedit");
  assert.equal(tauri.identifier, "com.skanga.mdedit");
  assert.equal(tauri.app.windows[0].title, "MDedit");
});
```

- [ ] **Step 2: Add the new test to the npm test command**

Change the script to list both test files explicitly so it behaves the same in Bash and Windows Command Prompt:

```json
"test": "node --test tools/test-native-bridge.js tools/test-project-identity.js"
```

- [ ] **Step 3: Run the new test and verify that the old metadata fails it**

Run:

```bash
npm test
```

Expected: the ten native-bridge tests pass and the identity test fails first at `pkg.name`.

- [ ] **Step 4: Rename npm metadata**

Set the root package name in `package.json` to:

```json
"name": "mdedit"
```

Then regenerate only npm lock metadata:

```bash
npm install --package-lock-only
```

Expected: both the top-level `name` and `packages[""].name` in `package-lock.json` are `mdedit`, with no dependency version changes.

- [ ] **Step 5: Rename the Rust package, library, and binary reference**

Use this package/library identity in `src-tauri/Cargo.toml`:

```toml
[package]
name = "mdedit"
version = "0.1.0"
edition = "2021"

[lib]
name = "mdedit_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

Change `src-tauri/src/main.rs` to call:

```rust
fn main() {
    mdedit_lib::run()
}
```

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Cargo succeeds and changes the root package entry in `src-tauri/Cargo.lock` to `mdedit`.

- [ ] **Step 6: Rename Tauri product and bundle metadata**

Set these exact values in `src-tauri/tauri.conf.json`:

```json
{
  "productName": "MDedit",
  "identifier": "com.skanga.mdedit",
  "app": {
    "windows": [
      {
        "title": "MDedit"
      }
    ]
  }
}
```

Preserve all unrelated window sizes, security configuration, bundle targets, icons, and Markdown file associations.

- [ ] **Step 7: Run the identity and native bridge tests**

Run:

```bash
npm test
```

Expected: 11 tests pass and zero fail.

- [ ] **Step 8: Commit the metadata rename**

```bash
git add package.json package-lock.json tools/test-project-identity.js src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs src-tauri/tauri.conf.json
git commit -m "Rename desktop package to MDedit"
```

### Task 2: Rename the application UI and generated frontend assets

**Files:**
- Modify: `tools/test-project-identity.js`
- Modify: `src/index.template.html`
- Modify: `build.sh`
- Modify: `pwa/manifest.json`
- Modify: `pwa/sw.js`
- Regenerate: `index.html`
- Regenerate: `index-lite.html`
- Regenerate: `manifest.json`
- Regenerate: `sw.js`

- [ ] **Step 1: Extend the identity test with UI and generated-asset assertions**

Append this test:

```js
test("UI sources and generated assets use MDedit", () => {
  const template = read("src/index.template.html");
  const fullBuild = read("index.html");
  const liteBuild = read("index-lite.html");
  const pwaManifest = json("pwa/manifest.json");
  const rootManifest = json("manifest.json");
  const sourceWorker = read("pwa/sw.js");
  const rootWorker = read("sw.js");

  for (const source of [template, fullBuild, liteBuild]) {
    assert.match(source, /MDedit/);
    assert.match(source, /github\.com\/skanga\/mdedit/);
    assert.doesNotMatch(source, /Free MD Viewer/);
    assert.doesNotMatch(source, /github\.com\/(?:hattray|skanga)\/markdown-editor/);
    assert.doesNotMatch(source, /md-(?:editor|viewer)-(?:draft|theme|toc|reader)/);
  }

  for (const manifest of [pwaManifest, rootManifest]) {
    assert.equal(manifest.name, "MDedit");
    assert.equal(manifest.short_name, "MDedit");
  }

  for (const worker of [sourceWorker, rootWorker]) {
    assert.match(worker, /Service worker for MDedit/);
    assert.match(worker, /const CACHE = "mdedit-shell-v1"/);
  }
});
```

- [ ] **Step 2: Run the test and verify that the browser-era identity fails it**

Run:

```bash
npm test
```

Expected: the new `UI sources and generated assets use MDedit` test fails on the old template identity.

- [ ] **Step 3: Rename the source template and make its copy desktop-oriented**

Apply these exact identity changes in `src/index.template.html`:

| Existing concept | Replacement |
| --- | --- |
| Product heading and brand | `MDedit` |
| Source URL | `https://github.com/skanga/mdedit` |
| License URL | `https://github.com/skanga/mdedit/tree/main/licenses` |
| Document title | `MDedit — Markdown editor` |
| Meta description | `A fast, private desktop Markdown editor with live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports.` |
| Draft key | `mdedit-draft-v1` |
| Theme key | `mdedit-theme` |
| TOC key | `mdedit-toc` |
| Reader key | `mdedit-reader` |
| Issue URL | `https://github.com/skanga/mdedit/issues` |

Replace the drop-overlay subtext with:

```html
<div class="sub">.md, .markdown or any text file — it stays on your device</div>
```

Replace the restored-draft status with:

```js
setStatus("Draft restored");
```

Replace `buildHelp()` content so it keeps the keyboard shortcut table, describes native Open/Save and local exports, removes browser installation and custom-build sales copy, and ends with the canonical issue link:

```js
"<h4>Tips</h4><p>Drop a <code>.md</code> file anywhere in the window, or use Open. " +
"Save writes directly to the current file; Save as creates a new copy.</p>" +
"<h4>Found a bug?</h4><p>The source is open — " +
"<a href='https://github.com/skanga/mdedit/issues' target='_blank' rel='noopener noreferrer'>" +
"open an issue on GitHub</a>.</p>";
```

Replace the beginning and Getting Started section of `WELCOME` with:

```js
const WELCOME = `# Welcome to MDedit

A fast, private desktop Markdown editor — **your documents stay on your device**.

## Getting started

- **Drop** a Markdown file into this window, or click **Open**
- Type on the left and see the rendered document on the right
- **Save** writes back to the current file; **Save as** creates a new copy
- **Export** the rendered document as HTML, PNG, or PDF
- Your work is restored automatically if the app closes unexpectedly
```

Keep the remainder of the feature demonstration, changing only product/browser-specific wording to desktop wording. Preserve all rendering examples and `${HAS_MATH}`, `${HAS_DIAGRAMS}`, and platform-shortcut interpolation.

- [ ] **Step 4: Rename retained frontend metadata and the build substitution**

In `pwa/manifest.json`, set:

```json
{
  "name": "MDedit",
  "short_name": "MDedit",
  "description": "Open, edit, and preview Markdown locally with MDedit."
}
```

Preserve the remaining manifest fields. In `pwa/sw.js`, use:

```js
/* Service worker for MDedit.
```

and:

```js
const CACHE = "mdedit-shell-v1";
```

In `build.sh`, change the lite-title substitution to:

```python
doc = doc.replace("MDedit —", "MDedit (lite) —", 1)
```

- [ ] **Step 5: Regenerate every committed frontend output**

Run:

```bash
bash ./build.sh
```

Expected: `index.html`, `index-lite.html`, `manifest.json`, and `sw.js` are regenerated; the command reports both HTML sizes and copied frontend sidecars.

- [ ] **Step 6: Run tests and scan application files**

Run:

```bash
npm test
git grep -n -I -E 'Free MD Viewer|free-md-viewer|free_md_viewer|com\.kingsbridge\.freedmdviewer|github\.com/(hattray|skanga)/markdown-editor|md-editor-|md-viewer-' -- ':!docs/superpowers/*'
```

Expected: 12 tests pass. The grep command prints no matches and exits with status 1 because no legacy identity remains in application files.

- [ ] **Step 7: Commit the application rename**

```bash
git add src/index.template.html build.sh pwa/manifest.json pwa/sw.js index.html index-lite.html manifest.json sw.js tools/test-project-identity.js
git commit -m "Rename application UI to MDedit"
```

### Task 3: Replace the README and brand CI artifacts

**Files:**
- Modify: `tools/test-project-identity.js`
- Replace: `README.md`
- Modify: `.github/workflows/desktop.yml`

- [ ] **Step 1: Extend the identity test with README and workflow assertions**

Append:

```js
test("README and CI describe the MDedit desktop product", () => {
  const readme = read("README.md");
  const workflow = read(".github/workflows/desktop.yml");

  assert.match(readme, /^# MDedit$/m);
  assert.match(readme, /^## Download$/m);
  assert.match(readme, /^## Windows installers$/m);
  assert.match(readme, /^## Development$/m);
  assert.match(readme, /github\.com\/skanga\/mdedit\/actions\/workflows\/desktop\.yml/);
  assert.doesNotMatch(readme, /^## Browser support$/m);
  assert.doesNotMatch(readme, /^## The lite build$/m);
  assert.doesNotMatch(readme, /^## Self-hosting$/m);
  assert.doesNotMatch(readme, /runs entirely in your browser/i);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /name: mdedit-\$\{\{ matrix\.os \}\}/);
});
```

- [ ] **Step 2: Run the test and verify that the web-first README fails it**

Run:

```bash
npm test
```

Expected: the new README/CI test fails because the README still begins with the former name.

- [ ] **Step 3: Replace README.md with Tauri-only product documentation**

Use this structure and content:

```markdown
# MDedit

MDedit is a fast, private, cross-platform Markdown editor built with Tauri. It combines a focused source editor with live preview, native file handling, Mermaid diagrams, KaTeX math, and offline exports. Documents are processed locally and remain on your device.

## Features

- Native Open, Save, and Save As on Windows, macOS, and Linux
- Edit, Split, and Preview layouts with synchronized scrolling
- GitHub-flavored Markdown, task lists, tables, footnotes, and callouts
- Syntax highlighting for fenced code blocks
- Mermaid diagrams and KaTeX inline/display math
- Find and replace, table of contents, reader controls, and light/dark themes
- HTML, PNG, PDF, CSV-table, and SVG-diagram exports
- Automatic draft restoration and Markdown file associations

## Download

Desktop installers are produced by the [Desktop GitHub Actions workflow](https://github.com/skanga/mdedit/actions/workflows/desktop.yml). Open a successful run and download the artifact for your operating system:

| Artifact | Platform | Package |
| --- | --- | --- |
| `mdedit-windows-latest` | Windows x64 | NSIS `.exe` and MSI `.msi` |
| `mdedit-macos-latest` | macOS | Tauri macOS bundles |
| `mdedit-ubuntu-latest` | Ubuntu Linux | Debian `.deb` |

These development builds are currently unsigned. Your operating system may display a warning before installation. GitHub may require you to sign in before downloading workflow artifacts.

## Windows installers

The Windows artifact contains two installer formats:

- **NSIS (`MDedit_0.1.0_x64-setup.exe`)** — recommended for most users.
- **MSI (`MDedit_0.1.0_x64_en-US.msi`)** — useful for managed or administrative deployment.

Installing either package registers supported Markdown files so they can be opened in MDedit from Windows Explorer.

## Development

Install the current Node.js LTS release, Python 3, Rust with Cargo, and the [Tauri prerequisites for your operating system](https://v2.tauri.app/start/prerequisites/). The frontend build scripts use Bash; on Windows, run them from Git Bash.

Install dependencies and run the test suite:

```bash
npm ci
npm test
```

Stage a clean frontend build and launch the desktop app:

```bash
npm run build:desktop
npm run tauri -- dev
```

Create installable bundles for the current operating system:

```bash
npm run build:desktop
npm run tauri -- build
```

On Windows, build only the NSIS installer with:

```bash
npm run build:desktop
npm run tauri -- build --bundles nsis
```

## Project structure

| Path | Purpose |
| --- | --- |
| `src/index.template.html` | Application UI and Markdown renderer source |
| `src/native-bridge.js` | Small JavaScript bridge to native Tauri file APIs |
| `src-tauri/` | Rust shell, Tauri configuration, capabilities, and icons |
| `vendor/` | Vendored rendering libraries and KaTeX fonts |
| `build.sh` | Generates the self-contained frontend artifacts |
| `tools/build-desktop.sh` | Stages the full frontend in `dist-desktop/` for Tauri |
| `.github/workflows/desktop.yml` | Cross-platform installer build workflow |

The committed `index.html` and `index-lite.html` files are generated artifacts. Change `src/index.template.html`, then run `bash ./build.sh`; do not edit generated HTML directly.

## Privacy

MDedit has no account system, telemetry, upload endpoint, or server-side rendering. Opening, editing, rendering, and exporting documents happens locally. Features that transmit document contents to a remote service are out of scope.

## Contributing

Issues and pull requests are welcome at [github.com/skanga/mdedit](https://github.com/skanga/mdedit). Before submitting a change:

```bash
npm test
npm run build:desktop
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

Commit regenerated frontend artifacts whenever their source changes.

## License

MDedit's original code is available under the [MIT License](LICENSE). Distributed builds include marked, DOMPurify, highlight.js, KaTeX, and Mermaid; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [`licenses/`](licenses/) for their licenses.
```

- [ ] **Step 4: Make CI deterministic and brand its artifacts**

In `.github/workflows/desktop.yml`:

1. Change `run: npm install` to `run: npm ci`.
2. Add this step immediately after dependency installation:

```yaml
      - name: Test
        run: npm test
```

3. Change the upload name to:

```yaml
          name: mdedit-${{ matrix.os }}
```

Preserve the existing OS matrix, Linux dependencies, Bash frontend step, Tauri build arguments, and bundle upload path.

- [ ] **Step 5: Run all tests and validate the staged desktop frontend**

Run:

```bash
npm ci
npm test
npm run build:desktop
test -f dist-desktop/index.html
git diff --check
```

Expected: 13 tests pass, the desktop frontend exists, and `git diff --check` reports no whitespace errors.

- [ ] **Step 6: Commit the documentation and workflow**

```bash
git add README.md .github/workflows/desktop.yml tools/test-project-identity.js index.html index-lite.html manifest.json sw.js
git commit -m "Document MDedit as a Tauri desktop app"
```

### Task 4: Run local release verification

**Files:**
- Verify only; no intended source changes

- [ ] **Step 1: Verify JavaScript and generated frontend output**

Run:

```bash
npm test
bash ./build.sh
git diff --exit-code -- index.html index-lite.html manifest.json sw.js
```

Expected: 13 tests pass and rebuilding produces no diff.

- [ ] **Step 2: Verify Rust formatting, checks, and tests**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all three commands exit successfully.

- [ ] **Step 3: Confirm legacy product identities are absent from active product files**

Run:

```bash
git grep -n -I -E 'Free MD Viewer|free-md-viewer|free_md_viewer|com\.kingsbridge\.freedmdviewer|github\.com/(hattray|skanga)/markdown-editor|md-editor-|md-viewer-' -- ':!docs/superpowers/*'
```

Expected: no matches. Historical specification and plan files are excluded because they record the reason for and procedure of this rename.

- [ ] **Step 4: Review the exact change set**

Run:

```bash
git status --short
git diff HEAD~3 --stat
git log -4 --oneline
```

Expected: only the unrelated untracked `mcp-server.log` remains; the three implementation commits follow the already committed design document.

### Task 5: Rename GitHub, push, and verify installer artifacts

**Files:**
- External GitHub repository metadata
- Local Git remote configuration

- [ ] **Step 1: Reconfirm the destination is available and authentication targets skanga**

Run:

```bash
gh auth status
gh repo view skanga/mdedit --json name,url,visibility
gh repo view skanga/markdown-editor --json name,url,visibility,defaultBranchRef
```

Expected: authentication is active; `skanga/mdedit` is not found; the existing repository is public and its default branch is `tauri-desktop-shell`.

- [ ] **Step 2: Rename the public repository**

Run:

```bash
gh repo rename mdedit --repo skanga/markdown-editor --yes
```

Expected: GitHub reports success and `https://github.com/skanga/mdedit` resolves as a public repository.

- [ ] **Step 3: Add the approved GitHub description**

Run:

```bash
gh repo edit skanga/mdedit --description "A fast, private, cross-platform Markdown editor built with Tauri, featuring live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports."
```

Expected: `gh repo view skanga/mdedit --json description` returns that exact sentence.

- [ ] **Step 4: Point the checkout at the canonical URL and push**

Run:

```bash
git remote set-url origin https://github.com/skanga/mdedit.git
git remote -v
git push origin tauri-desktop-shell
```

Expected: both `origin` entries use the MDedit URL, the separate historical `upstream` remote remains unchanged, and the push succeeds.

- [ ] **Step 5: Trigger and watch the desktop build matrix**

Run:

```bash
gh workflow run desktop.yml --repo skanga/mdedit --ref tauri-desktop-shell
gh run list --repo skanga/mdedit --workflow desktop.yml --branch tauri-desktop-shell --limit 1 --json databaseId,url,status,conclusion
gh run watch RUN_ID --repo skanga/mdedit --exit-status
```

Replace `RUN_ID` with the returned numeric database ID. Expected: Windows, macOS, and Ubuntu jobs all complete successfully.

- [ ] **Step 6: Download and inspect the Windows artifact**

Run:

```bash
artifact_dir=$(mktemp -d)
gh run download RUN_ID --repo skanga/mdedit --name mdedit-windows-latest --dir "$artifact_dir"
find "$artifact_dir" -type f -printf '%P\n' | sort
```

Expected output includes:

```text
msi/MDedit_0.1.0_x64_en-US.msi
nsis/MDedit_0.1.0_x64-setup.exe
```

- [ ] **Step 7: Verify final GitHub and local state**

Run:

```bash
gh repo view skanga/mdedit --json name,url,visibility,description,defaultBranchRef
git status --short
git log -4 --oneline
```

Expected: the repository is public at `https://github.com/skanga/mdedit`, carries the approved description, uses `tauri-desktop-shell` as its default branch, and the only untracked workspace file is `mcp-server.log`.
