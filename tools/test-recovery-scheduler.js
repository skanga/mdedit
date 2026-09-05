const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { RecoveryScheduler } = require("../src/recovery-scheduler.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.callback();
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function outcomeByImmediate(promise) {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: "unsettled" }))),
  ]);
}

test("browser wrapper merges RecoveryScheduler into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "recovery-scheduler.js"), "utf8");
  const sandbox = {
    window: {},
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(code, sandbox, { filename: "recovery-scheduler.js" });

  assert.equal(typeof sandbox.window.MDEdit.RecoveryScheduler, "function");
});

test("forget from changed pending status leaves no timers", async () => {
  const clock = fakeClock();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write: async (id, revision) => writes.push([id, revision]),
    onStatus(id, status) {
      if (status === "pending") scheduler.forget(id);
    },
  });

  assert.equal(scheduler.changed("a", 1), true);
  assert.equal(clock.pending(), 0);
  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(scheduler.forget("a"), false);
});

test("forget from flush pending status rejects instead of orphaning its promise", async () => {
  const clock = fakeClock();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write: async (id, revision) => writes.push([id, revision]),
    onStatus(id, status) {
      if (status === "pending") scheduler.forget(id);
    },
  });

  const outcome = await outcomeByImmediate(scheduler.flush("a", 1));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reason.message, /forgotten/i);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(writes, []);
});

test("forget from writing status prevents the recovery write and settles flush", async () => {
  const clock = fakeClock();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write: async (id, revision) => writes.push([id, revision]),
    onStatus(id, status) {
      if (status === "writing") scheduler.forget(id);
    },
  });

  scheduler.changed("a", 1);
  await assert.rejects(scheduler.flush("a"), /forgotten/i);
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(clock.pending(), 0);
  assert.equal(scheduler.forget("a"), false);
});

test("idle debounce coalesces edits and resets only the idle timer", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 1);
  clock.tick(500);
  scheduler.changed("a", 2);
  clock.tick(999);
  await settle();
  assert.deepEqual(writes, []);

  clock.tick(1);
  await settle();
  assert.deepEqual(writes, [["a", 2]]);
});

test("continuous edits checkpoint the latest revision by the maximum interval", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 1);
  for (let revision = 2; revision <= 11; revision += 1) {
    clock.tick(999);
    scheduler.changed("a", revision);
  }
  clock.tick(10);
  await settle();
  assert.deepEqual(writes, [["a", 11]]);
});

test("a flush drains revisions queued during its write before resolving", async () => {
  const clock = fakeClock();
  const firstWrite = deferred();
  const thirdWrite = deferred();
  const writes = [];
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return revision === 1 ? firstWrite.promise : thirdWrite.promise;
    },
  });

  scheduler.changed("a", 1);
  const drainingFlush = scheduler.flush("a");
  let settled = false;
  drainingFlush.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  scheduler.changed("a", 2);
  scheduler.changed("a", 3);
  assert.deepEqual(writes, [["a", 1]]);

  firstWrite.resolve();
  await settle();
  assert.deepEqual(writes, [["a", 1], ["a", 3]]);
  assert.equal(settled, false);
  assert.equal(clock.pending(), 0);

  thirdWrite.resolve();
  await drainingFlush;
  assert.equal(settled, true);
});

test("different documents write in parallel", async () => {
  const clock = fakeClock();
  const gates = { a: deferred(), b: deferred() };
  const writes = [];
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return gates[id].promise;
    },
  });

  scheduler.changed("a", 1);
  scheduler.changed("b", 4);
  clock.tick(1000);

  assert.deepEqual(writes, [["a", 1], ["b", 4]]);
  const all = scheduler.flushAll();
  gates.a.resolve();
  gates.b.resolve();
  await all;
});

test("async write failure reports failed and retry writes the latest revision", async () => {
  const clock = fakeClock();
  const statuses = [];
  const writes = [];
  let attempt = 0;
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("disk unavailable")) : Promise.resolve();
    },
    onStatus(id, status, error) {
      statuses.push([id, status, error && error.message]);
    },
  });

  scheduler.changed("a", 2);
  await assert.rejects(scheduler.flush("a"), /disk unavailable/);
  assert.deepEqual(statuses, [
    ["a", "pending", undefined],
    ["a", "writing", undefined],
    ["a", "failed", "disk unavailable"],
  ]);

  await scheduler.retry("a");
  assert.deepEqual(writes, [["a", 2], ["a", 2]]);
  assert.deepEqual(statuses.slice(-3), [
    ["a", "pending", undefined],
    ["a", "writing", undefined],
    ["a", "clean", undefined],
  ]);
});

