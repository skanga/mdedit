const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { DocumentModel } = require('../../src/document-model');

test.use({ trace: 'off' });
const { installFakeTauri, openEditor, activeEditor, setEditorContent } = require('./helpers');

test('tab activation with empty Find does not materialize textarea values', async ({ page }, testInfo) => {
  await installFakeTauri(page, {
    openPaths: ['/one.md', '/two.md'],
    documents: {
      '/one.md': { content: 'one\n'.repeat(25000) },
      '/two.md': { content: 'two\n'.repeat(25000) },
    },
  });
  await openEditor(page);
  await page.locator('#btn-open').click();
  await expect(page.getByRole('tab', { name: /two\.md/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('tab', { name: /one\.md/ }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const reads = await page.evaluate(async () => {
    const prototype = HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    let count = 0;
    Object.defineProperty(prototype, 'value', { ...descriptor, get() {
      if (this.classList.contains('document-editor')) count++;
      return descriptor.get.call(this);
    } });
    try {
      for (const tab of [...document.querySelectorAll('[role="tab"]')].reverse()) {
        tab.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return count;
    } finally { Object.defineProperty(prototype, 'value', descriptor); }
  });
  await testInfo.attach('activation-value-reads.json', { body: JSON.stringify({ reads }), contentType: 'application/json' });
  expect(reads).toBe(0);
});

test('typing handlers with Find open in a 5 MiB document stay within their budget', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setEditorContent(page, 'x'.repeat(5 * 1024 * 1024 - 6) + 'needle');
  await activeEditor(page).press('Control+f');
  await page.locator('#find-input').fill('needle');
  await expect(page.locator('#find-count')).toHaveText('1/1');
  const samples = await activeEditor(page).evaluate(async editor => {
    const values = [];
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      editor.setRangeText('x', 0, 0, 'end');
      const handlerStarted = performance.now();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      const handlerMs = performance.now() - handlerStarted;
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      values.push({ mutationMs: handlerStarted - started, handlerMs, frameMs: performance.now() - started });
    }
    return values;
  });
  // Budget application work separately. Native textarea layout for a single
  // multi-megabyte line is measured, not mislabeled as fast because handlers are.
  const handlers = samples.map(sample => sample.handlerMs).sort((a, b) => a - b);
  const metrics = { samples, p95Ms: handlers[Math.ceil(handlers.length * 0.95) - 1], budgetMs: 50 };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/typing-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('typing-with-find.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(metrics.p95Ms).toBeLessThanOrEqual(metrics.budgetMs);
  await expect(page.locator('#find-count')).toHaveText('1/1');
});

test('a 5 MiB recovery snapshot encodes off-thread and reaches the fake bridge', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => {
    const stringify = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (value?.schemaVersion === 1 && typeof value.content === 'string' && value.content.length >= 256 * 1024) {
        throw new Error('Snapshot JSON encoding ran on the UI thread');
      }
      return stringify.call(this, value, ...args);
    };
  });
  const bytes = 5 * 1024 * 1024;
  await setEditorContent(page, 'x'.repeat(bytes));
  const started = Date.now();
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  const checkpointMs = Date.now() - started;
  const contentLength = await page.evaluate(() => {
    const writes = window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_document');
    return JSON.parse(writes.at(-1).args.json).content.length;
  });
  expect(contentLength).toBe(bytes);
  const metrics = { contentBytes: bytes, checkpointMs,
    evidence: 'Chromium fake bridge: encoding queue/transfer, frontend checkpoint and driver round-trip latency; excludes native disk I/O' };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/recovery-encoding-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('recovery-encoding.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
});

test('5 MiB browser write validation replaces main-thread parsing with queued worker parsing', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  const bytes = 5 * 1024 * 1024;
  const payloads = [1, 2].map(snapshotRevision => JSON.stringify(new DocumentModel({
    id: 'validation-metric', displayName: 'metric.md', content: 'x'.repeat(bytes),
    savedContentSha256: 'saved', snapshotRevision,
  }).toSnapshot()));
  const metrics = await page.evaluate(async payloads => {
    const memory = () => {
      const values = new Map();
      return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key) };
    };
    const codec = window.__MDEDIT_TEST_HOOK__.controller.snapshotSerializer;
    const parse = JSON.parse;
    let baselineCalls = 0, baselineMainParseMs = 0, workerMainCalls = 0;
    const baseline = window.MDEdit.createBrowserRecoveryIo(memory(), { snapshotParser(raw) {
      const started = performance.now();
      const value = parse(raw);
      baselineCalls++;
      baselineMainParseMs += performance.now() - started;
      return value;
    } });
    for (let index = 0; index < payloads.length; index++) await baseline.writeRecoveryDocument('validation-metric', index + 1, payloads[index]);
    const storage = memory(), worker = window.MDEdit.createBrowserRecoveryIo(storage, { snapshotParser: raw => codec.parse(raw) });
    JSON.parse = (raw, ...args) => {
      if (typeof raw === 'string' && raw.length >= 256 * 1024) { workerMainCalls++; throw new Error('Large validation parsed on the UI thread'); }
      return parse(raw, ...args);
    };
    const started = performance.now();
    try {
      for (let index = 0; index < payloads.length; index++) await worker.writeRecoveryDocument('validation-metric', index + 1, payloads[index]);
      return { baselineCalls, baselineMainParseMs, workerMainCalls, workerCheckpointMs: performance.now() - started,
        storedCurrentMatches: storage.getItem('mdedit-recovery-v1:document:validation-metric:current') === payloads[1] };
    } finally { JSON.parse = parse; }
  }, payloads);
  expect(metrics.baselineCalls).toBe(3);
  expect(metrics.workerMainCalls).toBe(0);
  expect(metrics.storedCurrentMatches).toBe(true);
  const report = { contentBytes: bytes, ...metrics,
    evidence: 'Chromium in-memory storage: explicit synchronous-parser baseline versus worker parsing; checkpoint time includes queue/transfer and schema checks, not localStorage, native IPC or disk I/O' };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/recovery-validation-metrics.json', JSON.stringify(report, null, 2));
  await testInfo.attach('recovery-validation.json', { body: JSON.stringify(report), contentType: 'application/json' });
});

