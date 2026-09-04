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
