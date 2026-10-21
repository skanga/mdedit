(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  // Self-contained for the worker. Match the existing explicit-language policy;
  // highlighting is optional, and a grammar error must not hide the code.
  function highlightCodeBlocks(hljs, blocks) {
    return blocks.map(({ language, text }) => {
      if (!language || language === 'mermaid') return null;
      try {
        return hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : null;
      } catch (_) { return null; }
    });
  }

  function createSyntaxHighlighter({ window: win, librarySource, timeoutMs = 10000 }) {
    let worker = null, url = null, pending = null, nextId = 0, disposed = false;
    function resetWorker() {
      if (worker) worker.terminate();
      if (url) win.URL.revokeObjectURL(url);
      worker = null; url = null;
    }
    function finish(result, reset = false) {
      if (!pending) return;
      const entry = pending; pending = null;
      win.clearTimeout(entry.timer);
      if (reset) resetWorker();
      entry.resolve(result);
    }
    function plain() { finish({ canceled: false, results: [] }, true); }
    function cancel() {
      finish({ canceled: true, results: [] });
      resetWorker();
    }
    function ensureWorker() {
      if (worker) return;
      if (!librarySource) throw new Error('Bundled highlighting source is unavailable');
      const source = librarySource + '\nconst highlight = (' + highlightCodeBlocks.toString() + ');' +
        '\nonmessage = ({data}) => { try { postMessage({id:data.id,results:highlight(hljs,data.blocks)}); }' +
        ' catch(error) { postMessage({id:data.id,error:error.message || String(error)}); } };';
      url = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
      const instance = new win.Worker(url);
      worker = instance;
      instance.onmessage = ({ data }) => {
        if (worker !== instance || !pending || !data || data.id !== pending.id) return;
        if (!Array.isArray(data.results) || data.results.length !== pending.count
            || data.results.some(value => value !== null && typeof value !== 'string')) return plain();
        finish({ canceled: false, results: data.results });
      };
      instance.onerror = event => {
        event.preventDefault();
        if (worker !== instance) return;
        if (pending) plain();
        else resetWorker();
      };
    }
    return {
      highlight(blocks) {
        if (disposed) return Promise.reject(new Error('Syntax highlighter is disposed'));
        if (!Array.isArray(blocks) || blocks.some(block => !block || typeof block.language !== 'string' || typeof block.text !== 'string')) {
          return Promise.reject(new TypeError('highlight blocks must contain language and text strings'));
        }
        if (pending) cancel();
        if (!blocks.length) return Promise.resolve({ canceled: false, results: [] });
        return new Promise(resolve => {
          const id = ++nextId;
          pending = { id, resolve, count: blocks.length, timer: null };
          pending.timer = win.setTimeout(() => {
            if (!pending || pending.id !== id) return;
            // Let replies already queued behind native layout run first.
            pending.timer = win.setTimeout(() => { if (pending && pending.id === id) plain(); }, 0);
          }, timeoutMs);
          try { ensureWorker(); worker.postMessage({ kind: 'highlight-code', id, blocks }); }
          catch (_) { plain(); } // No main-thread highlighting fallback.
        });
      },
      cancel,
      dispose() { if (!disposed) { disposed = true; cancel(); } },
    };
  }
  return { highlightCodeBlocks, createSyntaxHighlighter };
});
