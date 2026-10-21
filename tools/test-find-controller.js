const test = require('node:test');
const assert = require('node:assert/strict');
const { createFindController } = require('../src/find-controller');
const { createSearchRunner } = require('../src/search-runner');
const { searchMatches } = require('../src/editor-tools');

function fixture(value) {
  const elements = new Map();
  let reads = 0;
  const editor = { get value() { reads++; return value; } };
  const document = {
    defaultView: { MDEdit: { createSearchRunner, searchMatches }, addEventListener() {} },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', checked: false, addEventListener() {}, setAttribute() {}, classList: { toggle() {} } });
      return elements.get(id);
    },
  };
  const find = createFindController({ document, activeEditor: () => editor,
    replaceRange() {}, onChange() {}, setView() {}, setStatus() {}, isActiveEditorEvent: () => true });
  return { find, elements, reads: () => reads };
}

test('an empty Find refresh never reads the active document content', async () => {
  const { find, reads } = fixture('x'.repeat(5 * 1024 * 1024));
  assert.equal(await find.refresh(), true);
  assert.equal(reads(), 0);
});

test('a nonempty Find refresh still searches actual textarea content', async () => {
  const { find, elements, reads } = fixture('cat dog');
  elements.get('find-input').value = 'cat';
  assert.equal(await find.refresh(), true);
  assert.equal(elements.get('find-count').textContent, '1/1');
  assert.ok(reads() > 0);
});
