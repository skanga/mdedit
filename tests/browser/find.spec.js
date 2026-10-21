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

for (const regex of [false, true]) {
  test(`Replace advances past its own output (regex=${regex})`, async ({ page }) => {
    await setupFind(page, 'cat cat');
    if (regex) await page.locator('#find-regex').check();
    await page.locator('#find-input').fill(regex ? '(cat)' : 'cat');
    await page.locator('#replace-input').fill(regex ? '$1fish' : 'catfish');
    await page.locator('#replace-input').press('Enter');
    await page.keyboard.press('Enter');
    await expect(activeEditor(page)).toHaveValue('catfish catfish');
  });
}

test('rapid regex replacement requests are serialized rather than dropping an Enter', async ({ page }) => {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        setTimeout(() => super.postMessage(message, ...transfer), 100);
      }
    };
  });
  await setupFind(page, 'cat cat');
  await page.locator('#find-regex').check();
  await page.locator('#find-input').fill('(cat)');
  await page.locator('#replace-input').fill('$1fish');
  await page.locator('#replace-input').evaluate(input => {
    input.focus();
    for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await expect(activeEditor(page)).toHaveValue('catfish catfish');
  await expect(page.locator('#replace-input')).toBeFocused();
});

test('changing the query cancels queued replacement requests', async ({ page }) => {
  await setupFind(page, 'cat cat');
  await page.locator('#find-input').fill('cat');
  await page.locator('#replace-input').fill('fox');
  await page.locator('#replace-input').evaluate(input => {
    for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const find = document.querySelector('#find-input');
    find.value = 'dog';
    find.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#find-count')).toHaveText('0/0');
  await expect(activeEditor(page)).toHaveValue('cat cat');
});

test('switching documents cancels queued replacement requests', async ({ page }) => {
  await setupFind(page, 'cat cat');
  await page.locator('#find-input').fill('cat');
  await page.locator('#replace-input').fill('fox');
  await page.locator('#replace-input').evaluate(input => {
    for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    window.__MDEDIT_TEST_HOOK__.controller.createUntitled();
  });
  await expect(activeEditor(page)).toHaveValue('');
  await page.getByRole('tab').first().click();
  await expect(activeEditor(page)).toHaveValue('cat cat');
});

for (const build of ['/', '/index-lite.html']) {
  test(`pathological regex times out without blocking typing (${build})`, async ({ page }) => {
    await installFakeTauri(page);
    await page.goto(build);
    await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
    await setEditorContent(page, 'a'.repeat(30) + '!');
    await activeEditor(page).press('Control+f');
    await page.locator('#find-regex').check();
    // Dispatch without waiting for a pathological main-thread regex to return.
    await page.evaluate(() => setTimeout(() => {
      const input = document.querySelector('#find-input');
      input.value = '(a+)+$';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0));
    await expect(page.locator('#find-error')).toContainText('timed out', { timeout: 3000 });
    await expect(page.locator('#find-all')).toBeDisabled();
    await page.locator('#find-input').fill('a+');
    await expect(page.locator('#find-count')).toHaveText('1/1');
    await expect(page.locator('#find-error')).toBeEmpty();
    await expect(activeEditor(page)).toHaveValue('a'.repeat(30) + '!');
  });
}

for (const regex of [false, true]) {
  test(`excessive match counts fail safely without partial replacement (regex=${regex})`, async ({ page }) => {
    const content = 'x'.repeat(10001);
    await setupFind(page, content);
    if (regex) await page.locator('#find-regex').check();
    await page.locator('#find-input').fill('x');
    await expect(page.locator('#find-error')).toContainText('Too many matches');
    await expect(page.locator('#find-all')).toBeDisabled();
    await expect(page.locator('#find-replace')).toBeDisabled();
    await expect(activeEditor(page)).toHaveValue(content);
  });
}

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
