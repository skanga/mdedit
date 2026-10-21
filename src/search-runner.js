(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  // Literal matching is bounded and synchronous. Untrusted regex never runs on
  // the UI thread, even when workers are unavailable or blocked by policy.
  function createSearchRunner({ window: win, searchMatches, timeoutMs = 500 }) {
    let pending = null, cached = null;
    function cancel() {
      if (pending) pending.finish({ matches: [], error: null, canceled: true });
    }
    function search(value, query, options) {
      if (!options.regex || !query) {
        cancel(); cached = null;
        return searchMatches(value, query, options);
      }
      const key = JSON.stringify([query, options]);
      if (cached && cached.value === value && cached.key === key) return cached.result;
      if (pending && pending.value === value && pending.key === key) return pending.promise;
      cancel(); cached = null;
      let resolve, worker, url, timer;
      const promise = new Promise(done => { resolve = done; });
      const entry = { value, key, promise, finish(result) {
        if (pending !== entry) return;
        pending = null;
        win.clearTimeout(timer);
        if (worker) worker.terminate();
        if (url) win.URL.revokeObjectURL(url);
        if (!result.canceled) cached = { value, key, result };
        resolve(result);
      } };
      pending = entry;
      try {
        const source = 'const searchMatches = ' + searchMatches.toString() + ';' +
          'onmessage = ({data}) => postMessage(searchMatches(data.value, data.query, data.options));';
        url = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
        worker = new win.Worker(url);
        worker.onmessage = event => entry.finish(event.data);
        worker.onerror = event => {
          event.preventDefault();
          entry.finish({ matches: [], error: 'Search worker failed', errorKind: 'worker' });
        };
        timer = win.setTimeout(() => entry.finish({ matches: [], error: 'Search timed out — simplify the regular expression', errorKind: 'timeout' }), timeoutMs);
        worker.postMessage({ value, query, options });
      } catch (_) {
        entry.finish({ matches: [], error: 'Regular expression search requires Web Worker support', errorKind: 'worker' });
      }
      return promise;
    }
    return { search, cancel, dispose() { cancel(); cached = null; } };
  }
  return { createSearchRunner };
});
