const { test, expect } = require('@playwright/test');
const { activeEditor, installFakeTauri, setEditorContent } = require('./helpers');
const large = label => label + '\n' + 'x'.repeat(300 * 1024);

async function setup(page, build = '/index.html') {
  await installFakeTauri(page);
  await page.goto(build);
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__?.restored)).toBe(true);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller, document = controller.activeDocument();
    return !controller._manifestBarrier && !document.dirty && document.persistedRevision === document.snapshotRevision;
  })).toBe(true);
  await page.evaluate(() => {
    const stringify = JSON.stringify;
    window.__mainSnapshotEncodes = 0;
    JSON.stringify = function(value, ...args) {
      if (value?.schemaVersion === 1 && typeof value.content === 'string' && value.content.length >= 256 * 1024) {
        window.__mainSnapshotEncodes++;
        throw new Error('Large snapshot encoding ran on the UI thread');
      }
      return stringify.call(this, value, ...args);
    };
  });
}

for (const build of ['/index.html', '/index-lite.html']) {
  test(`large automatic recovery encodes snapshots off the UI thread (${build})`, async ({ page }) => {
    await setup(page, build);
    await setEditorContent(page, large('automatic recovery'));
    await expect.poll(() => page.evaluate(() => window.__testBridge.calls.invokes.some(call =>
      call.command === 'write_recovery_document' && JSON.parse(call.args.json).content.startsWith('automatic recovery\n')))).toBe(true);
    expect(await page.evaluate(() => window.__mainSnapshotEncodes)).toBe(0);
    await expect(activeEditor(page)).toHaveValue(large('automatic recovery'));
  });
}

test('a held snapshot encoder cannot publish a manifest for a newer edit', async ({ page }) => {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.__holdSnapshots = true;
    window.__snapshotJobs = [];
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        if (message.kind === 'serialize-snapshot' && window.__holdSnapshots) {
          window.__snapshotJobs.push({ snapshot: message.snapshot, send: () => super.postMessage(message, ...transfer) });
        } else super.postMessage(message, ...transfer);
      }
    };
  });
  await setup(page);
  await setEditorContent(page, large('captured revision'));
  await page.evaluate(() => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    window.__capturedRevision = controller.activeDocument().snapshotRevision;
    window.__manifestCount = window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_manifest').length;
    window.__pendingManifest = controller.persistManifest();
    window.__pendingManifest.catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window.__snapshotJobs.length)).toBe(1);
  expect(await page.evaluate(() => window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_manifest').length)).toBe(await page.evaluate(() => window.__manifestCount));
  await setEditorContent(page, large('newer revision'));
  await page.evaluate(() => window.__snapshotJobs[0].send());
  await expect.poll(() => page.evaluate(() => window.__snapshotJobs.length)).toBe(2);
  const first = await page.evaluate(() => {
    const writes = window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_document');
    const snapshot = writes.map(call => JSON.parse(call.args.json)).find(snapshot => snapshot.content.startsWith('captured revision\n'));
    const manifests = window.__testBridge.calls.invokes.filter(call => call.command === 'write_recovery_manifest').map(call => JSON.parse(call.args.json));
    return { snapshotRevision: snapshot?.snapshotRevision, expected: window.__capturedRevision,
      newestPublished: manifests.at(-1).tabs.find(tab => tab.documentId === snapshot.documentId).snapshotRevision };
  });
  expect(first.snapshotRevision).toBe(first.expected);
  expect(first.newestPublished).toBe(first.expected);
  await page.evaluate(() => { window.__holdSnapshots = false; window.__snapshotJobs[1].send(); });
  await page.evaluate(() => window.__pendingManifest);
  await expect.poll(() => page.evaluate(() => {
    const document = window.__MDEDIT_TEST_HOOK__.controller.activeDocument();
    return document.persistedRevision === document.snapshotRevision;
  })).toBe(true);
  expect(await page.evaluate(() => window.__mainSnapshotEncodes)).toBe(0);
});

test('snapshot worker failure blocks recovery until an explicit retry', async ({ page }) => {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.__failSnapshots = true;
    window.Worker = class extends Worker {
      postMessage(message, ...transfer) {
        if (message.kind === 'serialize-snapshot' && window.__failSnapshots) {
          this.dispatchEvent(new ErrorEvent('error', { message: 'injected encoding failure', cancelable: true }));
        } else super.postMessage(message, ...transfer);
      }
    };
  });
  await setup(page);
  await setEditorContent(page, large('retry source'));
  const error = await page.evaluate(async () => {
    try { await window.__MDEDIT_TEST_HOOK__.controller.persistManifest(); }
    catch (error) { return error.message; }
  });
  expect(error).toContain('worker');
  expect(await page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller.activeDocument().recoveryStatus)).toBe('failed');
  await expect(activeEditor(page)).toHaveValue(large('retry source'));
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeFocused();
  expect(await page.evaluate(() => Boolean(window.__MDEDIT_TEST_HOOK__.controller._sessionRecoveryFailure))).toBe(true);
  await page.evaluate(() => { window.__failSnapshots = false; });
  await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.controller._sessionRecoveryFailure)).toBeNull();
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).not.toBeVisible();
  await expect(activeEditor(page)).toBeFocused();
  expect(await page.evaluate(() => window.__mainSnapshotEncodes)).toBe(0);
});
