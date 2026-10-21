const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrowserLink, createBrowserLinks } = require('../src/browser-links');

test('browser link policy accepts web and HTML references, not executable schemes or Markdown paths', () => {
  for (const ref of ['https://example.com', 'HTTP://example.com/a.md', '//example.com', 'file:///docs/a.html',
    '../a%20b.HTML?q=1#part', '/a.htm', 'C:/docs/a.html', 'a%2ehtml']) assert.equal(isBrowserLink(ref), true, ref);
  for (const ref of ['', null, '#a.html', 'next.md', 'javascript:alert(1)', 'data:text/html,test',
    'mailto:a.html', 'custom:a.html', 'script.exe']) assert.equal(isBrowserLink(ref), false, ref);
});

function fixture(nativeApp) {
  const listeners = {};
  const anchor = { getAttribute: () => '../report.html#part', removeAttribute() {},
    addEventListener(type, fn) { listeners[type] = fn; } };
  let contained = true;
  const preview = { querySelectorAll: () => [anchor], contains: () => contained };
  const errors = [];
  const links = createBrowserLinks({ preview, nativeApp, setStatus: message => errors.push(message) });
  let current = true;
  links.hydrate(preview, '/notes/a.md', () => current);
  return { links, preview, errors, detach() { contained = false; }, stale() { current = false; },
    click(type = 'click', button = 0) {
      let prevented = false;
      return { done: listeners[type]?.({ currentTarget: anchor, button, type, preventDefault() { prevented = true; } }),
        prevented: () => prevented };
    } };
}

test('left/middle clicks open externally and stale or detached links cannot launch', async () => {
  const calls = [];
  const f = fixture({ openBrowserLink: async (...args) => calls.push(args) });
  const left = f.click(); await left.done; assert.ok(left.prevented());
  const middle = f.click('auxclick', 1); await middle.done; assert.ok(middle.prevented());
  await f.click('auxclick', 2).done;
  assert.deepEqual(calls, [['/notes/a.md', '../report.html#part'], ['/notes/a.md', '../report.html#part']]);
  f.detach(); const detached = f.click(); await detached.done; assert.ok(detached.prevented());
  assert.equal(calls.length, 2);
  const stale = fixture({ openBrowserLink: async () => assert.fail('stale launch') });
  stale.stale(); await stale.click().done;
});

test('opener failures are visible; browser-only links retain normal navigation', async () => {
  const f = fixture({ openBrowserLink: async () => { throw new Error('Missing HTML'); } });
  await f.click().done;
  assert.deepEqual(f.errors, ['Missing HTML']);
  assert.equal(fixture(null).click().done, undefined);
});
