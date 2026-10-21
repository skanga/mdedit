const { test, expect } = require('@playwright/test');
const { activeEditor, installFakeTauri, openEditor, setEditorContent } = require('./helpers');

async function forbidMainHighlight(page) {
  await page.evaluate(() => {
    window.__mainHighlightCalls = 0;
    hljs.highlight = () => { window.__mainHighlightCalls++; throw new Error('UI-thread highlighting is forbidden'); };
  });
}
async function holdHighlightJobs(page) {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.__heldHighlights = [];
    window.__highlightReplies = 0;
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => { if (Array.isArray(event.data?.results)) window.__highlightReplies++; });
      }
      postMessage(message, ...transfer) {
        if (message.kind === 'highlight-code' && window.__holdHighlights) {
          window.__heldHighlights.push({ worker: this, send: () => { try { super.postMessage(message, ...transfer); } catch (_) {} } });
          return;
        }
        return super.postMessage(message, ...transfer);
      }
    };
  });
}

for (const build of ['/index.html', '/index-lite.html']) {
  test(`preview and HTML export highlight without the UI-thread engine (${build})`, async ({ page }) => {
    await installFakeTauri(page, { savePath: '/out/highlighted.html' });
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await forbidMainHighlight(page);
    const code = 'const value = "<img src=x onerror=alert(1)>";';
    await setEditorContent(page, '# Code\n\n```js\n' + code + '\n```\n\n<pre><code class="language-python">print(&quot;raw HTML&quot;)</code></pre>');
    await expect(page.locator('#preview code.language-js .hljs-keyword')).toHaveText('const');
    await expect(page.locator('#preview code.language-python .hljs-built_in')).toHaveText('print');
    await expect(page.locator('#preview code.language-js')).toHaveText(code + '\n');
    await expect(page.locator('#preview code img')).toHaveCount(0);
    await expect(page.locator('#preview .code-wrap')).toHaveCount(2);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.__copiedCode = text; } } }));
    await page.locator('#preview .code-wrap').filter({ has: page.locator('code.language-js') }).getByRole('button', { name: 'Copy', exact: true }).click();
    expect(await page.evaluate(() => window.__copiedCode)).toBe(code + '\n');
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'));
    const exported = await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.__testBridge.calls.writes.at(-1).data)));
    expect(exported).toContain('hljs-keyword');
    expect(exported).toContain('hljs-built_in');
    expect(exported).not.toContain('onerror="alert');
    expect(await page.evaluate(() => window.__mainHighlightCalls)).toBe(0);
  });
}

test('a delayed highlighting result cannot mutate a newer preview', async ({ page }) => {
  await holdHighlightJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  await forbidMainHighlight(page);
  await page.evaluate(() => { window.__holdHighlights = true; });
  await setEditorContent(page, '```js\nconst obsolete = 1;\n```');
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(1);
  await setEditorContent(page, '```js\nconst latest = 2;\n```');
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(2);
  await page.evaluate(() => { window.__holdHighlights = false; window.__heldHighlights.forEach(job => job.send()); });
  await expect(page.locator('#preview code .hljs-keyword')).toHaveText('const');
  await expect(page.locator('#preview code')).toContainText('latest');
  await expect(page.locator('#preview code')).not.toContainText('obsolete');
});

test('export highlighting uses a worker independent of a pending live preview', async ({ page }) => {
  await holdHighlightJobs(page);
  await installFakeTauri(page, { savePath: '/out/independent-highlight.html' });
  await openEditor(page);
  await forbidMainHighlight(page);
  await page.evaluate(() => { window.__holdHighlights = true; });
  await setEditorContent(page, '```js\nconst concurrent = 1;\n```');
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(1);
  await page.evaluate(() => { window.__highlightExport = window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'); });
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(2);
  expect(await page.evaluate(() => window.__heldHighlights[0].worker !== window.__heldHighlights[1].worker)).toBe(true);
  await page.evaluate(() => window.__heldHighlights[1].send());
  await page.evaluate(() => window.__highlightExport);
  await page.evaluate(() => { window.__holdHighlights = false; window.__heldHighlights[0].send(); });
  await expect(page.locator('#preview code .hljs-keyword')).toHaveText('const');
});

test('late highlighting does not destroy an existing code-text selection', async ({ page }) => {
  await holdHighlightJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  await page.evaluate(() => { window.__holdHighlights = true; });
  await setEditorContent(page, '```js\nconst selected = 1;\n```');
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(1);
  const before = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#preview code'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { replies: window.__highlightReplies, selected: selection.toString() };
  });
  expect(before.selected).toContain('const selected = 1;');
  await page.evaluate(() => { window.__holdHighlights = false; window.__heldHighlights[0].send(); });
  await expect.poll(() => page.evaluate(() => window.__highlightReplies)).toBeGreaterThan(before.replies);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(before.selected);
  await expect(page.locator('#preview code')).not.toHaveClass(/hljs/);
});

