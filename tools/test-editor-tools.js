const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../src/editor-tools.js');
const apply = (value, edit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end);
test('toolbar block commands convert and toggle selected lines without touching the next line', () => {
  const value = 'one\ntwo\nthree';
  assert.equal(apply(value, tools.formatEdit(value, 0, 8, 'list-numbered')), '1. one\n2. two\nthree');
  assert.equal(apply('- one\n- two', tools.formatEdit('- one\n- two', 0, 11, 'list-bullet')), 'one\ntwo');
  assert.equal(apply('  2. one', tools.formatEdit('  2. one', 0, 8, 'list-task')), '  - [ ] one');
  assert.equal(apply('one\ntwo', tools.formatEdit('one\ntwo', 0, 7, 'quote')), '> one\n> two');
});
test('toolbar insertions create usable Markdown and select editable placeholders', () => {
  const table = tools.formatEdit('beforeafter', 6, 6, 'table');
  assert.equal(apply('beforeafter', table), 'before\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |\n\nafter');
  assert.equal(table.text.slice(table.selectionStart - table.start, table.selectionEnd - table.start), 'Column 1');
  assert.equal(apply('', tools.formatEdit('', 0, 0, 'rule')), '---\n\n');
  assert.equal(apply('alt', tools.formatEdit('alt', 0, 3, 'image')), '![alt](image.png)');
  assert.equal(apply('x', tools.formatEdit('x', 0, 1, 'equation')), '$x$');
});
test('formatting wraps, toggles and preserves selection', () => {
  assert.equal(apply('hello world', tools.formatEdit('hello world', 6, 11, 'bold')), 'hello **world**');
  assert.equal(apply('**world**', tools.formatEdit('**world**', 2, 7, 'bold')), 'world');
  assert.equal(apply('title\nsecond', tools.formatEdit('title\nsecond', 0, 12, 'heading-2')), '## title\n## second');
  assert.equal(apply('hello', tools.formatEdit('hello', 0, 5, 'link')), '[hello](https://)');
});
test('smart lists continue numbers and unchecked tasks and exit empty items', () => {
  assert.equal(apply('9. Nine', tools.listEdit('9. Nine', 7, 7)), '9. Nine\n10. ');
  assert.equal(apply('  - [x] Done', tools.listEdit('  - [x] Done', 12, 12)), '  - [x] Done\n  - [ ] ');
  assert.equal(apply('- one\n- ', tools.listEdit('- one\n- ', 8, 8)), '- one\n');
  assert.equal(tools.listEdit('```\n- code', 10, 10), null);
});
test('search supports case, Unicode whole words, regex groups, zero-width and invalid patterns', () => {
  assert.equal(tools.searchMatches('Cat cat scatter', 'cat', {wholeWord:true}).matches.length, 2);
  assert.equal(tools.searchMatches('Cat cat', 'cat', {caseSensitive:true}).matches.length, 1);
  assert.equal(tools.searchMatches('écat cat caté', 'cat', {wholeWord:true}).matches.length, 1);
  const result = tools.searchMatches('item12', '(item)(\\d+)', {regex:true});
  assert.equal(tools.replacementText('$2-$1-$$', result.matches[0], true), '12-item-$');
  assert.equal(tools.searchMatches('abc', '(?=.)', {regex:true}).matches.length, 3);
  assert.ok(tools.searchMatches('abc', '[', {regex:true}).error);
});

test('inline code toggles complete fences without corrupting embedded backticks', () => {
  assert.equal(apply('``a`b``', tools.formatEdit('``a`b``', 0, 7, 'code')), 'a`b');
  assert.equal(apply('`` a` ``', tools.formatEdit('`` a` ``', 3, 5, 'code')), 'a`');
  assert.equal(apply('**bold**', tools.formatEdit('**bold**', 2, 6, 'italic')), '***bold***');
});

test('heading at the start of a blank first line does not change the next line', () => {
  assert.equal(apply('\nsecond', tools.formatEdit('\nsecond',0,0,'heading-1')), '# \nsecond');
});
