const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const marked = require('../vendor/marked.min.js');
const { createMarkdownEngine, createMarkdownParser } = require('../src/markdown-parser');

function environment() {
  const workers = [], revoked = [], sources = new Map();
  return { workers, revoked, sources, window: {
    Blob: class { constructor(parts) { this.source = parts.join(''); } },
    setTimeout, clearTimeout,
    URL: {
      createObjectURL(blob) { const url = `blob:${sources.size}`; sources.set(url, blob.source); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    Worker: class {
      constructor(url) { this.source = sources.get(url); workers.push(this); }
      postMessage(data) { this.data = data; }
      terminate() { this.terminated = true; }
      respond(result = { html: '<p>ok</p>', math: [] }, id = this.data.id) { this.onmessage({ data: { id, result } }); }
      fail() { this.onerror({ preventDefault() {} }); }
    },
  } };
}
const options = env => ({ window: env.window, librarySource: fs.readFileSync('vendor/marked.min.js', 'utf8') });

test('Markdown engine preserves GFM and resets footnote numbering between documents', () => {
  const parse = createMarkdownEngine(marked);
  const result = parse('Second[^b], first[^a], again[^b].\n\n[^a]: Alpha.\n[^b]: **Beta**.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done');
  assert.equal(result.math.length, 0);
  assert.match(result.html, /<table>/);
  assert.match(result.html, /type="checkbox"/);
  assert.ok(result.html.indexOf('<strong>Beta</strong>') < result.html.indexOf('Alpha.'));
  assert.equal((result.html.match(/<li id="fn-/g) || []).length, 2);
  assert.doesNotMatch(parse('Unresolved[^b]').html, /class="fn-ref"/);
});

test('Markdown engine extracts math without changing prices or fenced/inline code', () => {
  const parse = createMarkdownEngine(marked);
  const result = parse('Inline $x_1$ and \\(y^2\\).\n\nPrice $12.50$.\n\n`$code$`.\n\n```tex\n$literal$\n```\n\n$$\nz = 1\n$$', { math: true });
  assert.deepEqual(result.math, [
    { tex: 'x_1', display: false }, { tex: 'y^2', display: false }, { tex: '\nz = 1\n', display: true },
  ]);
  assert.match(result.html, /\$12\.50\$/);
  assert.match(result.html, /<code>\$code\$<\/code>/);
  assert.match(result.html, /\$literal\$/);
  assert.deepEqual(parse('$x_1$', { math: false }).math, []);
});

test('worker script executes the existing vendored parser without a module loader', async () => {
  const env = environment(), parser = createMarkdownParser(options(env));
  const pending = parser.parse('# Worker\n\nA note[^n].\n\n[^n]: Body.');
  const worker = env.workers[0];
  const context = vm.createContext({ postMessage(data) { worker.onmessage({ data }); } });
  vm.runInContext(worker.source, context);
  context.onmessage({ data: worker.data });
  const result = await pending;
  assert.match(result.html, /<h1>Worker<\/h1>/);
  assert.match(result.html, /class="footnotes"/);
  parser.dispose();
  assert.equal(worker.terminated, true);
  assert.equal(env.revoked.length, 1);
});

test('completed Markdown requests reuse a worker; superseded requests terminate old work', async () => {
  const env = environment(), parser = createMarkdownParser(options(env));
  const first = parser.parse('first'); env.workers[0].respond(); await first;
  const second = parser.parse('second'); env.workers[0].respond(); await second;
  assert.equal(env.workers.length, 1);
  const stale = parser.parse('stale');
  const latest = parser.parse('latest');
  assert.equal((await stale).canceled, true);
  assert.equal(env.workers[0].terminated, true);
  env.workers[0].respond({ html: '<p>stale</p>', math: [] });
  env.workers[1].respond({ html: '<p>latest</p>', math: [] });
  assert.equal((await latest).html, '<p>latest</p>');
  parser.dispose();
});

test('errors from terminated Markdown workers cannot reject the replacement job', async () => {
  const env = environment(), parser = createMarkdownParser(options(env));
  const stale = parser.parse('stale');
  const latest = parser.parse('latest');
  await stale;
  env.workers[0].fail();
  env.workers[1].respond();
  assert.equal((await latest).html, '<p>ok</p>');
  parser.dispose();
});

test('canceling an idle Markdown parser releases its worker and permits page restoration', async () => {
  const env = environment(), parser = createMarkdownParser(options(env));
  const first = parser.parse('before pagehide'); env.workers[0].respond(); await first;
  parser.cancel();
  assert.equal(env.workers[0].terminated, true);
  const resumed = parser.parse('after pageshow'); env.workers[1].respond();
  assert.equal((await resumed).html, '<p>ok</p>');
  parser.dispose();
  assert.equal(env.revoked.length, 2);
});

test('a Markdown engine error rejects its job and the next request gets a fresh worker', async () => {
  const env = environment(), parser = createMarkdownParser(options(env));
  const failed = parser.parse('failed');
  env.workers[0].onmessage({ data: { id: env.workers[0].data.id, error: 'parser error' } });
  await assert.rejects(failed, /parser error/);
  const recovered = parser.parse('recovered'); env.workers[1].respond();
  assert.equal((await recovered).html, '<p>ok</p>');
  parser.dispose();
});

test('Markdown timeout, unavailable workers and malformed responses fail closed', async () => {
  const env = environment(), parser = createMarkdownParser({ ...options(env), timeoutMs: 5 });
  await assert.rejects(parser.parse('slow'), /timed out/);
  assert.equal(env.workers[0].terminated, true);
  const malformed = parser.parse('bad response');
  env.workers[1].respond({ html: 42, math: [] });
  await assert.rejects(malformed, /Invalid Markdown worker response/);
  parser.dispose();
  await assert.rejects(parser.parse('after disposal'), /disposed/);
  const unsupported = environment(); delete unsupported.window.Worker;
  const missing = createMarkdownParser(options(unsupported));
  await assert.rejects(missing.parse('no worker'), /Worker/);
  assert.equal(unsupported.revoked.length, 1);
});
