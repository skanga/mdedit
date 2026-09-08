(function(root) {
  'use strict';
  root.MDEdit.installFormattingToolbar = function({document, format}) {
    const bar = document.getElementById('formatting-toolbar');
    const mod = /Mac|iPhone|iPad/.test(root.navigator.platform) ? '⌘' : 'Ctrl+';
    const icons = {
      list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/>',
      quote: '<path fill="currentColor" stroke="none" d="M10 5C6 5 3 8 3 12v7h7v-8H6c0-2 2-4 4-4V5Zm11 0c-4 0-7 3-7 7v7h7v-8h-4c0-2 2-4 4-4V5Z"/>',
      link: '<path d="m9 15 6-6m-7 1-3 3a4 4 0 0 0 6 6l3-3m-4-8 3-3a4 4 0 0 1 6 6l-3 3"/>',
      rule: '<path d="M4 12h16"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
      table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M11 9v12"/>',
      code: '<path d="m7 6-5 6 5 6m10-12 5 6-5 6m-3-15-4 18"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    };
    const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
    const command = (id, label, face = label, shortcut = '', className = '') =>
      `<button type="button" class="${className}" data-format="${id}" aria-label="${label}" title="${label}${shortcut ? ' (' + shortcut + ')' : ''}">${face}</button>`;
    const disclosure = (id, label, face, items, className = '') =>
      `<span class="format-disclosure ${className}"><button type="button" aria-label="${label}" title="${label}" aria-expanded="false" aria-controls="format-menu-${id}">${face}${id === 'more' ? '' : '<svg class="format-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4"/></svg>'}</button><div id="format-menu-${id}" class="format-menu" hidden>${items}</div></span>`;
    const quote = command('quote', 'Blockquote', icon('quote'), '', 'format-secondary');
    const image = command('image', 'Image', icon('image'), '', 'format-secondary');
    const table = command('table', 'Table', icon('table'), '', 'format-secondary');
    const codeItems = command('code', 'Inline code', 'Inline code', mod + 'E') + command('code-block', 'Code block', 'Code block', mod + 'Shift+C');
    bar.innerHTML = disclosure('headings', 'Heading', 'H', Array.from({length:6}, (_, i) => command('heading-' + (i+1), 'Heading ' + (i+1), 'Heading ' + (i+1), mod + 'Alt+' + (i+1))).join('')) +
      command('bold', 'Bold', '<b>B</b>', mod + 'B') + command('italic', 'Italic', '<i>I</i>', mod + 'I') +
      '<span class="format-divider" aria-hidden="true"></span>' +
      disclosure('lists', 'List', icon('list'), command('list-bullet', 'Bulleted list') + command('list-numbered', 'Numbered list') + command('list-task', 'Task list')) + quote +
      '<span class="format-divider" aria-hidden="true"></span>' + command('link', 'Link', icon('link'), mod + 'K') + image + table +
      disclosure('code', 'Code', icon('code'), codeItems, 'format-secondary') +
      command('rule', 'Horizontal rule', icon('rule'), '', 'format-secondary') +
      command('equation', 'Equation', 'Σ', '', 'format-secondary') +
      disclosure('more', 'More formatting', icon('more'),
        '<div class="format-overflow">' + command('quote', 'Blockquote') + command('image', 'Image') + command('table', 'Table') + codeItems + '</div>' +
        command('rule', 'Horizontal rule') + command('equation', 'Equation'), 'format-more');

    function closeMenus() {
      for (const button of bar.querySelectorAll('[aria-expanded]')) button.setAttribute('aria-expanded', 'false');
      for (const menu of bar.querySelectorAll('.format-menu')) menu.hidden = true;
    }
    bar.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.hasAttribute('aria-controls')) {
        const open = button.getAttribute('aria-expanded') !== 'true';
        closeMenus();
        button.setAttribute('aria-expanded', String(open));
        document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
      } else if (button.dataset.format) {
        closeMenus();
        // The native importer preserves selection and handles unsaved documents.
        const attach = document.getElementById('btn-attach');
        if (button.dataset.format === 'image' && !attach.hidden) attach.click();
        else format(button.dataset.format);
      }
    });
    bar.addEventListener('keydown', event => {
      const button = event.target.closest('button'); if (!button) return;
      const menu = button.closest('.format-menu');
      if (event.key === 'Escape') {
        event.preventDefault(); closeMenus();
        (menu ? menu.parentElement.querySelector('button') : button).focus();
      } else if (event.key === 'ArrowDown' && button.hasAttribute('aria-controls')) {
        event.preventDefault(); closeMenus(); button.click();
        document.getElementById(button.getAttribute('aria-controls')).querySelector('button').focus();
      } else if (['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        const buttons = [...(menu || bar).querySelectorAll('button')].filter(el => el.getClientRects().length && (menu || !el.closest('.format-menu')));
        const index = buttons.indexOf(button), step = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
    });
    document.addEventListener('click', event => { if (!bar.contains(event.target)) closeMenus(); });
    document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Tab') closeMenus(); });
    bar.addEventListener('focusout', event => { if (!bar.contains(event.relatedTarget)) closeMenus(); });
    root.addEventListener('resize', closeMenus);
  };
})(window);
