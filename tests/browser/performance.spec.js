const { test, expect } = require("@playwright/test");

test.use({ trace: "off" });

test("50 recovered 5 MiB documents activate within the p95 budget", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.__MDEDIT_TEST_HOOK__ = { restored: false };
    const count = 50;
    const bytes = 5 * 1024 * 1024;
    const content = "x".repeat(bytes);
    const ids = Array.from({ length: count }, (_, index) => `large-${index + 1}`);
    window.__loadedRecoverySnapshots = 0;
    const manifest = {
      schemaVersion: 1,
      generation: 1,
      activeDocumentId: ids[0],
      nextUntitledNumber: 1,
      tabs: ids.map((documentId, index) => ({
        documentId,
        displayName: `large-${index + 1}.md`,
        snapshotRevision: index + 1,
      })),
    };
    window.__TAURI__ = {
      dialog: { open: async () => null, save: async () => null },
      fs: { readTextFile: async () => "", writeTextFile: async () => {}, writeFile: async () => {} },
      core: {
        invoke: async (command, args = {}) => {
          if (command === "load_recovery_manifest") return JSON.stringify(manifest);
          if (command === "load_recovery_document") {
            window.__loadedRecoverySnapshots += 1;
            return JSON.stringify({
              schemaVersion: 1,
              documentId: args.documentId,
              snapshotRevision: args.snapshotRevision,
              editRevision: args.snapshotRevision,
              displayName: `${args.documentId}.md`,
              path: null,
              canonicalPath: null,
              content,
              savedContentSha256: "dba67a476fa78973aabb087f214a1010f3bebca053674e0af50dfe5a582112be",
              expectedDiskSha256: null,
              fileStatus: "normal",
              workspace: {
                selectionStart: 0,
                selectionEnd: 0,
                editorScrollTop: 0,
                previewScrollTop: 0,
                viewMode: "edit",
                tocOpen: false,
                find: { open: false, query: "", replacement: "", matchIndex: -1 },
              },
            });
          }
          if (command === "take_pending_files") return [];
          if (command === "recovery_directory") return "/fake-recovery";
          return null;
        },
      },
      event: { listen: async () => () => {} },
      window: { getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, close: async () => {} }) },
    };
  });

  await page.goto("/");
  await expect(page.getByRole("tab")).toHaveCount(50, { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.restored), {
    timeout: 100_000,
  }).toBe(true);
  await expect.poll(
    () => page.evaluate(() => window.__loadedRecoverySnapshots),
    { timeout: 180_000 },
  ).toBe(50);
  await page.evaluate(() => new Promise((resolve) => {
    document.querySelectorAll('[role="tab"]')[1].click();
    requestAnimationFrame(resolve);
  }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.detach();
  const metrics = await page.evaluate(async () => {
    const select = (tab) => new Promise((resolve) => {
      const id = tab.dataset.documentId;
      tab.click();
      requestAnimationFrame(() => {
        const at = performance.now();
        const editor = document.querySelector(`textarea[data-document-id="${CSS.escape(id)}"]`);
        resolve({
          visible: Boolean(editor && !editor.parentElement.classList.contains("is-inactive")),
          contentLength: editor ? editor.textLength : -1,
          at,
        });
      });
    });
    const values = [];
    for (let index = 0; index < 200; index += 1) {
      const liveTabs = document.querySelectorAll('[role="tab"]');
      const target = liveTabs[index % liveTabs.length];
      const started = performance.now();
      const result = await select(target);
      if (!result.visible) throw new Error(`selected textarea ${index % liveTabs.length} was not visible`);
      if (result.contentLength !== 5 * 1024 * 1024) {
        throw new Error(`selected textarea ${index % liveTabs.length} did not contain the full document`);
      }
      const duration = result.at - started;
      values.push(duration);
    }
    values.sort((a, b) => a - b);
    const percentile = (fraction) => values[Math.ceil(values.length * fraction) - 1];
    return {
      samples: values.length,
      p50: percentile(0.50),
      p95: percentile(0.95),
      max: values[values.length - 1],
      usedJSHeapSize: performance.memory && performance.memory.usedJSHeapSize,
    };
  });
  console.log("Tab activation metrics:", JSON.stringify(metrics));
  await testInfo.attach("tab-activation-metrics", {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: "application/json",
  });
  expect(metrics.samples).toBe(200);
  expect(metrics.p95).toBeLessThanOrEqual(100);
});
