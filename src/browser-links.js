(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  function isBrowserLink(reference) {
    if (!reference || reference.startsWith('#')) return false;
    if (/^(https?:|file:|\/\/)/i.test(reference)) return true;
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^[a-z]:[/\\]/i.test(reference)) return false;
    const path = reference.split(/[?#]/)[0];
    try { return /\.html?$/i.test(decodeURIComponent(path)); }
    catch (_) { return /\.html?$/i.test(path); }
  }

  function createBrowserLinks({ preview, nativeApp, setStatus }) {
    const links = new WeakMap();
    async function open(event) {
      if (event.type === 'auxclick' && event.button !== 1) return;
      event.preventDefault();
      const anchor = event.currentTarget, link = links.get(anchor);
      if (!link || !link.isCurrent() || !preview.contains(anchor)) return;
      try { await nativeApp.openBrowserLink(link.documentPath || '', link.reference); }
      catch (error) {
        if (link.isCurrent() && preview.contains(anchor)) setStatus(error.message || String(error));
      }
    }
    return {
      hydrate(root, documentPath, isCurrent) {
        if (!nativeApp) return;
        for (const anchor of root.querySelectorAll('a[href]')) {
          const reference = anchor.getAttribute('href');
          if (!isBrowserLink(reference)) continue;
          if (!links.has(anchor)) {
            anchor.addEventListener('click', open);
            anchor.addEventListener('auxclick', open);
          }
          links.set(anchor, { documentPath, reference, isCurrent });
          anchor.removeAttribute('target');
        }
      },
    };
  }
  return { isBrowserLink, createBrowserLinks };
});
