const { test, expect } = require('@playwright/test');
const { activeEditor, installFakeTauri, openEditor, setEditorContent } = require('./helpers');

async function holdMarkdownJobs(page) {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.__heldMarkdown = [];
    window.__holdMarkdown = false;
    window.__markdownReplies = 0;
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', () => { window.__markdownReplies++; });
      }
      postMessage(message, ...transfer) {
        if (message.kind !== 'parse-markdown' || !window.__holdMarkdown) return super.postMessage(message, ...transfer);
        window.__heldMarkdown.push({ worker: this, content: message.content, send: () => {
          // Superseded jobs intentionally target a terminated worker.
          try { super.postMessage(message, ...transfer); } catch (_) {}
        } });
      }
    };
  });
}

for (const build of ['/index.html', '/index-lite.html']) {
  test(`preview and exports do not invoke the UI-thread Markdown parser (${build})`, async ({ page }) => {
    await installFakeTauri(page, { savePath: '/out/worker.html' });
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await page.evaluate(() => {
      window.__mainParseCalls = 0;
      const forbidden = () => { window.__mainParseCalls++; throw new Error('Markdown parsing ran on the UI thread'); };
      marked.parse = forbidden;
      marked.Marked.prototype.parse = forbidden;
    });
    await setEditorContent(page, '# Worker preview\n\nA note[^a].\n\n[^a]: **Footnote** text.');
    await expect(page.locator('#preview h1')).toHaveText('Worker preview');
    await expect(page.locator('#preview .footnotes strong')).toHaveText('Footnote');
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'));
    expect(await page.evaluate(() => window.__mainParseCalls)).toBe(0);
    const exported = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.__testBridge.calls.writes[0].data)));
    expect(exported).toContain('Worker preview');
    expect(exported).toContain('class="footnotes"');
  });
}

test('delayed Markdown parsing cannot overwrite a newer edit', async ({ page }) => {
  await holdMarkdownJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  await setEditorContent(page, '# Before');
  await expect(page.locator('#preview h1')).toHaveText('Before');
  await page.evaluate(() => { window.__holdMarkdown = true; });
  await setEditorContent(page, '# Obsolete');
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(1);
  await setEditorContent(page, '# Latest');
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(2);
  await page.evaluate(() => { window.__holdMarkdown = false; window.__heldMarkdown.forEach(job => job.send()); });
  await expect(page.locator('#preview h1')).toHaveText('Latest');
  await expect(activeEditor(page)).toHaveValue('# Latest');
});

