const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controller = require('../src/session-controller');
const recovery = require('../src/browser-recovery');
const { createExportOperation, runCapturedExport } = require('../src/export-service');

const capture = Object.freeze({ documentId: 'a', editRevision: 3, format: 'html', content: 'source' });

test('controller retains browser recovery API compatibility without owning storage implementation', () => {
  for (const name of ['BROWSER_RECOVERY_PREFIX', 'createBrowserRecoveryIo', 'createBrowserRecoveryEnvironment']) {
    assert.equal(controller[name], recovery[name]);
  }
  const source = fs.readFileSync('src/session-controller.js', 'utf8');
  assert.doesNotMatch(source, /function createBrowserRecoveryIo\(/);
  assert.doesNotMatch(source, /storage\.setItem\(/);
});

test('browser service modules load before the controller and keep compatibility exports', () => {
  const context = vm.createContext({ window: { MDEdit: {} } });
  for (const file of ['document-model', 'session-model', 'browser-recovery', 'export-service', 'session-controller']) {
    vm.runInContext(fs.readFileSync(`src/${file}.js`, 'utf8'), context, { filename: file });
  }
  const api = context.window.MDEdit;
  assert.equal(typeof api.createBrowserRecoveryIo, 'function');
  assert.equal(typeof api.createExportOperation, 'function');
  assert.equal(typeof api.SessionController, 'function');
});

test('export service rejects absent isolated renderers before invoking the exporter', async () => {
  let exports = 0;
  const operation = createExportOperation(capture, null, () => { exports++; });
  await assert.rejects(operation(), /isolated HTML export renderer is unavailable/);
  assert.equal(exports, 0);
});

test('export service suppresses stale success without suppressing the operation result', async () => {
  const statuses = [];
  let current = true;
  const operation = async (received, isCurrent) => {
    assert.equal(received, capture);
    assert.equal(isCurrent({ requireActive: true }), true);
    current = false;
    return { message: 'saved elsewhere' };
  };
  const result = await runCapturedExport({ capture, label: 'a.md', operation,
    isCurrent: () => current, owns: () => true, setStatus: status => statuses.push(status) });
  assert.equal(result.message, 'saved elsewhere');
  assert.deepEqual(statuses.map(status => status.status), ['exporting']);
});

test('export service normalizes failures but never updates a closed document', async () => {
  const statuses = [];
  await assert.rejects(runCapturedExport({ capture, label: 'a.md', operation: async () => { throw 'disk failed'; },
    isCurrent: () => false, owns: () => false, setStatus: status => statuses.push(status) }), /disk failed/);
  assert.deepEqual(statuses.map(status => status.status), ['exporting']);
});
