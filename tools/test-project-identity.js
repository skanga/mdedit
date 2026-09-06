const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  const filePath = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath);
  return fs.readFileSync(filePath, "utf8").replaceAll("\r\n", "\n");
}

function readMarkdownSection(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  assert.notEqual(start, -1);
  const end = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, end === -1 ? markdown.length : end);
}

test("readText normalizes Windows newlines", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdedit-newline-"));
  const fixture = path.join(tempDir, "fixture.txt");
  fs.writeFileSync(fixture, "first\r\nsecond\r\n", "utf8");
  try {
    assert.equal(readText(fixture), "first\nsecond\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readCargoMetadata() {
  const output = execFileSync(
    "cargo",
    [
      "metadata",
      "--locked",
      "--no-deps",
      "--format-version",
      "1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ],
    { cwd: root, encoding: "utf8" },
  );

  return JSON.parse(output);
}

test("npm metadata identifies the package as mdedit", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");

  assert.equal(packageJson.name, "mdedit");
  assert.equal(packageLock.name, "mdedit");
  assert.equal(packageLock.packages[""].name, "mdedit");
});

test("Cargo metadata identifies the mdedit package and targets", () => {
  const metadata = readCargoMetadata();
  const [workspacePackage] = metadata.packages;

  assert.equal(metadata.workspace_members.length, 1);
  assert.equal(metadata.packages.length, 1);
  assert.equal(workspacePackage.id, metadata.workspace_members[0]);
  assert.equal(workspacePackage.name, "mdedit");
  assert.ok(
    workspacePackage.targets.some(
      (target) => target.name === "mdedit" && target.kind.includes("bin"),
    ),
  );
  assert.ok(
    workspacePackage.targets.some(
      (target) => target.name === "mdedit_lib" && target.kind.includes("rlib"),
    ),
  );
});

test("the binary starts the mdedit library", () => {
  const mainRs = readText("src-tauri/src/main.rs");

  assert.equal(
    mainRs,
    "// Prevents an extra console window from opening on Windows in release builds.\n"
      + "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]\n\n"
      + "fn main() {\n    mdedit_lib::run()\n}\n",
  );
});

test("Tauri configuration identifies the MDedit application", () => {
  const tauriConfig = readJson("src-tauri/tauri.conf.json");

  assert.equal(tauriConfig.productName, "MDedit");
  assert.equal(tauriConfig.identifier, "com.skanga.mdedit");
  assert.equal(tauriConfig.app.windows[0].title, "MDedit");
});

test("README describes the MDedit desktop product and GitHub Releases downloads", () => {
  const readme = readText("README.md");
  const download = readMarkdownSection(readme, "## Download");
  const windowsInstallers = readMarkdownSection(readme, "## Windows installers");

  assert.ok(readme.startsWith("# MDedit\n"));
  for (const heading of ["## Download", "## Windows installers", "## Development"]) {
    assert.match(readme, new RegExp(`^${heading}$`, "m"));
  }
  assert.match(download, /github\.com\/skanga\/mdedit\/releases\/latest/);
  for (const assetPattern of [
    /MDedit_<version>_x64-setup\.exe/,
    /MDedit_<version>_x64_en-US\.msi/,
    /MDedit-portable-x64\.exe/,
    /MDedit_<version>_aarch64\.dmg/,
    /MDedit_<version>_amd64\.deb/,
  ]) {
    assert.match(download, assetPattern);
  }
  assert.doesNotMatch(readme, /github\.com\/skanga\/mdedit\/actions\//);
  assert.doesNotMatch(readme, /Actions artifacts/i);
  assert.doesNotMatch(readme, /workflow artifacts/i);
  assert.doesNotMatch(readme, /sign in before downloading/i);
  assert.doesNotMatch(readme, /^## (Browser support|The lite build|Self-hosting)$/m);
  assert.doesNotMatch(readme, /runs entirely in your browser/);

  assert.match(readme, /`MDedit-portable-x64\.exe`/);
  assert.match(readme, /Microsoft Edge WebView2/);
  assert.match(windowsInstallers, /`MDedit_<version>_x64-setup\.exe`/);
  assert.match(windowsInstallers, /`MDedit_<version>_x64_en-US\.msi`/);
  assert.doesNotMatch(windowsInstallers, /MDedit_0\.1\.0/);
});

test("CI publishes tagged desktop builds as a GitHub Release", () => {
  const workflow = readText(".github/workflows/desktop.yml");
  const releaseStart = workflow.indexOf("\n  release:\n");
  assert.notEqual(releaseStart, -1);
  const nextJob = workflow.slice(releaseStart + "\n  release:\n".length)
    .search(/\n  [A-Za-z0-9_-]+:\n/);
  const releaseEnd = nextJob === -1 ? workflow.length : releaseStart + "\n  release:\n".length + nextJob;
  const releaseJob = workflow.slice(releaseStart + 1, releaseEnd);

  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /name: mdedit-\$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /^permissions:\n  contents: read/m);
  assert.match(workflow, /if: runner\.os == 'Windows'/);
  assert.match(workflow, /src-tauri\/target\/release\/mdedit\.exe/);
  assert.match(workflow, /portable\/MDedit-portable-x64\.exe/);
  assert.match(workflow, /name: mdedit-windows-portable/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(releaseJob, /^  release:\s*$/m);
  assert.match(releaseJob, /needs: \[build, performance\]/);
  assert.match(releaseJob, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(releaseJob, /github\.event_name == 'push'/);
  assert.match(releaseJob, /permissions:\s*\n\s*contents: write/);
  assert.match(
    releaseJob,
    /uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\s+# v4/,
  );
  assert.match(releaseJob, /pattern: mdedit-\*/);
  assert.match(releaseJob, /tag must match vMAJOR\.MINOR\.PATCH/);
  assert.match(
    releaseJob,
    /if \[\[ ! "\$GITHUB_REF_NAME" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]; then/,
  );
  assert.match(releaseJob, /version=\$\{GITHUB_REF_NAME#v\}/);
  for (const asset of [
    "MDedit-portable-x64.exe",
    "MDedit_${version}_x64-setup.exe",
    "MDedit_${version}_x64_en-US.msi",
    "MDedit_${version}_aarch64.dmg",
    "MDedit_${version}_amd64.deb",
  ]) {
    assert.match(releaseJob, new RegExp(`"${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
  assert.match(releaseJob, /find release-inputs -type f -name "\$expected_asset" -print \| sort/);
  assert.match(releaseJob, /test "\$\{#matches\[@\]\}" -eq 1/);
  assert.match(releaseJob, /test -s "\$\{matches\[0\]\}"/);
  assert.match(releaseJob, /test "\$\{#staged_assets\[@\]\}" -eq 5/);
  assert.match(releaseJob, /test -s "\$staged_asset"/);
  assert.match(releaseJob, /gh api --include "repos\/\$GH_REPO\/releases\/tags\/\$GITHUB_REF_NAME"/);
  assert.match(releaseJob, /HTTP\/\[0-9\.\]\+ 404/);
  assert.match(releaseJob, /cat "\$release_lookup" >&2/);
  assert.match(releaseJob, /exit 1/);
  assert.match(releaseJob, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(releaseJob, /gh release upload "\$GITHUB_REF_NAME"/);
  assert.match(releaseJob, /--generate-notes/);
  assert.match(releaseJob, /--clobber/);
});

test("CI verifies desktop, browser, and explicit performance builds", () => {
  const workflow = readText(".github/workflows/desktop.yml");
  const buildStart = workflow.indexOf("\n  build:\n");
  const browserStart = workflow.indexOf("\n  browser-tests:\n");
  assert.notEqual(buildStart, -1);
  assert.notEqual(browserStart, -1);
  assert.ok(browserStart > buildStart);
  const buildJob = workflow.slice(buildStart, browserStart);
  const cargoTest = "cargo test --manifest-path src-tauri/Cargo.toml";
  const linuxSystemDeps = "sudo apt-get install -y libwebkit2gtk-4.1-dev";
  const bundle = "npx tauri build ${{ matrix.args }}";
  const npmTest = "run: npm test";

  for (const requiredStep of [npmTest, linuxSystemDeps, cargoTest, bundle]) {
    assert.notEqual(buildJob.indexOf(requiredStep), -1);
  }
  assert.ok(buildJob.indexOf(npmTest) < buildJob.indexOf(cargoTest));
  assert.ok(buildJob.indexOf(linuxSystemDeps) < buildJob.indexOf(cargoTest));
  assert.ok(buildJob.indexOf(cargoTest) < buildJob.indexOf(bundle));
  assert.match(workflow, /browser-tests:\n[\s\S]*?runs-on: ubuntu-latest/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /run: npm run test:browser/);
  assert.match(workflow, /performance:\n[\s\S]*?run: npm run test:performance/);
  assert.match(workflow, /performance:\n[\s\S]*?github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /performance:\n[\s\S]*?startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /name: tab-activation-metrics/);
  assert.match(workflow, /path: test-results\/tab-activation-metrics\.json/);
  const performanceTest = readText("tests/browser/performance.spec.js");
  assert.match(performanceTest, /path\.resolve\("test-results\/tab-activation-metrics\.json"\)/);
  assert.match(performanceTest, /fs\.writeFileSync\(metricsPath, serializedMetrics, "utf8"\)/);
});

test("README documents the multi-document workflow", () => {
  const readme = readText("README.md");

  for (const pattern of [
    /new tab/i,
    /switch(?:ing)? tabs/i,
    /Save All/,
    /dirty indicator/i,
    /restor/i,
    /external change/i,
    /Reload Disk Version/,
    /Keep Editing/,
    /Save Editor Version As/,
    /Save All & Quit/,
    /Quit and Restore Next Time/,
    /Discard All & Quit/,
    /Ctrl\+Tab/,
    /Ctrl\+Shift\+Tab/,
    /Ctrl\+W/,
  ]) {
    assert.match(readme, pattern);
  }
});

test("Playwright outputs are ignored", () => {
  assert.match(readText(".gitignore"), /^test-results\/$/m);
});

test("the tabbed editor smoke checklist covers every release platform and failure path", () => {
  const checklist = readText("docs/testing/tabbed-editor-smoke-checklist.md");

  for (const heading of ["## Windows", "## macOS", "## Linux"]) {
    assert.match(checklist, new RegExp(`^${heading}$`, "m"));
  }
  for (const pattern of [
    /MDedit version/i,
    /operating-system version/i,
    /result/i,
    /recovery-data location/i,
    /startup file association/i,
    /second-instance open/i,
    /normal quit/i,
    /forced termination/i,
    /external edit/i,
    /file deletion/i,
    /recovery-directory failure/i,
  ]) {
    assert.match(checklist, pattern);
  }
  assert.equal((checklist.match(/Reload Disk Version/g) || []).length, 3);
  assert.equal((checklist.match(/Save Editor Version As/g) || []).length, 3);
  assert.doesNotMatch(checklist, /Reload from Disk/);
});

test("the desktop UI identity is consistent across template and generated builds", () => {
  const formerProductName = ["Free", "MD", "Viewer"].join(" ");
  const legacyRepoSlug = ["markdown", "editor"].join("-");
  const legacyEditorPrefix = ["md", "editor"].join("-");
  const legacyViewerPrefix = ["md", "viewer"].join("-");
  const formerGitHubUrls = [
    `github.com/hattray/${legacyRepoSlug}`,
    `github.com/skanga/${legacyRepoSlug}`,
  ];
  const legacyStorageKeys = [
    `${legacyEditorPrefix}-draft-v1`,
    `${legacyEditorPrefix}-theme`,
    `${legacyEditorPrefix}-toc`,
    `${legacyEditorPrefix}-reader`,
    `${legacyViewerPrefix}-draft-v1`,
    `${legacyViewerPrefix}-theme`,
    `${legacyViewerPrefix}-toc`,
    `${legacyViewerPrefix}-reader`,
  ];
  const fullDescription = "A fast, private desktop Markdown editor with live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports.";
  const liteDescription = "A fast, private Markdown editor with live preview, local file handling, and offline exports.";

  for (const file of ["src/index.template.html", "index.html", "index-lite.html"]) {
    const html = readText(file);
    const joinedHtmlStrings = html.replaceAll(/"\s*\+\s*"/g, "");
    const helpStart = html.indexOf("function buildHelp()");
    const helpEnd = html.indexOf('$("btn-help").addEventListener', helpStart);
    assert.notEqual(helpStart, -1);
    assert.notEqual(helpEnd, -1);
    assert.ok(helpEnd > helpStart);
    const helpSource = html.slice(helpStart, helpEnd);

    assert.match(html, /MDedit/);
    assert.match(html, /github\.com\/skanga\/mdedit/);
    assert.equal(
      html.includes(file === "index-lite.html"
        ? "<title>MDedit (lite) — Markdown editor</title>"
        : "<title>MDedit — Markdown editor</title>"),
      true,
    );
    assert.equal(
      html.includes(`<meta name="description" content="${file === "index-lite.html" ? liteDescription : fullDescription}">`),
      true,
    );
    assert.match(html, /\.md, \.markdown or any text file — it stays on your device/);
    assert.match(html, /legacyStorage:\s*{/);
    assert.doesNotMatch(html, /function loadDraft\(/);
    assert.match(joinedHtmlStrings, /Drop a <code>\.md<\/code> file anywhere in the window, or use Open\. Save writes directly to the current file; Save as creates a new copy\./);
    assert.match(html, /# Welcome to MDedit/);
    assert.match(html, /A fast, private desktop Markdown editor — \*\*your documents stay on your device\*\*\./);
    assert.match(html, /Drop\*\* a Markdown file anywhere in the window, or use \*\*Open\*\*/);
    assert.match(html, /Type on the left and see the rendered document on the right/);
    assert.match(html, /\*\*Save\*\* writes back to the current file; \*\*Save as\*\* creates a new copy/);
    assert.match(html, /Your work is restored automatically if the app closes unexpectedly/);
    assert.equal(html.includes(formerProductName), false);
    for (const url of formerGitHubUrls) assert.equal(html.includes(url), false);
    assert.doesNotMatch(html, /class="brand"/);
    assert.doesNotMatch(html, /id="lite-tag"/);
    assert.equal(helpSource.includes("Hover a table or a diagram"), false);
    assert.equal(helpSource.includes("Install it in Chrome or Edge"), false);
    assert.equal(helpSource.includes("Need something custom?"), false);
    assert.equal(helpSource.includes("support@kingsbridge-consultancy.com"), false);
    assert.equal(helpSource.includes("custom build enquiry"), false);
    for (const key of legacyStorageKeys) assert.equal(html.includes(key), false);
  }
});

test("generated builds contain the tabbed session modules and accessible tab strip", () => {
  for (const file of ["index.html", "index-lite.html"]) {
    const html = readText(file);
    assert.match(html, /id="document-tabs" role="tablist"/);
    assert.match(html, /class SessionModel/);
    assert.match(html, /class RecoveryScheduler/);
    assert.match(html, /Quit and Restore Next Time/);
    assert.doesNotMatch(html, /async readFile\(path\)/);
    assert.doesNotMatch(html, /async saveAs\(\{/);
    assert.doesNotMatch(html, /writeTextFile/);
    assert.match(html, /raw byte data/);
  }
});

test("the native capability description includes recovery and multi-document access", () => {
  const capability = readJson("src-tauri/capabilities/default.json");
  assert.match(capability.description, /multi-document/i);
  assert.match(capability.description, /recovery/i);
  assert.deepEqual(capability.permissions, [
    "core:default",
    "dialog:default",
    { "identifier": "fs:allow-write-file", "allow": [{ "path": "**" }] },
  ]);
});

test("the lite build marks its attribution banner", () => {
  assert.equal(
    readText("build.sh").includes('doc.replace("MDedit —", "MDedit (lite) —", 1)'),
    true,
  );
});

test("PWA metadata identifies MDedit", () => {
  for (const file of ["pwa/manifest.json", "manifest.json"]) {
    const manifest = readJson(file);

    assert.equal(manifest.name, "MDedit");
    assert.equal(manifest.short_name, "MDedit");
  }

  for (const file of ["pwa/sw.js", "sw.js"]) {
    const worker = readText(file);

    assert.match(worker, /Service worker for MDedit\./);
    assert.match(worker, /const CACHE = "mdedit-shell-v1";/);
  }
});