test('switching to Edit while highlighting prevents hidden result insertion', async ({ page }) => {
  await holdHighlightJobs(page);
  await installFakeTauri(page);
  await openEditor(page);
  await page.evaluate(() => { window.__holdHighlights = true; });
  await setEditorContent(page, '```js\nconst hidden = 1;\n```');
  await expect.poll(() => page.evaluate(() => window.__heldHighlights.length)).toBe(1);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => { window.__holdHighlights = false; window.__heldHighlights[0].send(); });
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.renderDocument(window.__MDEDIT_TEST_HOOK__.controller.activeDocument().id));
  await expect(page.locator('#preview code .hljs-keyword')).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#preview code .hljs-keyword')).toHaveText('const');
});

for (const changedText of [false, true]) {
  test(`worker highlight markup is sanitized and cannot change code text (${changedText ? 'changed text' : 'unsafe attributes'})`, async ({ page }) => {
    await page.addInitScript(changed => {
      const Worker = window.Worker;
      window.Worker = class extends Worker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            if (typeof event.data?.results?.[0] !== 'string') return;
            event.data.results[0] = changed ? '<span>different source</span>'
              : event.data.results[0].replace('<span ', '<span onmouseover="window.__unsafeHighlight=true" ') + '<img src=x onerror="window.__unsafeHighlight=true">';
          });
        }
      };
    }, changedText);
    await installFakeTauri(page);
    await openEditor(page);
    await setEditorContent(page, '```js\nconst safe = 1;\n```');
    await page.evaluate(async () => {
      const controller = window.__MDEDIT_TEST_HOOK__.controller;
      await controller.renderDocument(controller.activeDocument().id, { force: true });
    });
    expect(await page.locator('#preview code').textContent()).toBe('const safe = 1;\n');
    await expect(page.locator('#preview code [onmouseover], #preview code img')).toHaveCount(0);
    if (!changedText) await expect(page.locator('#preview code .hljs-keyword')).toHaveText('const');
    else await expect(page.locator('#preview code')).not.toHaveClass(/hljs/);
    expect(await page.evaluate(() => window.__unsafeHighlight)).toBeUndefined();
  });
}

test('highlight worker failure leaves plain code without failing preview or recovery', async ({ page }) => {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        if (message.kind === 'highlight-code') throw new Error('highlight worker unavailable');
        return super.postMessage(message, ...transfer);
      }
    };
  });
  await installFakeTauri(page, { savePath: '/out/plain-code.html' });
  await openEditor(page);
  await forbidMainHighlight(page);
  await setEditorContent(page, '# Plain fallback\n\n```js\nconst value = 1;\n```\n\n```unknown-language\nunchanged\n```');
  await expect(page.locator('#preview h1')).toHaveText('Plain fallback');
  await expect(page.locator('#preview code.language-js')).toHaveText('const value = 1;\n');
  await expect(page.locator('#preview code.language-js')).not.toHaveClass(/hljs/);
  await expect(page.locator('#preview code.language-unknown-language')).toHaveText('unchanged\n');
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.activeDocument().recoveryStatus)).toBe('clean');
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.exportActive('html'));
  expect(await page.evaluate(() => window.__testBridge.calls.writes.length)).toBe(1);
  expect(await page.evaluate(() => window.__mainHighlightCalls)).toBe(0);
});
