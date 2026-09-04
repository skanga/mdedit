# GitHub Releases Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish MDedit installers through GitHub Releases, redirect users to the Releases page, and create the initial `v0.1.0` release.

**Architecture:** The existing desktop build matrix continues to produce per-platform workflow artifacts. A tag-only downstream job downloads all matrix outputs, stages exactly five public packages, and creates or updates the matching GitHub Release through the GitHub CLI. Manual workflow dispatch remains a build-only path.

**Tech Stack:** GitHub Actions YAML, GitHub CLI, Node.js built-in test runner, Tauri 2 build outputs, Bash

---

### Task 1: Specify release-oriented download behavior

**Files:**
- Modify: `tools/test-project-identity.js`
- Test: `tools/test-project-identity.js`

- [ ] **Step 1: Replace the Actions-download expectations with failing release expectations**

In the `README and CI describe the MDedit desktop product` test, replace the old workflow-download assertion and add release-workflow assertions:

```js
  assert.match(readme, /github\.com\/skanga\/mdedit\/releases\/latest/);
  assert.doesNotMatch(readme, /actions\/workflows\/desktop\.yml/);
  assert.doesNotMatch(readme, /workflow artifacts/);

  assert.match(workflow, /^  release:$/m);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /uses: actions\/download-artifact@v4/);
  assert.match(workflow, /pattern: mdedit-\*/);
  assert.match(workflow, /test "\$\{#assets\[@\]\}" -eq 5/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /--clobber/);
```

Keep the existing assertions for the portable executable, NSIS/MSI paths, Windows gating, and missing-file failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tools/test-project-identity.js
```

Expected: FAIL because the README still links to Actions and `.github/workflows/desktop.yml` has no `release` job.

- [ ] **Step 3: Commit the failing test**

```bash
git add tools/test-project-identity.js
git commit -m "Test GitHub Releases distribution"
```

### Task 2: Publish tagged builds as GitHub Releases

**Files:**
- Modify: `.github/workflows/desktop.yml`
- Test: `tools/test-project-identity.js`

- [ ] **Step 1: Give build jobs read-only repository access**

Add this top-level permission immediately after the workflow triggers:

```yaml
permissions:
  contents: read
