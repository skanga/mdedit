const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const librarySource = fs.readFileSync('vendor/highlight.min.js', 'utf8');
const { highlightCodeBlocks, createSyntaxHighlighter } = require('../src/syntax-highlighter');

function environment() {
  const workers = [], revoked = [], sources = new Map();
  return { workers, revoked, window: {
    Blob: class { constructor(parts) { this.source = parts.join(''); } }, setTimeout, clearTimeout,
    URL: { createObjectURL(blob) { const url = `blob:${sources.size}`; sources.set(url, blob.source); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    Worker: class {
      constructor(url) { this.source = sources.get(url); this.messages = []; workers.push(this); }
      postMessage(data) { this.messages.push(data); this.data = data; }
      terminate() { this.terminated = true; }
      respond(results) { this.onmessage({ data: { id: this.data.id, results } }); }
      fail() { this.onerror({ preventDefault() {} }); }
    },
  } };
}
const create = (env, options = {}) => createSyntaxHighlighter({ window: env.window, librarySource, ...options });
const blocks = [{ language: 'js', text: 'const x = "<script>&";\n' }];

test('worker engine matches the vendored explicit-language API, aliases and plain-code policy', () => {
  const context = vm.createContext({ console }); vm.runInContext(librarySource, context);
  const cases = [...blocks, { language: 'python', text: 'print("hello")' }, { language: 'unknown-language', text: '<b>plain</b>' },
    { language: '', text: 'const plain = 1;' }, { language: 'mermaid', text: 'graph TD; A-->B' }];
  const results = highlightCodeBlocks(context.hljs, cases);
  assert.equal(results[0], context.hljs.highlight(blocks[0].text, { language: 'js' }).value);
  assert.equal(results[1], context.hljs.highlight(cases[1].text, { language: 'python' }).value);
  assert.deepEqual(results.slice(2), [null, null, null]);
  assert.match(results[0], /hljs-keyword/);
  assert.ok(!results[0].includes('<script>'));
});

test('one grammar failure leaves that block plain without discarding successful blocks', () => {
  const engine = { getLanguage: () => true, highlight(text) { if (text === 'bad') throw new Error('grammar'); return { value: 'safe' }; } };
  assert.deepEqual(highlightCodeBlocks(engine, [{ language: 'x', text: 'bad' }, { language: 'x', text: 'good' }]), [null, 'safe']);
});

test('the actual bundled worker runs without DOM, imports or a module loader', async () => {
  const env = environment(), highlighter = create(env);
  const pending = highlighter.highlight(blocks), worker = env.workers[0];
  const context = vm.createContext({ console, postMessage(data) { worker.onmessage({ data }); } });
  vm.runInContext(worker.source, context);
  context.onmessage({ data: worker.data });
  const result = await pending;
  assert.match(result.results[0], /hljs-keyword/);
  assert.equal(result.canceled, false);
  highlighter.dispose();
  assert.equal(env.revoked.length, 1);
});

test('empty work does not start a worker, and completed requests reuse one worker', async () => {
  const env = environment(), highlighter = create(env);
  assert.deepEqual(await highlighter.highlight([]), { canceled: false, results: [] });
  assert.equal(env.workers.length, 0);
  for (let index = 0; index < 2; index++) {
    const pending = highlighter.highlight(blocks);
    env.workers[0].respond(['<span>code</span>']);
    assert.deepEqual((await pending).results, ['<span>code</span>']);
  }
  assert.equal(env.workers.length, 1);
  assert.equal(env.workers[0].messages.length, 2);
  highlighter.dispose();
});

test('supersession cancels obsolete work and stale replies/errors cannot affect newer work', async () => {
  const env = environment(), highlighter = create(env);
  const old = highlighter.highlight(blocks), next = highlighter.highlight(blocks);
  assert.equal((await old).canceled, true);
  env.workers[0].respond(['obsolete']); env.workers[0].fail();
  env.workers[1].respond(['latest']);
  assert.deepEqual((await next).results, ['latest']);
  assert.equal(env.workers[0].terminated, true);
  highlighter.dispose();
});

test('worker errors, malformed replies and timeout degrade to plain code and allow retry', async () => {
  const env = environment(), highlighter = create(env, { timeoutMs: 5 });
  const failed = highlighter.highlight(blocks); env.workers[0].fail();
  assert.deepEqual((await failed).results, []);
  const malformed = highlighter.highlight(blocks); env.workers[1].respond([42]);
  assert.deepEqual((await malformed).results, []);
  assert.deepEqual((await highlighter.highlight(blocks)).results, []);
  const retry = highlighter.highlight(blocks); env.workers[3].respond(['recovered']);
  assert.deepEqual((await retry).results, ['recovered']);
  highlighter.dispose();
});

test('unavailable workers or library never invoke a main-thread fallback', async () => {
  for (const absent of ['worker', 'library']) {
    const env = environment(); if (absent === 'worker') delete env.window.Worker;
    const highlighter = create(env, absent === 'library' ? { librarySource: '' } : {});
    assert.deepEqual((await highlighter.highlight(blocks)).results, []);
    highlighter.dispose();
  }
});

test('disposal cancels pending work and rejects later requests; invalid inputs fail explicitly', async () => {
  const env = environment(), highlighter = create(env);
  await assert.rejects(highlighter.highlight([{ language: 'js', text: null }]), /blocks/);
  const pending = highlighter.highlight(blocks);
  highlighter.dispose();
  assert.equal((await pending).canceled, true);
  await assert.rejects(highlighter.highlight(blocks), /disposed/);
  assert.equal(env.workers[0].terminated, true);
});
