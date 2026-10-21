const { test, expect } = require('@playwright/test');
const { activeEditor, setEditorContent } = require('./helpers');
const large = label => label + '\n' + 'x'.repeat(300 * 1024);

async function installWriteGuards(page) {
  await page.addInitScript(() => {
    const parse = JSON.parse, Worker = window.Worker;
    window.__largeMainParses = 0;
    window.__parseJobs = [];
    window.__heldParses = [];
    JSON.parse = function(raw, ...args) {
      if (typeof raw === 'string' && raw.length >= 256 * 1024) {
        window.__largeMainParses++;
        throw new Error('Large recovery write parsed on the UI thread');
      }
      return parse.call(this, raw, ...args);
    };
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        if (message.kind === 'parse-snapshot') {
          window.__parseJobs.push(message.json.length);
          if (window.__holdParsing) {
            window.__heldParses.push(() => super.postMessage(message, ...transfer));
            return;
          }
          if (window.__failParsingFor && message.json.includes(window.__failParsingFor)) {
            this.dispatchEvent(new ErrorEvent('error', { message: 'validation worker failed', cancelable: true }));
            return;
          }
        }
        super.postMessage(message, ...transfer);
      }
    };
  });
}
async function start(page, build = '/index.html') {
  await page.addInitScript(() => { window.__MDEDIT_TEST_HOOK__ = { restored: false }; });
  await page.goto(build);
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  await expect.poll(() => page.evaluate(() => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller, document = controller.activeDocument();
    return !controller._manifestBarrier && document.persistedRevision === document.snapshotRevision;
  })).toBe(true);
}
async function slots(page) {
  return page.evaluate(() => {
    const id = window.__MDEDIT_TEST_HOOK__.controller.activeDocument().id;
    const prefix = `mdedit-recovery-v1:document:${encodeURIComponent(id)}:`;
    return { current: localStorage.getItem(prefix + 'current'), previous: localStorage.getItem(prefix + 'previous'),
      manifest: localStorage.getItem('mdedit-recovery-v1:manifest:current'), temp: localStorage.getItem(prefix + 'temp') };
  });
}

for (const build of ['/index.html', '/index-lite.html']) {
  test(`browser snapshot rotation parses large incoming and current copies in the worker (${build})`, async ({ page }) => {
    await installWriteGuards(page);
    await start(page, build);
    await setEditorContent(page, large('first durable'));
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    await setEditorContent(page, large('second durable'));
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    const stored = await slots(page);
    expect(JSON.parse(stored.current).content).toBe(large('second durable'));
    expect(JSON.parse(stored.previous).content).toBe(large('first durable'));
    expect(stored.temp).toBeNull();
    expect(await page.evaluate(() => window.__largeMainParses)).toBe(0);
    expect(await page.evaluate(() => window.__parseJobs.length)).toBeGreaterThanOrEqual(3);
  });
}

for (const build of ['/index.html', '/index-lite.html']) {
  test(`repeated failed publication and reload retain the committed browser draft (${build})`, async ({ page }) => {
    await start(page, build);
    page.on('dialog', dialog => dialog.accept());
    const committed = large('committed before crashes');
    await setEditorContent(page, committed);
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    async function failPublicationAndReload(label, expected, corruptManifest = false) {
      await page.evaluate(() => {
        window.__MDEDIT_TEST_HOOK__.controller.io.writeRecoveryManifest = async () => { throw new Error('injected publish failure'); };
      });
      await setEditorContent(page, large(label));
      const failure = await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest().then(
        () => null, error => error.message));
      expect(failure).toContain('injected publish failure');
      await expect(activeEditor(page)).toHaveValue(large(label));
      if (corruptManifest) await page.evaluate(() => localStorage.setItem('mdedit-recovery-v1:manifest:current', 'broken manifest'));
      await page.reload();
      await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
      await expect(activeEditor(page)).toHaveValue(expected);
      await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    }
    await failPublicationAndReload('first unpublished edit', committed);
    await failPublicationAndReload('second unpublished edit', committed);
    const next = large('next committed draft');
    await setEditorContent(page, next);
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
    await failPublicationAndReload('third unpublished edit', next, true);
    const stored = await slots(page);
    expect(stored.temp).toBeNull();
  });
}

test('closing a tab keeps manifest fallback coherent after its snapshots are deleted', async ({ page }) => {
  await start(page);
  page.on('dialog', dialog => dialog.accept());
  await setEditorContent(page, large('discarded tab draft'));
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  const removedId = await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.activeDocument().id);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await setEditorContent(page, 'remaining draft');
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  await page.getByRole('button', { name: 'Close Untitled 1', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    return !controller._documentOperation && !controller._manifestBarrier && controller._queuedOperationCount === 0;
  })).toBe(true);
  expect(await page.evaluate(id => Object.keys(localStorage).some(key => key.startsWith(
    `mdedit-recovery-v1:document:${encodeURIComponent(id)}:`)), removedId)).toBe(false);
  await page.evaluate(() => localStorage.setItem('mdedit-recovery-v1:manifest:current', 'broken manifest'));
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(activeEditor(page)).toHaveValue('remaining draft');
});

