(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  // Self-contained so the same engine can be instantiated inside a blob worker.
  // The vendored Marked source is supplied by the existing inline script tag.
  // Returned HTML is deliberately unsanitized; sanitize it before DOM insertion.
  function createMarkdownEngine(marked) {
    const parser = new marked.Marked({ gfm: true, breaks: false });
    const plain = new marked.Marked({ gfm: true });
    let definitions = new Map(), order = [];
    parser.use({
      hooks: {
        preprocess(src) {
          definitions = new Map(); order = [];
          return src.replace(/^\[\^([^\]\n]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)/gm, (_match, label, body) => {
            definitions.set(label.trim(), body.replace(/\n[ \t]+/g, '\n').trim());
            return '';
          });
        },
        postprocess(html) {
          if (!order.length) return html;
          let out = '<section class="footnotes"><ol>';
          order.forEach((label, i) => {
            const n = i + 1;
            out += '<li id="fn-' + n + '">' + plain.parseInline(definitions.get(label) || '') +
              ' <a class="fn-back" href="#fnref-' + n + '" title="Back to text">↩</a></li>';
          });
          return html + out + '</ol></section>';
        },
      },
      extensions: [{
        name: 'footnoteRef', level: 'inline',
        start(src) { return src.indexOf('[^'); },
        tokenizer(src) {
          const match = /^\[\^([^\]\n]+)\]/.exec(src);
          if (!match) return;
          const label = match[1].trim();
          if (!definitions.has(label)) return;
          return { type: 'footnoteRef', raw: match[0], label };
        },
        renderer(token) {
          let i = order.indexOf(token.label);
          if (i === -1) { order.push(token.label); i = order.length - 1; }
          const n = i + 1;
          return '<sup class="fn-ref" id="fnref-' + n + '"><a href="#fn-' + n + '">' + n + '</a></sup>';
        },
      }],
    });

    const placeholder = i => '\uE000M' + i + '\uE001';
    function extractMath(src) {
      const math = [], out = [];
      let inFence = false, fenceCh = '', disp = null, dispPrefix = '';
      for (const rawLine of src.split('\n')) {
        const line = rawLine;
        if (disp) {
          const close = line.indexOf('$$');
          if (close === -1) { disp.push(line); continue; }
          disp.push(line.slice(0, close));
          math.push({ tex: disp.join('\n'), display: true });
          out.push(dispPrefix + placeholder(math.length - 1) + line.slice(close + 2));
          disp = null; dispPrefix = '';
          continue;
        }
        const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fm) {
          if (!inFence) { inFence = true; fenceCh = fm[1][0]; }
          else if (fm[1][0] === fenceCh) inFence = false;
          out.push(line); continue;
        }
        if (inFence) { out.push(line); continue; }
        let res = '', j = 0, opened = false;
        while (j < line.length) {
          const c = line[j];
          if (c === '`') {
            let k = j; while (line[k] === '`') k++;
            const run = k - j;
            let m = k, close = -1;
            while (m < line.length) {
              if (line[m] === '`') {
                let m2 = m; while (line[m2] === '`') m2++;
                if (m2 - m === run) { close = m2; break; }
                m = m2;
              } else m++;
            }
            if (close !== -1) { res += line.slice(j, close); j = close; }
            else { res += line.slice(j, k); j = k; }
            continue;
          }
          if (c === '\\' && (line[j + 1] === '(' || line[j + 1] === '[')) {
            const closer = line[j + 1] === '(' ? '\\)' : '\\]';
            const end = line.indexOf(closer, j + 2);
            if (end !== -1) {
              math.push({ tex: line.slice(j + 2, end), display: line[j + 1] === '[' });
              res += placeholder(math.length - 1); j = end + 2; continue;
            }
            res += c; j++; continue;
          }
          if (c === '$') {
            if (line[j + 1] === '$') {
              const end = line.indexOf('$$', j + 2);
              if (end !== -1) {
                math.push({ tex: line.slice(j + 2, end), display: true });
                res += placeholder(math.length - 1); j = end + 2; continue;
              }
              disp = [line.slice(j + 2)]; dispPrefix = res; opened = true; break;
            }
            let end = -1;
            for (let m = j + 1; m < line.length; m++) {
              if (line[m] === '$') { if (line[m - 1] !== '\\' && line[m - 1] !== ' ' && m > j + 1) end = m; break; }
            }
            if (end !== -1 && line[j + 1] !== ' ') {
              const tex = line.slice(j + 1, end);
              if (!/^[\d.,]*$/.test(tex)) {
                math.push({ tex, display: false });
                res += placeholder(math.length - 1); j = end + 1; continue;
              }
            }
            res += c; j++; continue;
          }
          res += c; j++;
        }
        if (!opened) out.push(res);
      }
      if (disp) out.push(dispPrefix + '$$' + (disp.length ? '\n' : '') + disp.join('\n'));
      return { src: out.join('\n'), math };
    }
    return (content, options = {}) => {
      const { src, math } = options.math ? extractMath(content) : { src: content, math: [] };
      return { html: parser.parse(src), math };
    };
  }

  function createMarkdownParser({ window: win, librarySource, timeoutMs = 10000 }) {
    let worker = null, url = null, pending = null, nextId = 0, disposed = false;
    function resetWorker() {
      if (worker) worker.terminate();
      if (url) win.URL.revokeObjectURL(url);
      worker = null; url = null;
    }
    function finish(error, result) {
      if (!pending) return;
      const entry = pending; pending = null;
      win.clearTimeout(entry.timer);
      if (error) { resetWorker(); entry.reject(error); }
      else entry.resolve(result);
    }
    function cancel() {
      finish(null, { canceled: true });
      resetWorker();
    }
    function ensureWorker() {
      if (worker) return;
      if (!librarySource) throw new Error('Bundled Markdown parser source is unavailable');
      const source = librarySource + '\nconst parse = (' + createMarkdownEngine.toString() + ')(marked);' +
        '\nonmessage = ({data}) => { try { postMessage({id:data.id,result:parse(data.content,data.options)}); }' +
        ' catch(error) { postMessage({id:data.id,error:error.message || String(error)}); } };';
      url = win.URL.createObjectURL(new win.Blob([source], { type: 'text/javascript' }));
      const instance = new win.Worker(url);
      worker = instance;
      instance.onmessage = event => {
        if (worker !== instance || !pending || !event.data || event.data.id !== pending.id) return;
        const { result, error } = event.data;
        if (error) return finish(new Error(error));
        if (!result || typeof result.html !== 'string' || !Array.isArray(result.math)) return finish(new Error('Invalid Markdown worker response'));
        finish(null, result);
      };
      instance.onerror = event => {
        event.preventDefault();
        if (worker !== instance) return;
        if (pending) finish(new Error('Markdown worker failed'));
        else resetWorker();
      };
    }
    return {
      parse(content, options = {}) {
        if (disposed) return Promise.reject(new Error('Markdown parser is disposed'));
        if (typeof content !== 'string') return Promise.reject(new TypeError('Markdown content must be a string'));
        if (pending) cancel();
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = win.setTimeout(() => finish(new Error('Markdown parsing timed out')), timeoutMs);
          pending = { id, resolve, reject, timer };
          try { ensureWorker(); worker.postMessage({ kind: 'parse-markdown', id, content, options }); }
          catch (error) { finish(error); }
        });
      },
      cancel,
      dispose() { disposed = true; cancel(); },
    };
  }
  return { createMarkdownEngine, createMarkdownParser };
});
