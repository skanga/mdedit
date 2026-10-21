const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchRunner } = require('../src/search-runner');
const { searchMatches } = require('../src/editor-tools');

function environment() {
  const workers = [], revoked = [];
  return { workers, revoked, window: {
    Blob, setTimeout, clearTimeout,
    URL: { createObjectURL: () => `blob:${workers.length}`, revokeObjectURL: url => revoked.push(url) },
    Worker: class {
      constructor() { workers.push(this); }
      postMessage(data) { this.data = data; }
      terminate() { this.terminated = true; }
      respond() { this.onmessage({ data: searchMatches(this.data.value, this.data.query, this.data.options) }); }
    },
  } };
}

test('regex requests share in-flight work and cache captures without rerunning', async () => {
  const env = environment();
  const runner = createSearchRunner({ window: env.window, searchMatches });
  const pending = runner.search('cat12', '(cat)(\\d+)', { regex: true });
  assert.equal(runner.search('cat12', '(cat)(\\d+)', { regex: true }), pending);
  env.workers[0].respond();
  const result = await pending;
  assert.deepEqual(result.matches[0].captures, ['cat12', 'cat', '12']);
  assert.equal(runner.search('cat12', '(cat)(\\d+)', { regex: true }), result);
  assert.equal(env.workers.length, 1);
  assert.equal(env.workers[0].terminated, true);
  assert.equal(env.revoked.length, 1);
});

test('superseding searches terminate obsolete workers and ignore late results', async () => {
  const env = environment();
  const runner = createSearchRunner({ window: env.window, searchMatches });
  const old = runner.search('cat', 'cat', { regex: true });
  const latest = runner.search('dog', 'dog', { regex: true });
  assert.equal((await old).canceled, true);
  env.workers[0].respond();
  env.workers[1].respond();
  assert.equal((await latest).matches[0].captures[0], 'dog');
  assert.ok(env.workers.every(worker => worker.terminated));
});

test('timeout and disposal terminate workers and release blob URLs', async () => {
  const env = environment();
  const runner = createSearchRunner({ window: env.window, searchMatches, timeoutMs: 5 });
  assert.match((await runner.search('a', 'a', { regex: true })).error, /timed out/);
  const pending = runner.search('b', 'b', { regex: true });
  runner.dispose();
  assert.equal((await pending).canceled, true);
  assert.ok(env.workers.every(worker => worker.terminated));
  assert.equal(env.revoked.length, 2);
});

test('missing workers fail closed for regex but literal search remains available', async () => {
  const env = environment(); delete env.window.Worker;
  let synchronousRegexCalls = 0;
  const runner = createSearchRunner({ window: env.window, searchMatches(value, query, options) {
    if (options.regex) synchronousRegexCalls++;
    return searchMatches(value, query, options);
  } });
  assert.match((await runner.search('a', 'a', { regex: true })).error, /Worker/);
  assert.equal(synchronousRegexCalls, 0);
  assert.equal(runner.search('cat', 'cat', {}).matches.length, 1);
});
