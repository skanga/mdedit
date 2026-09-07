const { expect } = require("@playwright/test");
const { permissions } = require("../../src-tauri/capabilities/default.json");

async function installFakeTauri(page, options = {}) {
  await page.addInitScript((configuration) => {
    const listeners = new Map();
    const calls = { invokes: [], saves: [], writes: [], closeCalls: 0, destroyCalls: 0, titleRequests: [], titles: [], nativeTitle: "" };
    const paths = configuration.openPaths || [];
    const documents = configuration.documents || {};
    const saveResults = configuration.saveResults || {};
    const pendingFiles = [...(configuration.pendingFiles || [])];
    const recentDocuments = [...(configuration.recentDocuments || [])];
    let releaseFileListener;
    const fileListenerGate = new Promise((resolve) => { releaseFileListener = resolve; });
    let closeHandler = null;
    let dropHandler = null;
    let releaseFirstTitle = null;
    const firstTitleGate = new Promise((resolve) => { releaseFirstTitle = resolve; });
    let titleWriteCount = 0;

    window.__testBridge = {
      calls,
      pendingFiles,
      recentDocuments,
      documents,
      assets: configuration.assets,
      releaseFileListener() { releaseFileListener(); },
      drop(paths) { return dropHandler?.({payload:{type:"drop",paths}}); },
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
        open: async (options) => options.filters ? paths : (configuration.attachmentPaths || []),
        save: async () => configuration.savePath || null,
      },
      fs: {
        writeFile: async (path, data) => { calls.writes.push({ path, data }); },
      },
      core: {
        invoke: async (command, args = {}) => {
          calls.invokes.push({ command, args });
          if (command === "canonicalize_document_path") return documents[args.path]?.canonicalPath || args.path;
          if (command === "probe_document") {
            const entry = documents[args.path];
            if (!entry || entry.missing) return { status: "missing" };
            const sha256 = entry.sha256 || `fingerprint:${args.path}`;
            return { status: sha256 === args.expectedSha256 ? "unchanged" : "changed", sha256 };
          }
          if (command === "read_document_asset") {
            const asset = configuration.assets?.[args.documentPath]?.[args.reference] || configuration.assets?.[args.reference];
            if (!asset) throw new Error("No fake asset: " + args.reference);
            return asset;
          }
          if (command === "import_document_asset" || command === "import_document_attachment") {
            if (configuration.importDelayMs) await new Promise(resolve => setTimeout(resolve, configuration.importDelayMs));
            return configuration.importResult || { relativePath: "assets/imported.png", mime: "image/png" };
          }
          if (command === "list_recent_documents") {
            if (configuration.recentListError) throw new Error(configuration.recentListError);
            return recentDocuments.map((entry) => ({ ...entry }));
          }
          if (command === "remember_recent_document") {
            if (configuration.recentWriteError) throw new Error(configuration.recentWriteError);
            const canonicalPath = documents[args.path]?.canonicalPath || args.path;
            const retained = recentDocuments.filter((entry) => entry.canonicalPath !== canonicalPath);
            recentDocuments.splice(0, recentDocuments.length, { path: args.path, canonicalPath }, ...retained.slice(0, 19));
            return;
          }
          if (command === "remove_recent_document") {
            const retained = recentDocuments.filter((entry) => entry.canonicalPath !== args.canonicalPath);
            recentDocuments.splice(0, recentDocuments.length, ...retained);
            return;
          }
          if (command === "clear_recent_documents") { recentDocuments.splice(0); return; }
          if (command === "load_recovery_manifest") return configuration.recoveryManifest ?? null;
          if (command === "load_recovery_document") {
            const key = `${args.documentId}:${args.snapshotRevision}`;
            return (configuration.recoveryDocuments && configuration.recoveryDocuments[key]) ?? null;
          }
          if (command === "take_pending_files") return pendingFiles.splice(0);
          if (command === "recovery_directory") return "/fake-recovery";
          if (command === "read_document") {
            const entry = documents[args.path];
            if (entry?.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
            if (entry && entry.error) throw new Error(entry.error);
            if (!entry) throw new Error(`failed to read document ${args.path}: No such file or directory (os error 2)`);
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
            documents[args.path] = {content: args.content, sha256: `saved:${args.path}`};
            return { status: "saved", sha256: `saved:${args.path}`, canonicalPath: args.path };
          }
          return null;
        },
      },
      event: {
        listen: async (name, callback) => {
          if (configuration.delayFileListener) await fileListenerGate;
          listeners.set(name, callback);
          return () => listeners.delete(name);
        },
      },
      window: {
        getCurrentWindow: () => ({
          onDragDropEvent: async (callback) => { dropHandler=callback;return ()=>{dropHandler=null;}; },
          onCloseRequested: async (callback) => {
            // Tauri's listener destroys the window after an unprevented event.
            // Counting close() alone misses the final permission boundary.
            closeHandler = async (event) => {
              const result = await callback(event);
              if (!event.prevented) {
                if (!configuration.windowPermissions.includes("core:window:allow-destroy")) {
                  throw new Error("window.destroy not allowed");
                }
                calls.destroyCalls += 1;
              }
              return result;
            };
            return () => { closeHandler = null; };
          },
          close: async () => {
            if (!configuration.windowPermissions.includes("core:window:allow-close")) {
              throw new Error("window.close not allowed");
            }
            calls.closeCalls += 1;
            const request = await window.__testBridge.requestClose();
            await request.promise;
          },
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
  }, { ...options, windowPermissions: permissions });
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

async function setEditorContent(page, content) {
  // Save tests need an exact payload, independent of deferred caret restoration
  // during tab activation and Playwright's select-all/insert sequence.
  await activeEditor(page).evaluate((editor, value) => {
    editor.value = value;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }, content);
  await expect(activeEditor(page)).toHaveValue(content);
}

module.exports = { activeEditor, installFakeTauri, openEditor, setEditorContent };
