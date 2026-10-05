(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  function isLocalMarkdownLink(reference) {
    if (!reference || reference.startsWith('#') || reference.startsWith('//')) return false;
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[/\\]/i.test(reference)) return false;
    try { return /\.(md|markdown|mdown|mkd)$/i.test(decodeURIComponent(reference.split(/[?#]/)[0])); }
    catch (_) { return /\.(md|markdown|mdown|mkd)$/i.test(reference.split(/[?#]/)[0]); }
  }

  function createMarkdownLinks({ preview, nativeApp, controller, setStatus }) {
    const links = new WeakMap();

    function disable(anchor) {
      anchor.setAttribute('aria-disabled', 'true');
      anchor.setAttribute('tabindex', '-1');
      anchor.title = 'Markdown file could not be resolved';
    }

    async function hydrate(root, documentPath, isCurrent) {
      // Disable all candidates synchronously, before the first filesystem call.
      const candidates = [...root.querySelectorAll('a[href]')].filter(anchor => isLocalMarkdownLink(anchor.getAttribute('href')));
      for (const anchor of candidates) {
        disable(anchor);
        links.delete(anchor);
        anchor.removeAttribute('target');
      }
      if (!nativeApp) return;
      for (const anchor of candidates) {
        if (!isCurrent()) return;
        const reference = anchor.getAttribute('href');
        try {
          const path = await nativeApp.resolveMarkdownLink(documentPath || '', reference);
          if (!isCurrent()) return;
          if (!path) continue;
          links.set(anchor, { documentPath, reference, isCurrent });
          anchor.setAttribute('aria-disabled', 'false');
          anchor.removeAttribute('tabindex');
          anchor.title = path;
        } catch (_) { /* Missing or inaccessible targets remain inactive. */ }
      }
    }

    preview.addEventListener('click', async event => {
      const anchor = event.target.closest('a[href]');
      if (!anchor || !isLocalMarkdownLink(anchor.getAttribute('href'))) return;
      event.preventDefault();
      const link = links.get(anchor);
      if (!link || !link.isCurrent()) return;
      try {
        // A target may have disappeared since the preview was rendered.
        const path = await nativeApp.resolveMarkdownLink(link.documentPath || '', link.reference);
        if (!link.isCurrent() || !preview.contains(anchor)) return;
        if (!path) { links.delete(anchor); disable(anchor); return; }
        await controller.openPaths([path]);
      } catch (error) { setStatus(error.message || String(error)); }
    });
    preview.addEventListener('auxclick', event => {
      const anchor = event.target.closest('a[href]');
      if (anchor && isLocalMarkdownLink(anchor.getAttribute('href'))) event.preventDefault();
    });
    return { hydrate };
  }

  return { isLocalMarkdownLink, createMarkdownLinks };
});
