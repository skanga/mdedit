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
    window.__recoverySnapshotWrites = [];
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
          if (command === "write_recovery_document") {
            const started = performance.now();
            await Promise.resolve();
            window.__recoverySnapshotWrites.push({
              documentId: args.documentId,
              revision: args.revision,
              bytes: new Blob([args.json]).size,
              durationMs: performance.now() - started,
            });
            return null;
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
  // Exercise a real workspace-only recovery checkpoint without changing any
  // document content or allowing a hidden 5 MiB preview render to begin.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-view", "edit");
  await expect.poll(
    () => page.evaluate(() => window.__recoverySnapshotWrites.length),
    { timeout: 10_000 },
  ).toBeGreaterThan(0);
  await page.evaluate(() => new Promise((resolve) => {
    const active = document.querySelector(".editor-surface:not(.is-inactive) > textarea");
    active.setSelectionRange(1, 1);
    document.querySelectorAll('[role="tab"]')[1].click();
    requestAnimationFrame(resolve);
  }));
  const metrics = await page.evaluate(async () => {
    const longTasks = [];
    const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
    const longTaskObserver = longTaskSupported ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, durationMs: entry.duration });
      }
    }) : null;
    if (longTaskObserver) longTaskObserver.observe({ type: "longtask", buffered: false });
    const selectionStartedAt = performance.now();

    const select = (tab) => new Promise((resolve, reject) => {
      const id = tab.dataset.documentId;
      tab.click();
      requestAnimationFrame(() => {
        // Chromium renders after animation-frame callbacks and before timer
        // tasks. Validate and timestamp in that following task so the sample
        // includes the first painted editor but excludes deferred preview work.
        setTimeout(() => {
          const editor = document.querySelector(`textarea[data-document-id="${CSS.escape(id)}"]`);
          const surface = editor && editor.parentElement;
          const style = surface && getComputedStyle(surface);
          const bounds = editor && editor.getBoundingClientRect();
          const visible = Boolean(editor && surface && !surface.classList.contains("is-inactive")
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
            && bounds.width > 0 && bounds.height > 0);
          if (!visible) {
            reject(new Error(`selected textarea ${id} was not visible in the painted frame`));
            return;
          }
          if (editor.textLength !== 5 * 1024 * 1024) {
            reject(new Error(`selected textarea ${id} did not contain the full document`));
            return;
          }
          resolve({
            at: performance.now(),
            usedJSHeapSize: performance.memory && performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory && performance.memory.totalJSHeapSize,
          });
        }, 0);
      });
    });
    const values = [];
    const sampleDetails = [];
    let peakUsedJSHeapSize = performance.memory && performance.memory.usedJSHeapSize;
    let peakTotalJSHeapSize = performance.memory && performance.memory.totalJSHeapSize;
    for (let index = 0; index < 200; index += 1) {
      const liveTabs = document.querySelectorAll('[role="tab"]');
      const target = liveTabs[index % liveTabs.length];
      const started = performance.now();
      const result = await select(target);
      const duration = result.at - started;
      values.push(duration);
      sampleDetails.push({ index, documentId: target.dataset.documentId, durationMs: duration });
      if (Number.isFinite(result.usedJSHeapSize)) {
        peakUsedJSHeapSize = Math.max(peakUsedJSHeapSize || 0, result.usedJSHeapSize);
      }
      if (Number.isFinite(result.totalJSHeapSize)) {
        peakTotalJSHeapSize = Math.max(peakTotalJSHeapSize || 0, result.totalJSHeapSize);
      }
    }
    const selectionCompletedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (longTaskObserver) longTaskObserver.disconnect();
    values.sort((a, b) => a - b);
    const percentile = (fraction) => values[Math.ceil(values.length * fraction) - 1];
    const outliers = values.filter((value) => value > 100);
    const selectionLongTasks = longTasks.filter((entry) => entry.startTime >= selectionStartedAt
      && entry.startTime <= selectionCompletedAt);
    const snapshotWrites = window.__recoverySnapshotWrites.slice();
    return {
      samples: values.length,
      p50: percentile(0.50),
      p95: percentile(0.95),
      max: values[values.length - 1],
      over100ms: outliers.length,
      outlierSamples: sampleDetails.filter((sample) => sample.durationMs > 100),
      memory: {
        metric: "performance.memory JS heap (renderer process only)",
        peakObservedUsedBytes: peakUsedJSHeapSize,
        peakObservedTotalBytes: peakTotalJSHeapSize,
        jsHeapSizeLimitBytes: performance.memory && performance.memory.jsHeapSizeLimit,
      },
      recoverySnapshotWrites: {
        metric: "fake Tauri write_recovery_document invoke duration",
        count: snapshotWrites.length,
        totalDurationMs: snapshotWrites.reduce((sum, write) => sum + write.durationMs, 0),
        maxDurationMs: Math.max(...snapshotWrites.map((write) => write.durationMs)),
        writes: snapshotWrites,
      },
      longTasks: {
        metric: "PerformanceObserver longtask entries during editor selection",
        supported: longTaskSupported,
        count: selectionLongTasks.length,
        totalDurationMs: selectionLongTasks.reduce((sum, entry) => sum + entry.durationMs, 0),
        maxDurationMs: selectionLongTasks.length
          ? Math.max(...selectionLongTasks.map((entry) => entry.durationMs)) : 0,
        entries: selectionLongTasks,
      },
      selectionWindowMs: selectionCompletedAt - selectionStartedAt,
    };
  });
  console.log("Selection phase metrics:", JSON.stringify(metrics));
  metrics.preview = await page.evaluate(async () => {
    const preview = document.querySelector("#preview");
    const expectedLength = 5 * 1024 * 1024;
    const started = performance.now();
    const completion = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve({ at: performance.now(), timedOut: true });
      }, 15_000);
      const observer = new MutationObserver(() => {
        if (preview.textContent.length < expectedLength) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve({ at: performance.now(), timedOut: false });
      });
      observer.observe(preview, { childList: true, subtree: true, characterData: true });
      document.querySelector('.seg button[data-mode="preview"]').click();
      if (preview.textContent.length >= expectedLength) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve({ at: performance.now(), timedOut: false });
      }
    });
    return {
      metric: "separate Preview-mode command to full preview DOM completion",
      completionMs: completion.at - started,
      timedOut: completion.timedOut,
      textLength: preview.textContent.length,
    };
  });
  const finalCdp = await page.context().newCDPSession(page);
  await finalCdp.send("Performance.enable");
  const cdpMetrics = await finalCdp.send("Performance.getMetrics");
  await finalCdp.detach();
  metrics.cdpFinal = {
    metric: "Chromium Performance domain final renderer-process values (not peak)",
    values: Object.fromEntries(cdpMetrics.metrics
      .filter(({ name }) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "LayoutCount"].includes(name))
      .map(({ name, value }) => [name, value])),
  };
  console.log("Tab activation metrics:", JSON.stringify(metrics));
  await testInfo.attach("tab-activation-metrics", {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: "application/json",
  });
  expect(metrics.samples).toBe(200);
  expect(metrics.recoverySnapshotWrites.count).toBeGreaterThan(0);
  expect(metrics.memory.peakObservedUsedBytes).toBeGreaterThan(0);
  expect(metrics.longTasks.supported).toBe(true);
  expect(metrics.preview.completionMs).toBeGreaterThan(0);
  expect(metrics.preview.timedOut).toBe(false);
  expect(metrics.preview.textLength).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  expect(metrics.p95).toBeLessThanOrEqual(100);
});
