(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';
  function installEditorEnhancements({document, activeEditor, replaceRange, onChange, compatibilitySaving = null}) {
    const win = document.defaultView;
    const key = 'mdedit-editor-preferences-v1';
    let stored = {};
    try { stored = JSON.parse(win.localStorage.getItem(key) || '{}') || {}; } catch (_) {}
    const prefs = {
      fontSize: Number.isFinite(stored.fontSize) ? Math.max(10, Math.min(28, stored.fontSize)) : 13,
      tabWidth: [2,4,8].includes(stored.tabWidth) ? stored.tabWidth : 2,
      wrap: stored.wrap !== false,
      lineNumbers: stored.lineNumbers === true,
      formattingToolbar: stored.formattingToolbar !== false,
    };
    const trigger = document.getElementById('btn-editor-options');
    const panel = document.getElementById('editor-options');
    panel.innerHTML = '<h2>Editor preferences</h2>' +
      '<label>Font size <input id="editor-font-size" type="number" min="10" max="28" step="1"></label>' +
      '<label>Tab width <select id="editor-tab-width"><option>2</option><option>4</option><option>8</option></select></label>' +
      '<label><input id="editor-wrap" type="checkbox"> Wrap long lines</label>' +
      '<label><input id="editor-line-numbers" type="checkbox"> Line numbers</label>' +
      '<label><input id="editor-formatting-toolbar" type="checkbox"> Show formatting toolbar</label>' +
      (compatibilitySaving
        ? '<label><input id="editor-compatibility-saving" type="checkbox" aria-describedby="editor-compatibility-help"> Allow compatibility saving</label>' +
          '<p id="editor-compatibility-help" class="editor-preference-help">For all eligible files, across restarts. May change permissions and ownership.</p>'
        : '');
    const size = document.getElementById('editor-font-size'), tabs = document.getElementById('editor-tab-width');
    const wrap = document.getElementById('editor-wrap'), numbers = document.getElementById('editor-line-numbers');
    const toolbarToggle = document.getElementById('editor-formatting-toolbar');
    toolbarToggle.checked = prefs.formattingToolbar;
    size.value = prefs.fontSize; tabs.value = prefs.tabWidth; wrap.checked = prefs.wrap; numbers.checked = prefs.lineNumbers;
    function close(focus = false) { panel.hidden = true; trigger.setAttribute('aria-expanded','false'); if (focus) trigger.focus(); }
    if (compatibilitySaving) {
      // Keep explicit app-wide permission separate from ordinary editor prefs.
      const permissionKey = 'mdedit-allow-compatibility-saving-v1';
      const toggle = document.getElementById('editor-compatibility-saving');
      let allowed = false;
      try { allowed = win.localStorage.getItem(permissionKey) === '1'; } catch (_) {}
      compatibilitySaving.setAllowed(allowed);
      toggle.checked = allowed;
      toggle.addEventListener('change', async () => {
        const requested = toggle.checked;
        toggle.checked = allowed;
        if (toggle.disabled || requested === allowed) return;
        toggle.disabled = true;
        try {
          if (requested) {
            close(true);
            if (await compatibilitySaving.confirmEnable() !== true) return;
            // Do not activate a persistent opt-in if it could not be saved.
            win.localStorage.setItem(permissionKey, '1');
            allowed = true;
            compatibilitySaving.setAllowed(true);
          } else {
            // Revocation takes effect even when persistence is unavailable.
            allowed = false;
            compatibilitySaving.setAllowed(false);
            win.localStorage.removeItem(permissionKey);
          }
        } catch (error) {
          const detail = error && error.message ? error.message : String(error);
          compatibilitySaving.onError(requested
            ? `Compatibility saving remains off — could not confirm or save the preference: ${detail}`
            : `Compatibility saving is off for this session, but could not remember the change; it may return after restart: ${detail}`);
        } finally {
          toggle.checked = allowed;
          toggle.disabled = false;
        }
      });
    }
    trigger.addEventListener('click', () => {
      if (!panel.hidden) return close(true);
      panel.hidden = false; trigger.setAttribute('aria-expanded','true'); size.focus();
    });
    document.addEventListener('click', event => { if (!event.composedPath().includes(trigger.parentElement)) close(); });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(true); } });
    function applyEdit(el, edit) {
      if (!edit) return false;
      replaceRange(el, edit.start, edit.end, edit.text);
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
      onChange(); updateGutter(); return true;
    }
    function format(command) {
      const el = activeEditor(); if (!el) return;
      const edit = win.MDEdit.formatEdit(el.value,el.selectionStart,el.selectionEnd,command);
      close(); applyEdit(el,edit);
    }
    const host = document.getElementById('editor-surfaces');
    host.addEventListener('keydown', event => {
      const el = activeEditor(); if (event.target !== el || event.isComposing) return;
      const mod = /Mac|iPhone|iPad/.test(win.navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      let command = null;
      if (mod && !event.altKey) {
        if (!event.shiftKey) command = ({b:'bold',i:'italic',k:'link',e:'code'})[event.key.toLowerCase()];
        else if (event.key.toLowerCase() === 'c') command = 'code-block';
      } else if (mod && event.altKey && !event.shiftKey) {
        const digit = /^Digit[1-6]$/.test(event.code) ? event.code.slice(-1) : event.key;
        if (/^[1-6]$/.test(digit)) command = 'heading-' + digit;
      }
      if (command) { event.preventDefault(); event.stopImmediatePropagation(); applyEdit(el,win.MDEdit.formatEdit(el.value,el.selectionStart,el.selectionEnd,command)); }
      else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const edit = win.MDEdit.listEdit(el.value,el.selectionStart,el.selectionEnd);
        if (edit) { event.preventDefault(); event.stopImmediatePropagation(); applyEdit(el,edit); }
      }
    }, true);
    let frame = null, layout = null;
    const measure = document.createElement('div');
    measure.setAttribute('aria-hidden','true');
    measure.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;padding:0;border:0;overflow-wrap:break-word;';
    document.body.append(measure);
    function applyPreferences() {
      document.getElementById('formatting-toolbar').hidden = !prefs.formattingToolbar;
      for (const el of host.querySelectorAll('textarea.document-editor')) {
        el.style.fontSize = prefs.fontSize + 'px'; el.style.tabSize = String(prefs.tabWidth);
        el.wrap = prefs.wrap ? 'soft' : 'off'; el.style.whiteSpace = prefs.wrap ? 'pre-wrap' : 'pre';
        let gutter = el.parentElement.querySelector('.editor-gutter');
        if (!gutter) { gutter = document.createElement('div'); gutter.className='editor-gutter'; gutter.setAttribute('aria-hidden','true'); el.before(gutter); }
        gutter.hidden = !prefs.lineNumbers;
        gutter.style.fontSize = prefs.fontSize + 'px';
      }
      updateGutter();
    }
    function paintGutter() {
      frame = null;
      const el = activeEditor(); if (!el || !prefs.lineNumbers) return;
      const gutter = el.parentElement.querySelector('.editor-gutter'); if (!gutter) return;
      const style = win.getComputedStyle(el), top = parseFloat(style.paddingTop), bottom = el.scrollTop + el.clientHeight;
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const signature = [width,style.font,style.lineHeight,prefs.wrap,prefs.tabWidth].join('|');
      if (!layout || layout.value !== el.value || layout.signature !== signature) layout = {value:el.value,signature,offset:0,y:top,rows:[],complete:false};
      measure.style.font = style.font; measure.style.lineHeight = style.lineHeight; measure.style.tabSize = String(prefs.tabWidth);
      measure.style.whiteSpace = prefs.wrap ? 'pre-wrap' : 'pre'; measure.style.width = width + 'px';
      const lineHeight = parseFloat(style.lineHeight);
      while (!layout.complete && layout.y < bottom + lineHeight) {
        const end = el.value.indexOf('\n',layout.offset);
        let height = lineHeight;
        if (prefs.wrap) { measure.textContent = el.value.slice(layout.offset,end < 0 ? el.value.length : end) || '\u200b'; height = measure.getBoundingClientRect().height; }
        layout.rows.push({y:layout.y,height}); layout.y += height;
        layout.offset = end + 1; layout.complete = end < 0;
      }
      const fragment = document.createDocumentFragment();
      layout.rows.forEach((row,index) => {
        if (row.y + row.height < el.scrollTop || row.y > bottom) return;
        const number = document.createElement('div'); number.textContent = String(index + 1);
        number.style.cssText = `position:absolute;right:6px;top:${row.y - el.scrollTop}px;line-height:${lineHeight}px;`;
        fragment.append(number);
      });
      gutter.replaceChildren(fragment);
    }
    function updateGutter() { if (frame === null && prefs.lineNumbers) frame = win.requestAnimationFrame(paintGutter); }
    for (const input of [size,tabs,wrap,numbers,toolbarToggle]) input.addEventListener('change', () => {
      prefs.fontSize = Math.max(10,Math.min(28,Number(size.value) || 13)); size.value = prefs.fontSize;
      prefs.tabWidth = Number(tabs.value); prefs.wrap = wrap.checked; prefs.lineNumbers = numbers.checked;
      prefs.formattingToolbar = toolbarToggle.checked;
      try { win.localStorage.setItem(key,JSON.stringify(prefs)); } catch (_) {}
      layout = null; applyPreferences();
    });
    host.addEventListener('input',updateGutter); host.addEventListener('scroll',updateGutter,true);
    new win.MutationObserver(records => { if (records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 && n.matches('.editor-surface')))) applyPreferences(); }).observe(host,{childList:true});
    new win.ResizeObserver(updateGutter).observe(host);
    applyPreferences();
    return { tabWidth:() => prefs.tabWidth, updateGutter, applyPreferences, format };
  }
  return { installEditorEnhancements };
});