test('worker validation preserves a large pinned previous draft through failed publishes and retry', async ({ page }) => {
  await installWriteGuards(page);
  await start(page);
  await setEditorContent(page, large('pinned committed draft'));
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  await page.evaluate(() => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    window.__publishManifest = controller.io.writeRecoveryManifest.bind(controller.io);
    controller.io.writeRecoveryManifest = async () => { throw new Error('injected publish failure'); };
  });
  await setEditorContent(page, large('first orphan'));
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest().then(
    () => null, error => error.message))).toContain('injected publish failure');
  await setEditorContent(page, large('second orphan'));
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.retryRecovery().then(
    () => null, error => error.message))).toContain('injected publish failure');
  const before = await slots(page);
  expect(JSON.parse(before.previous).content).toBe(large('pinned committed draft'));
  await page.evaluate(() => { window.__failParsingFor = 'pinned committed draft'; });
  await setEditorContent(page, large('latest editable draft'));
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.retryRecovery().then(
    () => null, error => error.message))).toContain('worker');
  expect(await slots(page)).toEqual(before);
  await page.evaluate(() => {
    window.__failParsingFor = '';
    window.__MDEDIT_TEST_HOOK__.controller.io.writeRecoveryManifest = window.__publishManifest;
  });
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller._sessionRecoveryFailure)).toBeNull();
  expect(JSON.parse((await slots(page)).current).content).toBe(large('latest editable draft'));
  expect(await page.evaluate(() => window.__largeMainParses)).toBe(0);
});

test('held browser validation cannot install a snapshot or publish an advanced manifest', async ({ page }) => {
  await installWriteGuards(page);
  await start(page);
  const before = await slots(page);
  await page.evaluate(() => { window.__holdParsing = true; });
  await setEditorContent(page, large('captured write'));
  await page.evaluate(() => {
    window.__pendingWrite = window.__MDEDIT_TEST_HOOK__.controller.persistManifest();
    window.__pendingWrite.catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window.__heldParses.length)).toBe(1);
  expect(await slots(page)).toEqual(before);
  await setEditorContent(page, large('newer edit'));
  await page.evaluate(() => {
    window.__holdParsing = false;
    window.__heldParses.splice(0).forEach(send => send());
  });
  await page.evaluate(async () => {
    await window.__pendingWrite;
    await window.__MDEDIT_TEST_HOOK__.controller.persistManifest();
  });
  const stored = await slots(page);
  expect(JSON.parse(stored.current).content).toBe(large('newer edit'));
  await expect(activeEditor(page)).toHaveValue(large('newer edit'));
  expect(await page.evaluate(() => window.__largeMainParses)).toBe(0);
});

test('failure validating the current browser copy preserves it until explicit retry succeeds', async ({ page }) => {
  await installWriteGuards(page);
  await start(page);
  await setEditorContent(page, large('first durable'));
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  const before = await slots(page);
  await page.evaluate(() => { window.__failParsingFor = 'first durable'; });
  await setEditorContent(page, large('second durable'));
  const failure = await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest().then(
    () => null, error => error.message));
  expect(failure).toContain('worker');
  expect(await slots(page)).toEqual(before);
  await expect(activeEditor(page)).toHaveValue(large('second durable'));
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible();
  await page.evaluate(() => { window.__failParsingFor = ''; });
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller._sessionRecoveryFailure)).toBeNull();
  const stored = await slots(page);
  expect(JSON.parse(stored.current).content).toBe(large('second durable'));
  expect(JSON.parse(stored.previous).content).toBe(large('first durable'));
  expect(await page.evaluate(() => window.__largeMainParses)).toBe(0);
});

test('invalid large current JSON preserves the previous copy without poisoning the worker', async ({ page }) => {
  await installWriteGuards(page);
  await start(page);
  for (const label of ['first durable', 'second durable']) {
    await setEditorContent(page, large(label));
    await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  }
  await page.evaluate(() => {
    const id = window.__MDEDIT_TEST_HOOK__.controller.activeDocument().id;
    localStorage.setItem(`mdedit-recovery-v1:document:${encodeURIComponent(id)}:current`, '{' + 'x'.repeat(300 * 1024));
  });
  await setEditorContent(page, large('third durable'));
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  const stored = await slots(page);
  expect(JSON.parse(stored.current).content).toBe(large('third durable'));
  expect(JSON.parse(stored.previous).content).toBe(large('first durable'));
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller._sessionRecoveryFailure)).toBeNull();
  expect(await page.evaluate(() => window.__largeMainParses)).toBe(0);
});

test('existing large browser recovery remains readable when workers become unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('phase5-disable-workers')) {
      window.Worker = class { constructor() { throw new Error('worker unavailable'); } };
    }
  });
  await start(page);
  await setEditorContent(page, large('restore without a worker'));
  await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.persistManifest());
  await page.evaluate(() => localStorage.setItem('phase5-disable-workers', '1'));
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
  await expect(activeEditor(page)).toHaveValue(large('restore without a worker'));
});