test('syntax highlighting has a controlled worker-versus-direct-engine diagnostic', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  const code = 'const value = 42;\n'.repeat(8192);
  const metrics = await page.evaluate(async text => {
    const started = performance.now();
    const baseline = hljs.highlight(text, { language: 'js' }).value;
    const directEngineMs = performance.now() - started;
    let mainHighlightCalls = 0;
    hljs.highlight = () => { mainHighlightCalls++; throw new Error('UI-thread highlighting forbidden'); };
    const highlighter = window.MDEdit.createSyntaxHighlighter({ window,
      librarySource: document.getElementById('highlight-library').textContent });
    const workerStarted = performance.now();
    try {
      const result = await highlighter.highlight([{ language: 'js', text }]);
      return { codeUnits: text.length, directEngineMs, workerElapsedMs: performance.now() - workerStarted,
        mainHighlightCalls, identicalMarkup: result.results[0] === baseline };
    } finally { highlighter.dispose(); }
  }, code);
  expect(metrics.mainHighlightCalls).toBe(0);
  expect(metrics.identicalMarkup).toBe(true);
  const report = { ...metrics,
    evidence: 'Chromium controlled direct-engine baseline versus cold worker startup/processing/transfer; excludes DOM sanitization/insertion, native IPC, disk and worker-isolate memory' };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/syntax-highlighting-metrics.json', JSON.stringify(report, null, 2));
  await testInfo.attach('syntax-highlighting.json', { body: JSON.stringify(report), contentType: 'application/json' });
});

test('a 5 MiB document renders fully through the Markdown worker', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const bytes = 5 * 1024 * 1024;
  await setEditorContent(page, 'x'.repeat(bytes));
  await page.evaluate(() => { marked.parse = () => { throw new Error('Main-thread parser invoked'); }; });
  const started = Date.now();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(() => page.locator('#preview').evaluate(preview => preview.textContent.trim().length), { timeout: 15000 }).toBe(bytes);
  const metrics = { bytes, completionMs: Date.now() - started, budgetMs: 15000 };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/large-preview-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('large-preview.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(metrics.completionMs).toBeLessThanOrEqual(metrics.budgetMs);
});

test('mixed Markdown, math and diagrams render within a separate preview budget', async ({ page }, testInfo) => {
  await installFakeTauri(page);
  await openEditor(page);
  const sections = Array.from({ length: 10 }, (_, i) =>
    `## Section ${i}\n\n$\\frac{a}{b}$\n\n\`\`\`mermaid\ngraph TD\nA${i}-->B${i}\n\`\`\`\n\n| A | B |\n|---|---|\n| 1 | 2 |`).join('\n\n');
  const started = Date.now();
  await setEditorContent(page, sections);
  await expect(page.locator('#preview .mermaid-block svg')).toHaveCount(10, { timeout: 10000 });
  await expect(page.locator('#preview .katex')).toHaveCount(10);
  await expect(page.locator('#preview table')).toHaveCount(10);
  const metrics = { completionMs: Date.now() - started, budgetMs: 10000 };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/mixed-preview-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('mixed-preview.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(metrics.completionMs).toBeLessThanOrEqual(metrics.budgetMs);
});
