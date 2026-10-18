const { test, expect } = require('@playwright/test');
const { activeEditor, installFakeTauri, openEditor, setEditorContent } = require('./helpers');

async function setupFind(page, content) {
  await installFakeTauri(page);
  await openEditor(page);
  await setEditorContent(page, content);
  await activeEditor(page).press('Control+f');
}

for (const build of ['/', '/index-lite.html']) {
  test(`find typing and keyboard navigation preserve focus and document content (${build})`, async ({ page }) => {
    await installFakeTauri(page);
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await setEditorContent(page, 'cat dog cat');
    await activeEditor(page).press('Control+f');
    await page.locator('#find-input').pressSequentially('cat');
    await expect(page.locator('#find-input')).toHaveValue('cat');
    await expect(page.locator('#find-input')).toBeFocused();
    await expect(activeEditor(page)).toHaveValue('cat dog cat');
    await expect(page.locator('#find-count')).toHaveText('1/2');
    await page.keyboard.press('Enter');
    await expect(page.locator('#find-count')).toHaveText('2/2');
    await expect(page.locator('#find-input')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#find-count')).toHaveText('1/2');
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#find-count')).toHaveText('2/2');
    await page.keyboard.press('Escape');
    await expect(page.locator('#find-bar')).not.toBeVisible();
    await expect(activeEditor(page)).toBeFocused();
  });
}

test('replace Enter can replace consecutive matches without leaving the replacement field', async ({ page }) => {
  await setupFind(page, 'cat dog cat');
  await page.locator('#find-input').fill('cat');
  await page.locator('#replace-input').fill('fox');
  await page.locator('#replace-input').press('Enter');
  await expect(activeEditor(page)).toHaveValue('fox dog cat');
  await expect(page.locator('#replace-input')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(activeEditor(page)).toHaveValue('fox dog fox');
  await expect(page.locator('#find-count')).toHaveText('0/0');
});

test('find options, invalid regex, capture replacement, replace all and undo', async ({ page }) => {
  await setupFind(page, 'Cat cat scatter cat12');
  await page.locator('#find-input').fill('cat');
  await expect(page.locator('#find-count')).toHaveText('1/4');
  await page.locator('#find-case').check();
  await expect(page.locator('#find-count')).toHaveText('1/3');
  await page.locator('#find-word').check();
  await expect(page.locator('#find-count')).toHaveText('1/1');
  await page.locator('#find-word').uncheck();
  await page.locator('#find-regex').check();
  await page.locator('#find-input').fill('[');
  await expect(page.locator('#find-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#find-all')).toBeDisabled();
  await expect(page.locator('#find-replace')).toBeDisabled();
  await page.locator('#find-input').fill('(cat)(\\d+)');
  await page.locator('#replace-input').fill('$2-$1');
  await page.locator('#find-all').click();
  await expect(activeEditor(page)).toHaveValue('Cat cat scatter 12-cat');
  await activeEditor(page).press('Control+z');
  await expect(activeEditor(page)).toHaveValue('Cat cat scatter cat12');
});
