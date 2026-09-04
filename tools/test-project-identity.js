const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

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
  const mainRs = readText("src-tauri/src/main.rs").replaceAll("\r\n", "\n");

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

test("the desktop UI identity is consistent across template and generated builds", () => {
  const formerProductName = "Free MD Viewer";
  const formerGitHubUrls = [
    "github.com/hattray/markdown-editor",
    "github.com/skanga/markdown-editor",
  ];
  const legacyStorageKeys = [
    "md-editor-draft-v1",
    "md-editor-theme",
    "md-editor-toc",
    "md-editor-reader",
    "md-viewer-draft-v1",
    "md-viewer-theme",
    "md-viewer-toc",
    "md-viewer-reader",
  ];
  const fullDescription = "A fast, private desktop Markdown editor with live preview, Mermaid diagrams, KaTeX math, native file handling, and offline exports.";
  const liteDescription = "A fast, private Markdown editor with live preview, local file handling, and offline exports.";

  for (const file of ["src/index.template.html", "index.html", "index-lite.html"]) {
    const html = readText(file);
    const joinedHtmlStrings = html.replaceAll(/"\s*\+\s*"/g, "");
    const helpSource = html.slice(html.indexOf("function buildHelp()"), html.indexOf('  $("btn-help")'));

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
    assert.match(html, /setStatus\("Draft restored"\);/);
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
