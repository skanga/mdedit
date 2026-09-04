# MDedit Windows Portable Executable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the raw Windows x64 MDedit release binary as a single-file portable GitHub Actions artifact alongside the NSIS and MSI installers.

**Architecture:** Keep the existing Tauri matrix build unchanged. After the Windows build completes, copy the generated release binary into a one-file staging directory under a stable user-facing filename, upload it as a dedicated artifact, and lock the workflow contract with the existing project-identity test.

**Tech Stack:** Tauri 2, Rust, GitHub Actions, PowerShell, Node.js test runner

---

### Task 1: Publish and document the portable Windows executable

**Files:**
- Modify: `tools/test-project-identity.js`
- Modify: `.github/workflows/desktop.yml`
- Modify: `README.md`

- [ ] **Step 1: Write the failing portable-artifact contract test**

Add these assertions to `README and CI describe the MDedit desktop product` in `tools/test-project-identity.js`:

```js
  assert.match(readme, /`mdedit-windows-portable`/);
  assert.match(readme, /`MDedit-portable-x64\.exe`/);
  assert.match(readme, /Microsoft Edge WebView2/);

  assert.match(workflow, /if: runner\.os == 'Windows'/);
  assert.match(workflow, /src-tauri\/target\/release\/mdedit\.exe/);
  assert.match(workflow, /MDedit-portable-x64\.exe/);
  assert.match(workflow, /name: mdedit-windows-portable/);
  assert.match(workflow, /if-no-files-found: error/);
```

- [ ] **Step 2: Run the focused test and verify the contract fails**

Run:

```bash
node --test --test-name-pattern="README and CI" tools/test-project-identity.js
```

Expected: the test fails because the portable artifact is absent from the workflow and README.

- [ ] **Step 3: Stage the raw Windows release binary**

Add this step after `Build desktop bundles` in `.github/workflows/desktop.yml`:

```yaml
      - name: Stage portable Windows executable
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path portable | Out-Null
          Copy-Item src-tauri/target/release/mdedit.exe portable/MDedit-portable-x64.exe
```

This keeps the release binary byte-for-byte identical while giving it a clear download name.

- [ ] **Step 4: Upload the portable file as its own artifact**

Add this step after the existing bundle upload:

```yaml
      - name: Upload portable Windows executable
        if: runner.os == 'Windows'
        uses: actions/upload-artifact@v4
        with:
          name: mdedit-windows-portable
          path: portable/MDedit-portable-x64.exe
          if-no-files-found: error
```

Keep the existing `mdedit-${{ matrix.os }}` bundle upload unchanged so Windows continues to publish NSIS and MSI installers.

- [ ] **Step 5: Document the portable artifact and its limits**

Add this row to the README Download table:

```markdown
| `mdedit-windows-portable` | Windows x64 | Single portable `.exe` |
```

Extend `## Windows installers` with:

```markdown
For installation-free use, download `MDedit-portable-x64.exe` from the `mdedit-windows-portable` artifact and run it directly. The portable executable does not create shortcuts or register Markdown file associations. It uses the Microsoft Edge WebView2 runtime installed on the system; use the NSIS installer if WebView2 needs to be installed or repaired. Preferences and restored drafts may still use standard Windows application-data locations.
```

Keep the NSIS installer as the recommendation for most users and retain the MSI deployment guidance.

- [ ] **Step 6: Run local verification**

Run:

```bash
npm test
npm run build:desktop
git diff --exit-code -- index.html index-lite.html manifest.json sw.js
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all 18 Node tests pass, generated frontend files remain unchanged, Rust checks pass, and the diff has no whitespace errors.

- [ ] **Step 7: Commit the portable artifact support**

```bash
git add .github/workflows/desktop.yml README.md tools/test-project-identity.js
git commit -m "Publish portable Windows executable"
```

### Task 2: Verify the Windows artifacts on GitHub

**Files:**
- Verify external GitHub Actions output only

- [ ] **Step 1: Trigger the desktop workflow after the branch is pushed**

```bash
gh workflow run desktop.yml --repo skanga/mdedit --ref tauri-desktop-shell
gh run list --repo skanga/mdedit --workflow desktop.yml --branch tauri-desktop-shell --limit 1 --json databaseId,url,status,conclusion
gh run watch RUN_ID --repo skanga/mdedit --exit-status
```

Replace `RUN_ID` with the returned database ID. Expected: Windows, macOS, and Ubuntu jobs succeed.

- [ ] **Step 2: Download the portable artifact into a temporary directory**

```bash
portable_dir=$(mktemp -d)
gh run download RUN_ID --repo skanga/mdedit --name mdedit-windows-portable --dir "$portable_dir"
find "$portable_dir" -type f -printf '%P\n'
```

Expected: exactly one file is listed:

```text
MDedit-portable-x64.exe
```

- [ ] **Step 3: Confirm the installer artifact remains intact**

```bash
installer_dir=$(mktemp -d)
gh run download RUN_ID --repo skanga/mdedit --name mdedit-windows-latest --dir "$installer_dir"
find "$installer_dir" -type f -printf '%P\n' | sort
```

Expected output includes:

```text
msi/MDedit_0.1.0_x64_en-US.msi
nsis/MDedit_0.1.0_x64-setup.exe
```
