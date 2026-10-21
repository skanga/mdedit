(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  // Rendering is isolated from the live preview. The caller owns document
  // captures and provides the lifecycle guards; this module owns export flow.
  function createExportOperation(capture, renderer, exporter) {
    const exportDocument = typeof exporter === 'function' ? exporter : exporter.export;
    if (typeof exportDocument !== 'function') throw new TypeError('exporter must be a function or provide export');
    return async () => {
      let exportCapture = capture;
      const format = capture.format;
      if (format === 'html' || format === 'png') {
        const renderForExport = renderer && renderer.renderForExport;
        if (typeof renderForExport !== 'function') {
          throw new Error(`isolated ${format.toUpperCase()} export renderer is unavailable`);
        }
        const renderedHtml = await renderForExport.call(renderer, capture);
        if (typeof renderedHtml !== 'string' || renderedHtml.length === 0) {
          throw new Error(`isolated ${format.toUpperCase()} export produced no HTML`);
        }
        exportCapture = Object.freeze({ ...capture, renderedHtml });
      }
      return exportDocument.call(exporter, exportCapture);
    };
  }

  async function runCapturedExport({ capture, label, operation, isCurrent, owns, setStatus }) {
    setStatus({ status: 'exporting', message: `Exporting ${label}`, editRevision: capture.editRevision });
    try {
      const result = await operation(capture, isCurrent);
      if (isCurrent()) {
        const canceled = Boolean(result && result.canceled);
        const message = canceled ? `Export canceled for ${label}`
          : result && typeof result.message === 'string' ? result.message : `Exported ${label}`;
        setStatus({ status: canceled ? 'canceled' : 'exported', message, editRevision: capture.editRevision });
      }
      return result;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (owns()) {
        setStatus({ status: 'failed', message: `Could not export ${label}: ${error.message}`, editRevision: capture.editRevision });
      }
      throw error;
    }
  }
  return { createExportOperation, runCapturedExport };
});
