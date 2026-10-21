const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = path => fs.readFileSync(path, 'utf8');

test('CI checks generated artifacts and rebuilds browser inputs on main pushes', () => {
  const workflow = read('.github/workflows/desktop.yml');
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(workflow, /branches: \[main\]/);
  assert.equal(scripts['pretest:browser'], 'bash ./build.sh');
  assert.equal(scripts['check:generated'], 'bash ./build.sh --check');
  assert.match(workflow, /run: npm run check:generated/);
});

test('bootstrap delegates find state and does not mutate dirty state or patch view methods', () => {
  const source = read('src/index.template.html');
  assert.match(source, /MDEdit\.createFindController\(/);
  assert.doesNotMatch(source, /active\.dirty\s*=/);
  assert.doesNotMatch(source, /workspaceView\.(?:renderDocument|beforeReloadDocument|clearPreview|setPreview)\s*=/);
  assert.doesNotMatch(source, /browserFileHandles/);
});

test('bootstrap delegates Markdown preparation to workers and sanitizes the returned HTML', () => {
  const source = read('src/index.template.html');
  assert.match(source, /MDEdit\.createMarkdownParser\(/);
  assert.match(source, /DOMPurify\.sanitize\(result\.html\)/);
  assert.doesNotMatch(source, /\bmarked\.(?:parse|use)\(/);
  assert.doesNotMatch(source, /function extractMath\(/);
});

test('bootstrap delegates syntax highlighting to a bundled worker and sanitizes text-preserving spans', () => {
  const source = read('src/index.template.html');
  assert.match(source, /id="highlight-library"/);
  assert.match(source, /MDEdit\.createSyntaxHighlighter\(/);
  assert.doesNotMatch(source, /\bhljs\.highlight\(/);
  assert.match(source, /RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: \["span"\]/);
  assert.match(source, /fragment\.textContent !== blocks\[index\]\.text/);
  assert.match(read('build.sh'), /__SYNTAX_HIGHLIGHTER__/);
  assert.match(JSON.parse(read('package.json')).scripts['test:browser'], /highlighting\.spec\.js/);
});

test('bootstrap injects snapshot serialization and awaits transaction encodings', () => {
  const source = read('src/index.template.html');
  assert.match(source, /MDEdit\.createSnapshotSerializer\(\{ window \}\)/);
  assert.match(source, /snapshotSerializer,/);
  assert.match(source, /const snapshotJson = await controlledSnapshot/);
  assert.doesNotMatch(source, /JSON\.stringify\(model\.toSnapshot\(\)\)/);
  assert.doesNotMatch(read('src/session-controller.js'), /JSON\.stringify\(document\.toSnapshot\(\)\)/);
});

test('browser recovery injects the shared snapshot parser and its regressions run in CI', () => {
  const source = read('src/index.template.html');
  assert.match(source, /createBrowserRecoveryEnvironment\(window,\s*\{\s*snapshotParser: json => snapshotSerializer\.parse\(json\)/);
  assert.ok(source.indexOf('const snapshotSerializer =') < source.indexOf('const browserRecoveryEnvironment ='));
  assert.match(JSON.parse(read('package.json')).scripts['test:browser'], /recovery-storage\.spec\.js/);
});

test('CI exercises the actual Linux release WebView through WebDriver', () => {
  const workflow = read('.github/workflows/desktop.yml');
  assert.match(workflow, /webkit2gtk-driver/);
  assert.match(workflow, /cargo install tauri-driver --locked/);
  assert.match(workflow, /xvfb-run -a python3 tools\/smoke-desktop.py/);
});

test('desktop CSP disables inline scripts and unnecessary document capabilities', () => {
  const csp = JSON.parse(read('src-tauri/tauri.conf.json')).app.security.csp;
  assert.equal(typeof csp, 'string');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(?:inline|eval)'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});

test('document and recovery IPC commands dispatch blocking I/O off the webview thread', () => {
  for (const [file, commands] of [
    ['src-tauri/src/document_io.rs', ['read_document', 'save_document', 'canonicalize_document_path']],
    ['src-tauri/src/recovery.rs', ['load_recovery_manifest', 'write_recovery_manifest', 'load_recovery_document', 'write_recovery_document', 'delete_recovery_document']],
  ]) {
    const source = read(file);
    for (const command of commands) {
      assert.match(source, new RegExp(`async fn ${command}\\(`), command);
    }
    assert.match(source, /blocking::run\(move \|\|/);
  }
});