test("retry from the failed status callback waits for the replacement write", async () => {
  const clock = fakeClock();
  const firstWrite = deferred();
  const writes = [];
  let retryPromise;
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return writes.length === 1 ? firstWrite.promise : Promise.resolve();
    },
    onStatus(id, status) {
      if (status === "failed" && !retryPromise) {
        retryPromise = scheduler.retry(id);
        retryPromise.catch(() => {});
      }
    },
  });

  scheduler.changed("a", 1);
  const failedFlush = scheduler.flush("a");
  firstWrite.reject(new Error("first attempt failed"));
  await assert.rejects(failedFlush, /first attempt failed/);
  await retryPromise;

  assert.deepEqual(writes, [["a", 1], ["a", 1]]);
});

test("forget from retry pending status rejects instead of orphaning its promise", async () => {
  const clock = fakeClock();
  const writes = [];
  let forgetOnPending = false;
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      throw new Error("initial write failed");
    },
    onStatus(id, status) {
      if (forgetOnPending && status === "pending") scheduler.forget(id);
    },
  });

  scheduler.changed("a", 1);
  await assert.rejects(scheduler.flush("a"), /initial write failed/i);
  forgetOnPending = true;

  const outcome = await outcomeByImmediate(scheduler.retry("a"));
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.reason.message, /forgotten/i);
  assert.deepEqual(writes, [["a", 1]]);
  assert.equal(clock.pending(), 0);
});

test("failure remains sticky across changes and flush until explicit retry", async () => {
  const clock = fakeClock();
  const statuses = [];
  const writes = [];
  const failure = new Error("synchronous failure");
  let attempt = 0;
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      attempt += 1;
      if (attempt === 1) throw failure;
    },
    onStatus(id, status, error) {
      statuses.push([id, status, error]);
    },
  });

  scheduler.changed("a", 1);
  await assert.rejects(scheduler.flush("a"), (error) => error === failure);
  const statusCount = statuses.length;

  scheduler.changed("a", 2);
  assert.equal(clock.pending(), 0);
  assert.equal(statuses.length, statusCount);
  assert.equal(statuses.at(-1)[1], "failed");

  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
  await assert.rejects(scheduler.flush("a"), (error) => error === failure);
  assert.deepEqual(writes, [["a", 1]]);

  await scheduler.retry("a");
  assert.deepEqual(writes, [["a", 1], ["a", 2]]);
});

test("failure cancels a newer edit timer and waits for explicit retry", async () => {
  const clock = fakeClock();
  const firstWrite = deferred();
  const writes = [];
  const failure = new Error("revision one failed");
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return revision === 1 ? firstWrite.promise : Promise.resolve();
    },
  });

  scheduler.changed("a", 1);
  const failedFlush = scheduler.flush("a");
  scheduler.changed("a", 2);
  assert.equal(clock.pending(), 2);
  firstWrite.reject(failure);
  await assert.rejects(failedFlush, (error) => error === failure);
  await settle();
  assert.equal(clock.pending(), 0);

  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
  await assert.rejects(scheduler.flush("a"), (error) => error === failure);

  await scheduler.retry("a");
  assert.deepEqual(writes, [["a", 1], ["a", 2]]);
});

test("failure stays sticky when a newer edit timer fired during the older write", async () => {
  const clock = fakeClock();
  const firstWrite = deferred();
  const writes = [];
  const failure = new Error("revision one failed late");
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return revision === 1 ? firstWrite.promise : Promise.resolve();
    },
  });

  scheduler.changed("a", 1);
  const failedFlush = scheduler.flush("a");
  scheduler.changed("a", 2);
  clock.tick(1000);
  firstWrite.reject(failure);
  await assert.rejects(failedFlush, (error) => error === failure);
  await settle();
  assert.equal(clock.pending(), 0);

  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
  await assert.rejects(scheduler.flush("a"), (error) => error === failure);

  await scheduler.retry("a");
  assert.deepEqual(writes, [["a", 1], ["a", 2]]);
});

test("retry is a no-op for nonfailed documents and preserves pending timers", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 1);
  assert.equal(clock.pending(), 2);
  assert.equal(await scheduler.retry("a"), false);
  assert.equal(clock.pending(), 2);
  assert.deepEqual(writes, []);

  clock.tick(1000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
  await scheduler.flush("a");
  assert.equal(await scheduler.retry("a"), false);
  assert.deepEqual(writes, [["a", 1]]);
});

test("flushAll attempts every document and aggregates failed document IDs", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({
    clock,
    async write(id, revision) {
      writes.push([id, revision]);
      if (id !== "b") throw new Error(`cannot write ${id}`);
    },
  });

  scheduler.changed("a", 1);
  scheduler.changed("b", 2);
  scheduler.changed("c", 3);

  let aggregate;
  try {
    await scheduler.flushAll();
  } catch (error) {
    aggregate = error;
  }

  assert.ok(aggregate instanceof Error);
  assert.deepEqual(aggregate.ids, ["a", "c"]);
  assert.match(aggregate.message, /a/);
  assert.match(aggregate.message, /c/);
  assert.deepEqual(writes, [["a", 1], ["b", 2], ["c", 3]]);
});

