const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSnapshotSerializer } = require('../src/snapshot-serializer');

function environment(autoReady = true) {
  const workers = [], revoked = [], sources = new Map();
  return { workers, revoked, window: {
    Blob: class { constructor(parts) { this.source = parts.join(''); } },
    setTimeout, clearTimeout,
    URL: {
      createObjectURL(blob) { const url = `blob:${sources.size}`; sources.set(url, blob.source); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    Worker: class {
      constructor(url) { this.source = sources.get(url); this.messages = []; workers.push(this); }
      set onmessage(handler) { this.handler = handler; if (autoReady) this.ready(); }
      get onmessage() { return this.handler; }
      ready() { this.onmessage({ data: { kind: 'snapshot-ready' } }); }
      postMessage(message) { this.messages.push(message); this.data = message; }
      terminate() { this.terminated = true; }
      respond(json = JSON.stringify(this.data.snapshot)) { this.onmessage({ data: { id: this.data.id, json } }); }
      fail() { this.onerror({ preventDefault() {} }); }
    },
  } };
}
const create = (env, options = {}) => createSnapshotSerializer({ window: env.window, minimumWorkerCharacters: 0, ...options });

test('small snapshots remain synchronous and large Find metadata is offloaded', async () => {
  const env = environment(), serializer = create(env, { minimumWorkerCharacters: 16 });
  assert.equal(serializer.serialize({ content: 'small' }), '{"content":"small"}');
  assert.equal(env.workers.length, 0);
  const largeFind = { content: '', workspace: { find: { query: 'x'.repeat(16) } } };
  const pending = serializer.serialize(largeFind);
  env.workers[0].respond();
  assert.equal(await pending, JSON.stringify(largeFind));
  serializer.dispose();
});

test('small JSON parsing is synchronous and does not create a worker', () => {
  const env = environment(), serializer = create(env, { minimumWorkerCharacters: 64 });
  assert.equal(typeof serializer.parse, 'function');
  assert.deepEqual(serializer.parse('{"content":"small"}'), { content: 'small' });
  assert.throws(() => serializer.parse('bad JSON'), SyntaxError);
  assert.equal(env.workers.length, 0);
  serializer.dispose();
});

test('actual worker parses and encodes in FIFO order, recovering from invalid JSON without failing queued work', async () => {
  const env = environment(), serializer = create(env);
  assert.equal(typeof serializer.parse, 'function');
  const first = serializer.serialize({ content: 'one' });
  const invalid = serializer.parse('{broken');
  const parsed = serializer.parse('{"content":"🙂\\\\path","extra":null}');
  const last = serializer.serialize({ content: 'last' });
  const settled = Promise.allSettled([first, invalid, parsed, last]);
  const worker = env.workers[0], context = vm.createContext({ self: {
    postMessage(data) { worker.onmessage({ data }); },
  } });
  vm.runInContext(worker.source, context);
  for (let index = 0; index < 4; index++) {
    assert.equal(worker.messages.length, index + 1);
    context.self.onmessage({ data: worker.messages[index] });
  }
  const results = await settled;
  assert.equal(results[0].value, '{"content":"one"}');
  assert.equal(results[1].status, 'rejected');
  assert.ok(results[1].reason instanceof SyntaxError);
  assert.equal(results[2].value.content, '🙂\\path');
  assert.equal(results[2].value.extra, null);
  assert.equal(results[3].value, '{"content":"last"}');
  assert.equal(env.workers.length, 1);
  serializer.dispose();
});

test('missing parsed values are protocol failures, but a JSON null result is valid', async () => {
  const env = environment(), serializer = create(env);
  assert.equal(typeof serializer.parse, 'function');
  const parsedNull = serializer.parse('null');
  env.workers[0].onmessage({ data: { id: env.workers[0].data.id, value: null } });
  assert.equal(await parsedNull, null);
  const malformed = serializer.parse('{}');
  const queued = serializer.serialize({ content: 'queued' });
  const failures = Promise.allSettled([malformed, queued]);
  env.workers[0].onmessage({ data: { id: env.workers[0].data.id } });
  assert.ok((await failures).every(result => result.status === 'rejected' && /Invalid snapshot worker response/.test(result.reason.message)));
  serializer.dispose();
});

test('unavailable workers do not fall back to parsing a large write on the UI thread', async () => {
  const env = environment(); delete env.window.Worker;
  const serializer = create(env), parse = JSON.parse;
  assert.equal(typeof serializer.parse, 'function');
  let pending;
  try {
    JSON.parse = () => { throw new Error('UI parsing is forbidden'); };
    pending = serializer.parse('{"content":"large"}');
  } finally { JSON.parse = parse; }
  await assert.rejects(pending, /Worker/);
  serializer.dispose();
});

test('parsing timeout rejects mixed queued work and stale replies cannot corrupt a retry', async () => {
  const env = environment(), serializer = create(env, { timeoutMs: 5 });
  const failures = await Promise.allSettled([serializer.parse('{}'), serializer.serialize({ content: 'queued' })]);
  assert.ok(failures.every(result => result.status === 'rejected' && /parsing timed out/.test(result.reason.message)));
  const retry = serializer.parse('null');
  env.workers[0].onmessage({ data: { id: env.workers[0].data.id, value: { stale: true } } });
  env.workers[1].onmessage({ data: { id: env.workers[1].data.id, value: null } });
  assert.equal(await retry, null);
  serializer.dispose();
});

test('disposal rejects active and queued parsing, including later small parse requests', async () => {
  const env = environment(), serializer = create(env);
  assert.equal(typeof serializer.parse, 'function');
  const settled = Promise.allSettled([serializer.parse('{}'), serializer.parse('null')]);
  serializer.dispose();
  assert.ok((await settled).every(result => result.status === 'rejected' && /disposed/.test(result.reason.message)));
  await assert.rejects(serializer.parse('{}'), /disposed/);
});

test('preparation waits for readiness and queued jobs do not dispatch during cold startup', async () => {
  const env = environment(false), serializer = create(env);
  const prepared = serializer.prepare();
  assert.equal(serializer.prepare(), prepared);
  const pending = serializer.serialize({ content: 'one' });
  assert.equal(env.workers.length, 1);
  assert.equal(env.workers[0].messages.length, 0);
  env.workers[0].ready();
  await prepared;
  assert.equal(env.workers[0].messages.length, 1);
  env.workers[0].respond();
  assert.equal(await pending, '{"content":"one"}');
  serializer.dispose();
});

test('startup timeouts reject preparation and queued jobs, then permit a fresh retry', async () => {
  const env = environment(false), serializer = create(env, { timeoutMs: 5 });
  const prepared = serializer.prepare();
  const pending = serializer.serialize({ content: 'one' });
  await Promise.all([assert.rejects(prepared, /startup timed out/), assert.rejects(pending, /startup timed out/)]);
  assert.equal(env.workers[0].terminated, true);
  const retry = serializer.prepare();
  env.workers[1].ready();
  await retry;
  serializer.dispose();
});

test('disposal during cold startup rejects readiness and queued jobs without dispatching', async () => {
  const env = environment(false), serializer = create(env);
  const prepared = serializer.prepare();
  const pending = serializer.serialize({ content: 'one' });
  serializer.dispose();
  await Promise.all([assert.rejects(prepared, /disposed/), assert.rejects(pending, /disposed/)]);
  assert.equal(env.workers[0].messages.length, 0);
  assert.equal(env.workers[0].terminated, true);
  assert.equal(env.revoked.length, 1);
});

test('only one snapshot is dispatched at a time and successful jobs reuse the worker', async () => {
  const env = environment(), serializer = create(env);
  const first = serializer.serialize({ content: 'one' });
  const second = serializer.serialize({ content: 'two' });
  assert.equal(env.workers.length, 1);
  assert.equal(env.workers[0].messages.length, 1);
  env.workers[0].respond();
  assert.equal(await first, '{"content":"one"}');
  assert.equal(env.workers[0].messages.length, 2);
  env.workers[0].respond();
  assert.equal(await second, '{"content":"two"}');
  serializer.dispose();
  assert.equal(env.revoked.length, 1);
});

test('the actual worker preserves JSON byte format for Unicode, escapes and nulls', async () => {
  const env = environment(), serializer = create(env);
  const snapshot = { schemaVersion: 1, content: '🙂\n"quoted"\\path\u0000', path: null,
    workspace: { find: { query: '[x]', regex: true } } };
  const pending = serializer.serialize(snapshot), worker = env.workers[0];
  const context = vm.createContext({ self: { postMessage(data) { worker.onmessage({ data }); } } });
  vm.runInContext(worker.source, context);
  context.self.onmessage({ data: worker.data });
  assert.equal(await pending, JSON.stringify(snapshot));
  serializer.dispose();
});

test('worker failure rejects queued jobs and stale events cannot affect a retry', async () => {
  const env = environment(), serializer = create(env);
  const first = serializer.serialize({ content: 'one' });
  const second = serializer.serialize({ content: 'two' });
  const failures = Promise.allSettled([first, second]);
  env.workers[0].fail();
  assert.ok((await failures).every(result => result.status === 'rejected'));
  const retry = serializer.serialize({ content: 'retry' });
  env.workers[0].fail();
  env.workers[0].respond('stale');
  env.workers[1].respond();
  assert.equal(await retry, '{"content":"retry"}');
  serializer.dispose();
});

test('a malformed worker response rejects all queued jobs without yielding partial JSON', async () => {
  const env = environment(), serializer = create(env);
  const first = serializer.serialize({ content: 'one' });
  const second = serializer.serialize({ content: 'two' });
  const pending = Promise.allSettled([first, second]);
  env.workers[0].respond(42);
  assert.ok((await pending).every(result => result.status === 'rejected' && /Invalid snapshot worker response/.test(result.reason.message)));
  serializer.dispose();
});

test('a delayed UI watchdog gives already-queued worker replies a task turn to finish', async () => {
  const env = environment(), timers = new Map();
  let nextTimer = 0;
  env.window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  env.window.clearTimeout = id => timers.delete(id);
  const serializer = create(env);
  const first = serializer.serialize({ content: 'one' });
  const second = serializer.serialize({ content: 'two' });
  const completed = Promise.all([first, second]);
  const [id, deadline] = [...timers][0];
  timers.delete(id);
  deadline.callback(); // The UI resumed late; the worker reply is queued next.
  const grace = [...timers.values()][0]?.callback;
  env.workers[0].respond();
  if (grace) grace(); // A stale timeout must not fail the next queued job.
  env.workers[0].respond();
  assert.deepEqual(await completed, ['{"content":"one"}', '{"content":"two"}']);
  assert.equal(timers.size, 0);
  serializer.dispose();
});

test('timeouts and disposal release active and queued serialization jobs', async () => {
  const env = environment(), serializer = create(env, { timeoutMs: 5 });
  const first = serializer.serialize({ content: 'one' });
  const second = serializer.serialize({ content: 'two' });
  const failures = await Promise.allSettled([first, second]);
  assert.ok(failures.every(result => result.status === 'rejected' && /timed out/.test(result.reason.message)));
  const active = serializer.serialize({ content: 'active' });
  const queued = serializer.serialize({ content: 'queued' });
  const disposed = Promise.allSettled([active, queued]);
  serializer.dispose();
  assert.ok((await disposed).every(result => result.status === 'rejected' && /disposed/.test(result.reason.message)));
  await assert.rejects(serializer.serialize({ content: 'late' }), /disposed/);
  assert.ok(env.workers.every(worker => worker.terminated));
});

test('unavailable workers never trigger synchronous encoding of a large snapshot', async () => {
  const env = environment(); delete env.window.Worker;
  const serializer = create(env), stringify = JSON.stringify;
  let pending;
  try {
    JSON.stringify = () => { throw new Error('UI-thread encoding is forbidden'); };
    pending = serializer.serialize({ content: 'large' });
  } finally { JSON.stringify = stringify; }
  await assert.rejects(pending, /Worker/);
  assert.equal(env.revoked.length, 1);
  serializer.dispose();
});
