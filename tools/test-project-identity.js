const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("npm metadata identifies the package as mdedit", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");

  assert.equal(packageJson.name, "mdedit");
  assert.equal(packageLock.name, "mdedit");
  assert.equal(packageLock.packages[""].name, "mdedit");
});

test("Cargo metadata identifies the package and library as mdedit", () => {
  const cargoToml = readText("src-tauri/Cargo.toml");

  assert.match(cargoToml, /\[package\][\s\S]*?\nname = "mdedit"/);
  assert.match(cargoToml, /\[lib\][\s\S]*?\nname = "mdedit_lib"/);
});

test("Cargo lockfile records mdedit as the root package", () => {
  const cargoLock = readText("src-tauri/Cargo.lock");
  const packages = cargoLock.split("[[package]]").slice(1);
  const rootPackage = packages.find((pkg) => /^name = "mdedit"$/m.test(pkg));

  assert.ok(rootPackage, "Cargo.lock should contain the mdedit root package");
});

test("the binary starts the mdedit library", () => {
  assert.match(readText("src-tauri/src/main.rs"), /mdedit_lib::run\(\)/);
});

test("Tauri configuration identifies the MDedit application", () => {
  const tauriConfig = readJson("src-tauri/tauri.conf.json");

  assert.equal(tauriConfig.productName, "MDedit");
  assert.equal(tauriConfig.identifier, "com.skanga.mdedit");
  assert.equal(tauriConfig.app.windows[0].title, "MDedit");
});