test("flushAll skips a captured entry forgotten while an earlier document starts", async () => {
  const clock = fakeClock();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    async write(id, revision) {
      writes.push([id, revision]);
    },
    onStatus(id, status) {
      if (id === "a" && status === "writing") scheduler.forget("b");
    },
  });

  scheduler.changed("a", 1);
  scheduler.changed("b", 2);
  await scheduler.flushAll();

  assert.deepEqual(writes, [["a", 1]]);
  assert.equal(scheduler.forget("b"), false);
  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
});

test("flush and forget cancel pending timers", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 1);
  assert.equal(clock.pending(), 2);
  await scheduler.flush("a");
  assert.equal(clock.pending(), 0);

  scheduler.changed("b", 1);
  assert.equal(clock.pending(), 2);
  assert.equal(scheduler.forget("b"), true);
  assert.equal(clock.pending(), 0);

  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
});

test("forget during an in-flight write suppresses stale status and follow-up work", async () => {
  const clock = fakeClock();
  const gate = deferred();
  const statuses = [];
  const writes = [];
  const scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return gate.promise;
    },
    onStatus(id, status) {
      statuses.push([id, status]);
    },
  });

  scheduler.changed("a", 1);
  scheduler.flush("a").catch(() => {});
  scheduler.changed("a", 2);
  const statusCountAtForget = statuses.length;

  assert.equal(scheduler.forget("a"), true);
  gate.resolve();
  await settle();
  clock.tick(20000);
  await settle();

  assert.deepEqual(writes, [["a", 1]]);
  assert.equal(statuses.length, statusCountAtForget);
  assert.equal(scheduler.forget("a"), false);
});

test("forget from a failed status callback cannot install stale retry timers", async () => {
  const clock = fakeClock();
  const gate = deferred();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write(id, revision) {
      writes.push([id, revision]);
      return gate.promise;
    },
    onStatus(id, status) {
      if (status === "failed") scheduler.forget(id);
    },
  });

  scheduler.changed("a", 1);
  const flush = scheduler.flush("a");
  scheduler.changed("a", 2);
  gate.reject(new Error("write failed while closing"));
  await assert.rejects(flush, /write failed while closing/i);
  await settle();

  assert.equal(clock.pending(), 0);
  clock.tick(20000);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
});

test("forget from clean status settles the draining flush without resurrecting work", async () => {
  const clock = fakeClock();
  const writes = [];
  let scheduler;
  scheduler = new RecoveryScheduler({
    clock,
    write: async (id, revision) => writes.push([id, revision]),
    onStatus(id, status) {
      if (status === "clean") scheduler.forget(id);
    },
  });

  scheduler.changed("a", 1);
  await assert.rejects(scheduler.flush("a"), /forgotten/i);
  await settle();
  assert.deepEqual(writes, [["a", 1]]);
  assert.equal(clock.pending(), 0);
  assert.equal(scheduler.forget("a"), false);
});

test("same and lower revisions neither delay nor duplicate persistence", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 2);
  clock.tick(500);
  scheduler.changed("a", 2);
  scheduler.changed("a", 1);
  clock.tick(500);
  await settle();
  assert.deepEqual(writes, [["a", 2]]);

  scheduler.changed("a", 2);
  scheduler.changed("a", 1);
  clock.tick(20000);
  await settle();
  await scheduler.flush("a", 1);
  assert.deepEqual(writes, [["a", 2]]);
});

test("flushing a stale requested revision still persists newer pending work", async () => {
  const clock = fakeClock();
  const writes = [];
  const scheduler = new RecoveryScheduler({ clock, write: async (id, revision) => writes.push([id, revision]) });

  scheduler.changed("a", 1);
  await scheduler.flush("a");
  scheduler.changed("a", 2);

  await scheduler.flush("a", 1);
  assert.deepEqual(writes, [["a", 1], ["a", 2]]);
  assert.equal(clock.pending(), 0);
});

test("constructor and method inputs are validated", () => {
  const clock = fakeClock();
  assert.throws(() => new RecoveryScheduler(), /write/i);
  assert.throws(() => new RecoveryScheduler({ write: 1 }), /write/i);
  assert.throws(() => new RecoveryScheduler({ clock: {}, write() {} }), /clock/i);

  const scheduler = new RecoveryScheduler({ clock, write() {} });
  assert.throws(() => scheduler.changed("", 1), /document id/i);
  assert.throws(() => scheduler.changed("a", -1), /revision/i);
  assert.throws(() => scheduler.changed("a", 1.5), /revision/i);
  assert.throws(() => scheduler.flush("a", Number.MAX_SAFE_INTEGER + 1), /revision/i);
});

test("timer callback rejection is observed and does not become unhandled", async () => {
  const clock = fakeClock();
  const scheduler = new RecoveryScheduler({
    clock,
    async write() {
      throw new Error("timer write failed");
    },
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    scheduler.changed("a", 1);
    clock.tick(1000);
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
