const { test, expect } = require('@playwright/test');
const { createHash } = require('node:crypto');
const { app: { security: { csp } } } = require('../../src-tauri/tauri.conf.json');
const { activeEditor, installFakeTauri, setEditorContent } = require('./helpers');

test.use({ serviceWorkers: 'block' });

// Tauri adds hashes for bundled inline scripts when packaging. Exercise the
// same policy in Chromium, rather than weakening it to unsafe-inline in tests.
for (const build of ['/index.html', '/index-lite.html']) {
  test(`desktop CSP permits application features and blocks injected scripts (${build})`, async ({ page }) => {
    expect(typeof csp).toBe('string');
    await installFakeTauri(page, { savePath: '/out/test.png' });
    await page.route(`**${build}`, async route => {
      const response = await route.fetch();
      const body = await response.text();
      const hashes = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => `'sha256-${createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64')}'`).join(' ');
      await route.fulfill({ response, body, headers: {
        ...response.headers(),
        'content-security-policy': csp.replace("script-src 'self'", `script-src 'self' ${hashes}`),
      } });
    });
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await page.evaluate(() => { hljs.highlight = () => { throw new Error('UI highlighting forbidden under CSP'); }; });
    await setEditorContent(page, '# Safe\n\n$\\frac{a}{b}$\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nconst value = 42;\n```');
    await expect(page.locator('#preview code.language-js .hljs-keyword')).toHaveText('const');
    await expect(page.locator('#preview h1')).toHaveText('Safe');
    if (build === '/index.html') {
      await expect(page.locator('#preview .mermaid-block svg')).toBeVisible();
      await expect(page.locator('#preview .code-wrap .mermaid-block')).toHaveCount(0);
      await expect(page.locator('#preview .katex')).toHaveCount(1);
    }
    await activeEditor(page).press('Control+f');
    await page.locator('#find-regex').check();
    await page.locator('#find-input').fill('S.fe');
    await expect(page.locator('#find-count')).toHaveText('1/1');
    await page.evaluate(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.effectiveDirective));
      const script = document.createElement('script');
      script.textContent = 'window.__injectedRan = true';
      document.body.append(script);
    });
    await expect.poll(() => page.evaluate(() => window.__cspViolations)).toContain('script-src-elem');
    expect(await page.evaluate(() => window.__injectedRan)).toBeUndefined();
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.exportActive('png'));
    expect(await page.evaluate(() => window.__testBridge.calls.writes.length)).toBe(1);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await setEditorContent(page, 'CSP recovery\n' + 'x'.repeat(300 * 1024));
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    expect(await page.evaluate(async () => {
      const json = window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_document').at(-1).args.json;
      const parse = JSON.parse;
      JSON.parse = (raw, ...args) => {
        if (typeof raw === 'string' && raw.length >= 256 * 1024) throw new Error('Large validation parsed on UI thread');
        return parse(raw, ...args);
      };
      try {
        const value = await window.__MDEDIT_TEST_HOOK__.controller.snapshotSerializer.parse(json);
        return value.content.startsWith('CSP recovery\n');
      } finally { JSON.parse = parse; }
    })).toBe(true);
  });
}