```

- [ ] **Step 2: Add the tag-gated release job**

Append this job after `build`:

```yaml
  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Download desktop artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: mdedit-*
          path: release-inputs
      - name: Stage release assets
        shell: bash
        run: |
          set -euo pipefail
          mkdir release-assets
          find release-inputs -type f \( \
            -name 'MDedit-portable-x64.exe' -o \
            -name 'MDedit_*-setup.exe' -o \
            -name 'MDedit_*_en-US.msi' -o \
            -name 'MDedit_*.dmg' -o \
            -name 'MDedit_*_amd64.deb' \
          \) -exec cp {} release-assets/ \;
          mapfile -t assets < <(find release-assets -maxdepth 1 -type f | sort)
          printf '%s\n' "${assets[@]}"
          test "${#assets[@]}" -eq 5
      - name: Publish GitHub Release
        shell: bash
        env:
          GH_REPO: ${{ github.repository }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            gh release upload "$GITHUB_REF_NAME" release-assets/* --clobber
          else
            gh release create "$GITHUB_REF_NAME" release-assets/* \
              --title "MDedit $GITHUB_REF_NAME" \
              --generate-notes
          fi
```

The expected selected files for version `0.1.0` are:

```text
MDedit-portable-x64.exe
MDedit_0.1.0_x64-setup.exe
MDedit_0.1.0_x64_en-US.msi
MDedit_0.1.0_aarch64.dmg
MDedit_0.1.0_amd64.deb
```

- [ ] **Step 3: Run the focused test and verify the workflow assertions pass**

Run:

```bash
node --test tools/test-project-identity.js
```

Expected: the workflow assertions pass; the test may still fail on the README release-link assertion until Task 3.

- [ ] **Step 4: Commit the release workflow**

```bash
git add .github/workflows/desktop.yml
git commit -m "Publish tagged builds to GitHub Releases"
```

### Task 3: Direct users to GitHub Releases

**Files:**
- Modify: `README.md`
- Test: `tools/test-project-identity.js`

- [ ] **Step 1: Rewrite the Download section**

Replace the Actions artifact paragraph and table with:

```markdown
Download the latest stable build from [GitHub Releases](https://github.com/skanga/mdedit/releases/latest).

| Download | Platform | Use case |
| --- | --- | --- |
| `MDedit_<version>_x64-setup.exe` | Windows x64 | Recommended NSIS installer |
| `MDedit_<version>_x64_en-US.msi` | Windows x64 | Managed or administrator-led MSI deployment |
| `MDedit-portable-x64.exe` | Windows x64 | Portable executable with no installation |
| `MDedit_<version>_aarch64.dmg` | macOS Apple silicon | macOS disk image |
| `MDedit_<version>_amd64.deb` | Ubuntu/Debian x64 | Debian package |

These builds are currently unsigned, so your operating system may show a security warning.
```

Change `.github/workflows/desktop.yml` in the Project structure table from “Desktop CI build and artifact workflow” to “Desktop build and GitHub Release workflow.” Leave the detailed Windows installer guidance intact.

- [ ] **Step 2: Run the full test suite and verify GREEN**

Run:

```bash
npm test
```

Expected: 19 tests pass, 0 fail.

- [ ] **Step 3: Verify generated desktop assets remain deterministic**

Run:

```bash
npm run build:desktop
git diff --exit-code -- index.html index-lite.html manifest.json sw.js src-tauri/frontend
```

Expected: the build exits 0 and the generated files have no diff.

- [ ] **Step 4: Commit the README change**

```bash
git add README.md
git commit -m "Direct downloads to GitHub Releases"
```

### Task 4: Verify and integrate the automated release path

**Files:**
- Verify: `.github/workflows/desktop.yml`
- Verify: `README.md`
- Verify: `tools/test-project-identity.js`

- [ ] **Step 1: Run all local verification gates**

```bash
npm test
npm run build:desktop
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
git diff --check main...HEAD
git status --short
```

Expected: every command exits 0; the worktree is clean after generated-file checks; only the intended commits differ from `main`.

- [ ] **Step 2: Review workflow permissions and trigger gates**

Confirm:

```text
manual workflow_dispatch -> build jobs only
v* tag push -> build jobs, then release job
failed matrix build -> no release job
build jobs -> contents: read
release job -> contents: write
```

- [ ] **Step 3: Merge the reviewed branch into `main` and push**

Use the `superpowers:finishing-a-development-branch` workflow. Fast-forward `main` only after both requirements and code-quality reviews approve the change, then push `main` to `origin`.

### Task 5: Publish and verify the initial v0.1.0 release

**Files:**
- External state: Git tag `v0.1.0`
- External state: GitHub Release `v0.1.0`
- Source artifacts: successful run `33888949813`

- [ ] **Step 1: Download the five verified build outputs into isolated directories**

```bash
release_dir="$(mktemp -d /tmp/mdedit-v0.1.0.XXXXXX)"
gh run download 33888949813 -R skanga/mdedit -n mdedit-windows-portable -D "$release_dir/windows-portable"
gh run download 33888949813 -R skanga/mdedit -n mdedit-windows-latest -D "$release_dir/windows"
gh run download 33888949813 -R skanga/mdedit -n mdedit-macos-latest -D "$release_dir/macos"
gh run download 33888949813 -R skanga/mdedit -n mdedit-ubuntu-latest -D "$release_dir/linux"
mkdir "$release_dir/release"
cp "$release_dir/windows-portable/MDedit-portable-x64.exe" "$release_dir/release/"
cp "$release_dir/windows/nsis/MDedit_0.1.0_x64-setup.exe" "$release_dir/release/"
cp "$release_dir/windows/msi/MDedit_0.1.0_x64_en-US.msi" "$release_dir/release/"
cp "$release_dir/macos/dmg/MDedit_0.1.0_aarch64.dmg" "$release_dir/release/"
cp "$release_dir/linux/deb/MDedit_0.1.0_amd64.deb" "$release_dir/release/"
```

Expected: every download and copy exits 0.

- [ ] **Step 2: Verify the staged release assets**

```bash
find "$release_dir/release" -maxdepth 1 -type f -size +0 -printf '%f\t%s bytes\n' | sort
```

Expected: exactly the five filenames listed in Task 2, all with nonzero sizes.

- [ ] **Step 3: Create the release at the verified build commit**

Run only after confirming that neither the tag nor release exists:

```bash
git ls-remote --tags origin refs/tags/v0.1.0
gh release view v0.1.0 -R skanga/mdedit
gh release create v0.1.0 "$release_dir/release/"* \
  -R skanga/mdedit \
  --target 2f21a06a019bc5d066b9fad4aeaf34bbb8bf8cfc \
  --title "MDedit v0.1.0" \
  --generate-notes \
  --latest
```

Expected: the first two checks confirm absence, and `gh release create` returns the public release URL.

- [ ] **Step 4: Verify the public release and assets**

```bash
gh release view v0.1.0 -R skanga/mdedit \
  --json url,tagName,isDraft,isPrerelease,targetCommitish,assets
gh api repos/skanga/mdedit/releases/latest --jq '.tag_name'
```

Expected: `tagName` is `v0.1.0`; the release is not draft or prerelease; `targetCommitish` resolves to commit `2f21a06a019bc5d066b9fad4aeaf34bbb8bf8cfc`; all five expected assets appear with nonzero sizes; the latest-release API returns `v0.1.0`.

- [ ] **Step 5: Verify the README destination**

Open `https://github.com/skanga/mdedit/releases/latest` and confirm it resolves to the public `v0.1.0` release without requiring access to an Actions workflow run.
