(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  function snapshotWorker() {
    self.onmessage = ({ data }) => {
      try {
        if (data.kind === 'parse-snapshot') self.postMessage({ id: data.id, value: JSON.parse(data.json) });
        else self.postMessage({ id: data.id, json: JSON.stringify(data.snapshot) });
      } catch (error) {
        self.postMessage({ id: data.id, error: error && error.message || String(error), errorName: error && error.name });
      }
    };
    self.postMessage({ kind: 'snapshot-ready' });
  }

  // Encoding callers supply owned DocumentModel.toSnapshot() DTOs, not live
  // models. Encoding/parsing share one queue; clone only the active payload.
  function createSnapshotSerializer({ window: win, minimumWorkerCharacters = 256 * 1024, timeoutMs = 10000 }) {
    let worker = null, url = null, active = null, nextId = 0, disposed = false;
    let ready = false, readyPromise = null, resolveReady = null, rejectReady = null, startupTimer = null;
    const queue = [];
    function watchdog(callback) {
      const timer = { id: null };
      timer.id = win.setTimeout(() => {
        // Native layout can delay both watchdogs and worker messages. Give
        // already-queued completions a task turn before declaring failure.
        timer.id = win.setTimeout(callback, 0);
      }, timeoutMs);
      return timer;
    }
    function clearWatchdog(timer) { if (timer) win.clearTimeout(timer.id); }
    function resetWorker() {
      clearWatchdog(startupTimer);
      startupTimer = null;
      if (worker) worker.terminate();
      if (url) win.URL.revokeObjectURL(url);
      worker = null; url = null; ready = false; readyPromise = null;
    }
    function failAll(reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const jobs = active ? [active, ...queue] : [...queue];
      const rejectStartup = rejectReady;
      queue.length = 0;
      active = null; resolveReady = null; rejectReady = null;
      resetWorker();
      if (rejectStartup) rejectStartup(error);
      for (const job of jobs) { clearWatchdog(job.timer); job.reject(error); }
    }
    function ensureWorker() {
      if (worker) return;
      readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      readyPromise.catch(() => {});
      url = win.URL.createObjectURL(new win.Blob(['(' + snapshotWorker.toString() + ')();'], { type: 'text/javascript' }));
      const instance = new win.Worker(url);
      worker = instance;
      startupTimer = watchdog(() => {
        if (worker === instance && !ready) failAll(new Error('Recovery worker startup timed out'));
      });
      instance.onerror = event => {
        event.preventDefault();
        if (worker === instance) failAll(new Error('Recovery serialization worker failed'));
      };
      instance.onmessage = event => {
        if (worker !== instance || !event.data) return;
        if (event.data.kind === 'snapshot-ready') {
          ready = true;
          clearWatchdog(startupTimer); startupTimer = null;
          if (resolveReady) resolveReady();
          resolveReady = null; rejectReady = null;
          pump();
          return;
        }
        if (!active || event.data.id !== active.id) return;
        const job = active, parsing = job.kind === 'parse-snapshot';
        if (event.data.error) {
          if (!parsing || event.data.errorName !== 'SyntaxError') return failAll(new Error(event.data.error));
          // Corrupt stored JSON is an input failure, not a broken worker. Let
          // fallback validation and unrelated queued checkpoints continue.
          active = null;
          clearWatchdog(job.timer);
          job.reject(new SyntaxError(event.data.error));
        } else {
          const valid = parsing ? Object.prototype.hasOwnProperty.call(event.data, 'value')
            && event.data.value !== undefined : typeof event.data.json === 'string';
          if (!valid) return failAll(new Error('Invalid snapshot worker response'));
          active = null;
          clearWatchdog(job.timer);
          job.resolve(parsing ? event.data.value : event.data.json);
        }
        pump();
      };
    }
    function pump() {
      if (active || disposed || !queue.length) return;
      try {
        ensureWorker();
        if (!ready || active) return;
        const job = queue.shift();
        active = job;
        job.timer = watchdog(() => {
          if (active === job) failAll(new Error('Recovery snapshot ' + (job.kind === 'parse-snapshot' ? 'parsing' : 'encoding') + ' timed out'));
        });
        worker.postMessage({ kind: job.kind, id: job.id,
          ...(job.kind === 'parse-snapshot' ? { json: job.payload } : { snapshot: job.payload }) });
      } catch (error) { failAll(error); }
    }
    function enqueue(kind, payload) {
      return new Promise((resolve, reject) => {
        queue.push({ id: ++nextId, kind, payload, resolve, reject, timer: null });
        pump();
      });
    }
    function textCharacters(snapshot) {
      let length = 0;
      for (const value of Object.values(snapshot)) if (typeof value === 'string') length += value.length;
      for (const value of Object.values(snapshot.workspace?.find || {})) if (typeof value === 'string') length += value.length;
      return length;
    }
    return {
      prepare() {
        if (disposed) return Promise.reject(new Error('Snapshot serializer is disposed'));
        try { ensureWorker(); return readyPromise; }
        catch (error) { failAll(error); return Promise.reject(error); }
      },
      serialize(snapshot) {
        if (disposed) return Promise.reject(new Error('Snapshot serializer is disposed'));
        if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot must be an object');
        // Small DTOs avoid per-job messaging. Large jobs never fall back to UI
        // encoding on worker failure: the controller must report recovery risk.
        if (textCharacters(snapshot) < minimumWorkerCharacters) return JSON.stringify(snapshot);
        return enqueue('serialize-snapshot', snapshot);
      },
      parse(json) {
        if (disposed) return Promise.reject(new Error('Snapshot serializer is disposed'));
        if (typeof json !== 'string') throw new TypeError('snapshot JSON must be a string');
        if (json.length < minimumWorkerCharacters) return JSON.parse(json);
        return enqueue('parse-snapshot', json);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        failAll(new Error('Snapshot serializer is disposed'));
      },
    };
  }
  return { createSnapshotSerializer };
});
