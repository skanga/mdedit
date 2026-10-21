(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  function createFindController({ document, activeEditor, replaceRange, onChange, setView, setStatus, isActiveEditorEvent }) {
    const window = document.defaultView, MDEdit = window.MDEdit;
    const $ = id => document.getElementById(id);
    const findBar = $('find-bar'), findInput = $('find-input'), replaceInput = $('replace-input');
    let matches = [], matchIdx = -1, findRequest = 0, actionEpoch = 0;
    let replacements = Promise.resolve();
    const searchRunner = MDEdit.createSearchRunner({ window, searchMatches: MDEdit.searchMatches });
    window.addEventListener('pagehide', () => searchRunner.dispose());
    const findOptions = () => ({ caseSensitive: $('find-case').checked, wholeWord: $('find-word').checked, regex: $('find-regex').checked });
    for (const id of ['find-case', 'find-word', 'find-regex']) $(id).addEventListener('change', () => { actionEpoch++; runFind(false); });
    replaceInput.addEventListener('input', () => { actionEpoch++; });

    async function runFind(keepIndex) {
      const request = ++findRequest, surface = activeEditor();
      const query = findInput.value;
      const value = query && surface ? surface.value : '';
      const searching = searchRunner.search(value, query, findOptions());
      if (searching && typeof searching.then === 'function') {
        matches = [];
        $('find-replace').disabled = $('find-all').disabled = true;
      }
      const result = searching && typeof searching.then === 'function' ? await searching : searching;
      if (request !== findRequest || result.canceled || activeEditor() !== surface || (query && surface && surface.value !== value)) return false;
      matches = result.matches;
      $('find-error').textContent = result.error ? (result.errorKind ? result.error : 'Invalid regular expression: ' + result.error) : '';
      findInput.setAttribute('aria-invalid', String(Boolean(result.error)));
      $('find-replace').disabled = $('find-all').disabled = Boolean(result.error);
      if (!keepIndex || matchIdx < 0 || matchIdx >= matches.length) matchIdx = matches.length ? 0 : -1;
      paintCount();
      return true;
    }
    function paintCount() {
      const count = $('find-count');
      count.textContent = findInput.value ? (matches.length ? (matchIdx + 1) + '/' + matches.length : '0/0') : '';
      count.classList.toggle('none', !!findInput.value && !matches.length);
    }
    function revealMatch() {
      const surface = activeEditor();
      if (!surface || matchIdx < 0 || !matches.length) return;
      const { start, end } = matches[matchIdx];
      surface.setSelectionRange(start, end);
      const line = surface.value.slice(0, start).split('\n').length - 1;
      const lh = parseFloat(window.getComputedStyle(surface).lineHeight) || 20;
      const top = line * lh;
      if (top < surface.scrollTop || top > surface.scrollTop + surface.clientHeight - lh * 2) {
        surface.scrollTop = Math.max(0, top - surface.clientHeight / 3);
      }
      paintCount();
    }
    function stepMatch(dir) {
      if (!matches.length) return;
      matchIdx = (matchIdx + dir + matches.length) % matches.length;
      revealMatch();
    }
    function queueReplacement(operation) {
      const epoch = actionEpoch, surface = activeEditor();
      const query = findInput.value, replacement = replaceInput.value;
      const current = () => epoch === actionEpoch && activeEditor() === surface
        && findInput.value === query && replaceInput.value === replacement;
      replacements = replacements.then(() => {
        if (current()) return operation(current);
      }).catch(error => setStatus('Replacement failed — ' + (error.message || error)));
      return replacements;
    }
    async function replaceCurrent(current) {
      const surface = activeEditor();
      if (!surface || !await runFind(true) || !current() || matchIdx < 0 || !matches.length) return;
      const { start, end } = matches[matchIdx], focused = document.activeElement;
      const replacement = MDEdit.replacementText(replaceInput.value, matches[matchIdx], findOptions().regex);
      replaceRange(surface, start, end, replacement);
      onChange();
      // Undo-safe insertion focuses the editor; restore immediately, before the
      // next asynchronous search, so another Enter cannot type into the source.
      if (findBar.contains(focused) && document.activeElement === surface) {
        (focused.disabled ? replaceInput : focused).focus();
      }
      if (!await runFind(false) || !current()) return;
      const nextStart = start + replacement.length + (start === end ? 1 : 0);
      const nextIndex = matches.findIndex(match => match.start >= nextStart);
      if (nextIndex >= 0) matchIdx = nextIndex;
      revealMatch();
    }
    async function replaceAll(current) {
      const surface = activeEditor();
      if (!surface || !await runFind(true) || !current() || !matches.length) return;
      const replacement = replaceInput.value, count = matches.length;
      let out = '', last = 0;
      for (const match of matches) {
        out += surface.value.slice(last, match.start) + MDEdit.replacementText(replacement, match, findOptions().regex);
        last = match.end;
      }
      out += surface.value.slice(last);
      replaceRange(surface, 0, surface.value.length, out);
      onChange(); runFind(false);
      setStatus('Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's'));
    }
    function open() {
      actionEpoch++;
      const surface = activeEditor(); if (!surface) return;
      if (document.body.dataset.view === 'preview') setView('split');
      document.body.classList.add('find-open');
      const selected = surface.value.slice(surface.selectionStart, surface.selectionEnd);
      if (selected && !selected.includes('\n')) findInput.value = selected;
      findInput.focus(); findInput.select(); runFind(false);
    }
    function close() {
      document.body.classList.remove('find-open');
      searchRunner.cancel(); findRequest++; actionEpoch++;
      activeEditor()?.focus();
    }
    findInput.addEventListener('input', () => {
      actionEpoch++;
      runFind(false).then(current => { if (current) revealMatch(); });
    });
    findInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    replaceInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); queueReplacement(replaceCurrent); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    $('find-next').addEventListener('click', () => stepMatch(1));
    $('find-prev').addEventListener('click', () => stepMatch(-1));
    $('find-replace').addEventListener('click', () => queueReplacement(replaceCurrent));
    $('find-all').addEventListener('click', () => queueReplacement(replaceAll));
    $('find-close').addEventListener('click', close);
    $('editor-surfaces').addEventListener('keydown', event => {
      if (isActiveEditorEvent(event) && event.key === 'Escape' && document.body.classList.contains('find-open')) close();
    });
    return {
      open,
      refresh() { return runFind(true); },
      capture() {
        return { open: document.body.classList.contains('find-open'), query: findInput.value, replacement: replaceInput.value, matchIndex: matchIdx, ...findOptions() };
      },
      apply(state = {}) {
        actionEpoch++;
        $('find-case').checked = Boolean(state.caseSensitive);
        $('find-word').checked = Boolean(state.wholeWord);
        $('find-regex').checked = Boolean(state.regex);
        findInput.value = state.query || ''; replaceInput.value = state.replacement || '';
        matchIdx = Number.isInteger(state.matchIndex) ? state.matchIndex : -1;
        document.body.classList.toggle('find-open', Boolean(state.open));
        return runFind(true);
      },
    };
  }
  return { createFindController };
});
