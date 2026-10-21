const { test, expect } = require('@playwright/test');
const { installFakeTauri, openEditor } = require('./helpers');

for (const build of ['/', '/index-lite.html']) {
  test(`desktop HTML and web links open externally without navigating the editor (${build})`, async ({ page }) => {
    const references = ['../site/a%20b.html?x=1#intro', '/site/absolute.htm', 'C:/site/page.html',
      'file:///site/page.html', 'https://example.com/docs?q=1#intro', '//example.com/page'];
    const content = references.map((href, i) => `[Link ${i}](${href})`).join('\n\n');
    await installFakeTauri(page, { openPaths: ['/notes/main.md'], documents: { '/notes/main.md': { content } } });
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const initialURL = page.url();
    const tabCount = await page.getByRole('tab').count();
    for (let i = 0; i < references.length; i++) {
      const link = page.locator('#preview a', { hasText: `Link ${i}` });
      await expect(link).toHaveAttribute('href', references[i].replace(/^C:/, 'C%3A'));
      await link.click({ button: i === 1 ? 'middle' : 'left' });
      await expect.poll(() => page.evaluate(() => window.__testBridge.calls.invokes.filter(c => c.command === 'open_browser_link').length)).toBe(i + 1);
    }
    expect(await page.evaluate(() => window.__testBridge.calls.invokes.filter(c => c.command === 'open_browser_link').map(c => c.args)))
      .toEqual(references.map(reference => ({ documentPath: '/notes/main.md', reference: reference.replace(/^C:/, 'C%3A') })));
    expect(page.url()).toBe(initialURL);
    await expect(page.getByRole('tab')).toHaveCount(tabCount);
    expect(page.context().pages()).toHaveLength(1);
    expect(await page.evaluate(() => window.__testBridge.calls.invokes.some(c => c.command === 'read_document_asset'))).toBe(false);
  });
}

test('cached HTML previews rebind links after switching tabs', async ({ page }) => {
  await installFakeTauri(page, { openPaths: ['/notes/a.md', '/notes/b.md'], documents: {
    '/notes/a.md': { content: '[Site](site.html)' }, '/notes/b.md': { content: '# Other' },
  } });
  await openEditor(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('tab', { name: /a.md/ }).click();
  await expect(page.locator('#preview a')).toHaveText('Site');
  await page.getByRole('tab', { name: /b.md/ }).click();
  await page.getByRole('tab', { name: /a.md/ }).click();
  await page.locator('#preview a').click();
  await expect.poll(() => page.evaluate(() => window.__testBridge.calls.invokes.filter(c => c.command === 'open_browser_link').map(c => c.args)))
    .toEqual([{ documentPath: '/notes/a.md', reference: 'site.html' }]);
});

test('browser-only web links keep standard new-tab behavior', async ({ page }) => {
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Site</h1>' }));
  await page.goto('/');
  const { setEditorContent } = require('./helpers');
  await setEditorContent(page, '[Site](https://example.com/page.html)');
  const popup = page.waitForEvent('popup');
  await page.locator('#preview a').click();
  const tab = await popup;
  await expect(tab.locator('h1')).toHaveText('Site');
  await tab.close();
});

test('external opener errors are reported without navigating or modifying a document', async ({ page }) => {
  await installFakeTauri(page, { openPaths: ['/notes/main.md'], browserLinkError: 'HTML file does not exist',
    documents: { '/notes/main.md': { content: '[Missing](missing.html)' } } });
  await openEditor(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('#preview a').click();
  await expect(page.locator('#status')).toContainText('HTML file does not exist');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
});