test('preview commit retains scrolling done while the Markdown worker was pending', async ({ page }) => {
  await holdMarkdownJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  const content = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\nParagraph ${i}.`).join('\n\n');
  await setEditorContent(page, content);
  await expect(page.locator('#preview')).toContainText('Paragraph 99.');
  await page.locator('#preview-pane').evaluate(pane => { pane.scrollTop = 1200; });
  await page.evaluate(() => { window.__holdMarkdown = true; });
  await setEditorContent(page, content + '\n\n# Updated');
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(1);
  await page.locator('#preview-pane').evaluate(pane => { pane.scrollTop = 1800; });
  await page.evaluate(() => { window.__holdMarkdown = false; window.__heldMarkdown.forEach(job => job.send()); });
  await expect(page.locator('#preview h1')).toHaveText('Updated');
  await expect.poll(() => page.locator('#preview-pane').evaluate(pane => pane.scrollTop)).toBe(1800);
});

test('switching to Edit while parsing skips hidden preview DOM work', async ({ page }) => {
  await holdMarkdownJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  await setEditorContent(page, '# Before');
  await expect(page.locator('#preview h1')).toHaveText('Before');
  const replies = await page.evaluate(() => { window.__holdMarkdown = true; return window.__markdownReplies; });
  await setEditorContent(page, '# Hidden update');
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => { window.__holdMarkdown = false; window.__heldMarkdown[0].send(); });
  await expect.poll(() => page.evaluate(() => window.__markdownReplies)).toBeGreaterThan(replies);
  await expect(page.locator('#preview h1')).toHaveText('Before');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#preview h1')).toHaveText('Hidden update');
});

test('an isolated HTML export does not cancel pending live preview parsing', async ({ page }) => {
  await holdMarkdownJobs(page);
  await installFakeTauri(page, { savePath: '/out/independent.html' });
  await openEditor(page);
  await setEditorContent(page, '# Before');
  await expect(page.locator('#preview h1')).toHaveText('Before');
  await page.evaluate(() => { window.__holdMarkdown = true; });
  await setEditorContent(page, '# Concurrent');
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(1);
  await page.evaluate(() => { window.__pendingExport = window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'); });
  await expect.poll(() => page.evaluate(() => window.__heldMarkdown.length)).toBe(2);
  expect(await page.evaluate(() => window.__heldMarkdown[0].worker !== window.__heldMarkdown[1].worker)).toBe(true);
  await page.evaluate(() => window.__heldMarkdown[1].send());
  await page.evaluate(() => window.__pendingExport);
  expect(await page.evaluate(() => window.__testBridge.calls.writes.length)).toBe(1);
  await expect(page.locator('#preview h1')).toHaveText('Before');
  await page.evaluate(() => { window.__holdMarkdown = false; window.__heldMarkdown[0].send(); });
  await expect(page.locator('#preview h1')).toHaveText('Concurrent');
});

test('unavailable Markdown workers leave the source editable and reject exports', async ({ page }) => {
  await page.addInitScript(() => { window.Worker = undefined; });
  await installFakeTauri(page, { savePath: '/out/blocked.html' });
  await openEditor(page);
  await setEditorContent(page, '# Still editable');
  await expect(activeEditor(page)).toHaveValue('# Still editable');
  await expect(page.locator('#status')).toContainText('Worker');
  const error = await page.evaluate(async () => {
    try { await window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'); }
    catch (error) { return error.message; }
  });
  expect(error).toContain('Worker');
  expect(await page.evaluate(() => window.__testBridge.calls.writes)).toEqual([]);
});

test('preview failure remains independent of healthy recovery and clears after current preview success', async ({ page }) => {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        if (message.kind === 'parse-markdown' && window.__failPreview) throw new Error('preview parser unavailable');
        return super.postMessage(message, ...transfer);
      }
    };
  });
  await installFakeTauri(page);
  await openEditor(page);
  await page.evaluate(() => { window.__failPreview = true; });
  await setEditorContent(page, '# Newer draft');
  await expect(page.locator('#status')).toContainText('preview parser unavailable');
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  await expect(page.getByRole('tab')).toContainText('Preview failed');
  await expect(page.locator('.document-tab.recovery-failed')).toHaveCount(0);
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.activeDocument().recoveryStatus)).toBe('clean');
  await expect(page.locator('#btn-retry-recovery')).not.toBeVisible();
  await page.evaluate(async () => {
    window.__failPreview = false;
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    await controller.renderDocument(controller.activeDocument().id, { force: true });
  });
  await expect(page.locator('#preview h1')).toHaveText('Newer draft');
  await expect(page.getByRole('tab')).not.toContainText('Preview failed');
  await expect(page.locator('#status')).not.toContainText('preview parser unavailable');
});

test('export messages and transient footer expiry cannot hide a real recovery failure', async ({ page }) => {
  await installFakeTauri(page, { openPaths: ['/project/source.md'], savePath: '/out/source.md', documents: {
    '/project/source.md': { content: '[Target](target.md)' }, '/project/target.md': { content: '# Target' },
  } });
  await openEditor(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const link = page.locator('#preview a', { hasText: 'Target' });
  await expect(link).toHaveAttribute('aria-disabled', 'false');
  await page.evaluate(async () => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    controller.io.writeRecoveryManifest = async () => { throw new Error('checkpoint publication failed'); };
    await controller.persistManifest().catch(() => {});
    await controller.exportActive('md');
  });
  await expect(page.locator('.document-tab.is-selected')).toHaveClass(/recovery-failed/);
  await expect(page.locator('#status')).toContainText('checkpoint publication failed');
  await page.evaluate(() => { window.nativeApp.resolveMarkdownLink = async () => { throw new Error('Temporary link check failed'); }; });
  await link.click();
  await expect(page.locator('#status')).toContainText('Temporary link check failed');
  await expect(page.locator('#status')).toContainText('checkpoint publication failed');
  await expect(page.locator('#status')).not.toContainText('Temporary link check failed', { timeout: 6500 });
  await expect(page.locator('#status')).toContainText('checkpoint publication failed');
  await expect(page.locator('.document-tab.is-selected')).toHaveClass(/recovery-failed/);
  await expect(page.locator('#btn-retry-recovery')).toBeVisible();
});

test('an older tab message timer cannot clear a newer active-tab announcement', async ({ page }) => {
  await page.addInitScript(() => {
    const setTimeout = window.setTimeout;
    window.__footerTimers = [];
    window.setTimeout = function(callback, delay, ...args) {
      if (delay !== 4000 || typeof callback !== 'function') return setTimeout.call(this, callback, delay, ...args);
      const entry = { expired: false };
      window.__footerTimers.push(entry);
      return setTimeout.call(this, (...values) => { entry.expired = true; callback.apply(window, values); }, delay, ...args);
    };
  });
  await installFakeTauri(page, { openPaths: ['/project/a.md', '/project/b.md'], documents: {
    '/project/a.md': { content: '[Target](target.md)' }, '/project/b.md': { content: '# B' },
    '/project/target.md': { content: '# Target' },
  } });
  await openEditor(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('tab', { name: /a.md/ }).click();
  const link = page.locator('#preview a', { hasText: 'Target' });
  await expect(link).toHaveAttribute('aria-disabled', 'false');
  await page.evaluate(() => { window.nativeApp.resolveMarkdownLink = async () => { throw new Error('Message owned by A'); }; });
  await link.click();
  await expect(page.locator('#status')).toContainText('Message owned by A');
  await page.evaluate(() => { window.__watchedFooterTimer = window.__footerTimers.at(-1); });
  await page.getByRole('tab', { name: /b.md/ }).click();
  await expect(page.locator('#status')).toContainText('b.md');
  await expect.poll(() => page.evaluate(() => window.__watchedFooterTimer.expired), { timeout: 6500 }).toBe(true);
  await expect(page.getByRole('tab', { name: /a.md/ })).not.toContainText('Message owned by A');
  await expect(page.locator('#status')).toContainText('b.md');
});

test('Markdown features retain footnotes, code fences, callouts, tables and safe DOM', async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await setEditorContent(page, '# Features\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> Keep this.\n\n```js\nconst x = "$not_math$";\n```\n\nInline $x^2$ and note[^n].\n\n[^n]: A **strong** footnote.\n\n<img src=x onerror="window.__unsafe=true">');
  await expect(page.locator('#preview h1')).toHaveText('Features');
  await expect(page.locator('#preview .task input')).toBeChecked();
  await expect(page.locator('#preview table')).toHaveCount(1);
  await expect(page.locator('#preview .callout-note')).toContainText('Keep this.');
  await expect(page.locator('#preview pre code')).toContainText('$not_math$');
  await expect(page.locator('#preview .katex')).toHaveCount(1);
  await expect(page.locator('#preview .footnotes strong')).toHaveText('strong');
  await expect(page.locator('#preview [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
});
