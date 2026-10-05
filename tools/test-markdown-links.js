const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalMarkdownLink } = require('../src/markdown-links.js');

test('local Markdown references distinguish documents from external URLs and attachments', () => {
  for (const reference of ['README.md', '../docs/a%20b.MD#intro', './a.markdown?raw=1', 'a.mdown', 'a.mkd', '/docs/a.md', 'C:/docs/a.md', 'a%2emd']) {
    assert.equal(isLocalMarkdownLink(reference), true, reference);
  }
  for (const reference of ['', null, '#a.md', 'https://example.com/a.md', '//example.com/a.md', 'mailto:a.md', 'data:text/markdown,a.md', 'image.png', 'report.pdf', 'a.md.html']) {
    assert.equal(isLocalMarkdownLink(reference), false, reference);
  }
  // Malformed local references are still intercepted; the native resolver rejects them.
  assert.equal(isLocalMarkdownLink('%zz.md'), true);
});
