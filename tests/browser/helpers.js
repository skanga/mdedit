const { expect } = require("@playwright/test");

async function installFakeTauri(page, options = {}) {
  await page.addInitScript((configuration) => {
    const listeners = new Map();
    const calls = { invokes: [], saves: [], writes: [], closeCalls: 0, titleRequests: [], titles: [], nativeTitle: "" };
    const paths = configuration.openPaths || [];
    const documents = configuration.documents || {};
    const saveResults = configuration.saveResults || {};
    let closeHandler = null;
    let releaseFirstTitle = null;
    const firstTitleGate = new Promise((resolve) => { releaseFirstTitle = resolve; });
    let titleWriteCount = 0;

    window.__testBridge = {
      calls,
      async requestClose() {
        if (!closeHandler) throw new Error("close handler is not installed");
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        const promise = closeHandler(event);
        return { event, promise };
      },
      emit(name, payload) {
        const callback = listeners.get(name);
        return callback ? callback({ payload }) : undefined;
      },
      releaseFirstTitle() { releaseFirstTitle(); },
    };
    window.__MDEDIT_TEST_HOOK__ = { restored: false };

    window.__TAURI__ = {
      dialog: {
        open: async () => paths,
        save: async () => configuration.savePath || null,
      },
      fs: {
        writeFile: async (path, data) => { calls.writes.push({ path, data }); },
      },
      core: {
        invoke: async (command, args = {}) => {
          calls.invokes.push({ command, args });
          if (command === "load_recovery_manifest") return configuration.recoveryManifest ?? null;
          if (command === "load_recovery_document") {
            const key = `${args.documentId}:${args.snapshotRevision}`;
            return (configuration.recoveryDocuments && configuration.recoveryDocuments[key]) ?? null;
          }
          if (command === "take_pending_files") return [];
          if (command === "recovery_directory") return "/fake-recovery";
          if (command === "read_document") {
            const entry = documents[args.path];
            if (entry && entry.error) throw new Error(entry.error);
            if (!entry) throw new Error(`No fake document for ${args.path}`);
            return {
              path: args.path,
              canonicalPath: entry.canonicalPath || args.path,
              content: entry.content || "",
              sha256: entry.sha256 || `fingerprint:${args.path}`,
            };
          }
          if (command === "save_document") {
            calls.saves.push({ ...args });
            const configured = saveResults[args.path];
            if (configured && configured.error) throw new Error(configured.error);
            if (Array.isArray(configured)) {
              const next = configured.shift();
              if (next && next.error) throw new Error(next.error);
              if (next) return next;
            } else if (configured) return configured;
            return { status: "saved", sha256: `saved:${args.path}`, canonicalPath: args.path };
          }
          return null;
        },
      },
      event: {
        listen: async (name, callback) => {
          listeners.set(name, callback);
          return () => listeners.delete(name);
        },
      },
      window: {
        getCurrentWindow: () => ({
          onCloseRequested: async (callback) => { closeHandler = callback; return () => { closeHandler = null; }; },
          close: async () => { calls.closeCalls += 1; },
          setTitle: async (title) => {
            calls.titleRequests.push(title);
            titleWriteCount += 1;
            if (configuration.delayFirstTitle && titleWriteCount === 1) await firstTitleGate;
            calls.titles.push(title);
            calls.nativeTitle = title;
          },
        }),
      },
    };
  }, options);
}

async function openEditor(page) {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => Boolean(window.__MDEDIT_TEST_HOOK__ && window.__MDEDIT_TEST_HOOK__.restored))).toBe(true);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".editor-surface:not([hidden]):not(.is-inactive) > textarea.document-editor")).toHaveCount(1);
}

function activeEditor(page) {
  return page.locator(".editor-surface:not([hidden]):not(.is-inactive) > textarea.document-editor");
}

module.exports = { activeEditor, installFakeTauri, openEditor };
