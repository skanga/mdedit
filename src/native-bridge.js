/* Native file access bridge for the desktop (Tauri) shell.
 *
 * In a plain browser this defines window.nativeApp = null and everything else
 * in the app runs exactly as before. Inside the Tauri shell,
 * app.withGlobalTauri exposes window.__TAURI__ with the dialog and fs plugin
 * APIs, and this file wraps them in the tiny surface the app needs:
 *
 *   nativeApp.pickFile()                            -> path string, null on cancel
 *   nativeApp.pickFiles()                           -> path strings, [] on cancel
 *   nativeApp.readDocument(path)                    -> session-backed document text
 *   nativeApp.takePendingFiles()                    -> queued startup paths
 *   nativeApp.chooseSavePath({ defaultDir, suggestedName })
 *                                                -> chosen path, null on cancel
 *   nativeApp.writeFile(path, data)                 -> write raw export bytes
 *
 * defaultDir (optional) anchors the save dialog next to the document being
 * edited; without it the OS picks its own default location.
 *
 * Document text and recovery data route through native commands. The filesystem
 * plugin is used only for raw byte exports. Tauri's save dialog adds its selected
 * destination to the filesystem scope; the capability defines no static paths.
 */
const markdownFilters = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }];

function normalizePaths(selection) {
  if (Array.isArray(selection)) return selection;
  if (typeof selection === "string") return [selection];
  return [];
}

function defaultSavePath(defaultDir = "", suggestedName) {
  return (defaultDir ? defaultDir.replace(/[/\\]$/, "") + "/" : "") + (suggestedName || "untitled.md");
}

function normalizeRawBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("raw byte data must be an ArrayBuffer or typed-array view");
}

function makeNativeApp(tauri) {
  if (!tauri || !tauri.dialog || !tauri.fs || typeof tauri.fs.writeFile !== "function"
    || !tauri.core || typeof tauri.core.invoke !== "function") return null;
  return {
    async pickFile() {
      const p = await tauri.dialog.open({
        multiple: false,
        directory: false,
        filters: markdownFilters,
      });
      return p || null;
    },
    async pickFiles() {
      const p = await tauri.dialog.open({
        multiple: true,
        directory: false,
        filters: markdownFilters,
      });
      return normalizePaths(p);
    },
    async readDocument(path) {
      return tauri.core.invoke("read_document", { path });
    },
    async saveDocument(input) {
      return tauri.core.invoke("save_document", input);
    },
    async canonicalizeDocumentPath(path) {
      return tauri.core.invoke("canonicalize_document_path", { path });
    },
    async loadRecoveryManifest() {
      return tauri.core.invoke("load_recovery_manifest");
    },
    async loadRecoveryDocument(documentId, snapshotRevision) {
      return tauri.core.invoke("load_recovery_document", { documentId, snapshotRevision });
    },
    async writeRecoveryDocument(documentId, revision, json) {
      const started = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now() : Date.now();
      const native = await tauri.core.invoke("write_recovery_document", { documentId, revision, json });
      const completed = typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now() : Date.now();
      return native && typeof native === "object"
        ? { ...native, ipcAndNativeDurationMs: completed - started }
        : native;
    },
    async writeRecoveryManifest(generation, json) {
      return tauri.core.invoke("write_recovery_manifest", { generation, json });
    },
    async deleteRecoveryDocument(documentId) {
      return tauri.core.invoke("delete_recovery_document", { documentId });
    },
    async recoveryDirectory() {
      return tauri.core.invoke("recovery_directory");
    },
    async takePendingFiles() {
      return normalizePaths(await tauri.core.invoke("take_pending_files"));
    },
    async chooseSavePath({ defaultDir = "", suggestedName } = {}) {
      const p = await tauri.dialog.save({
        defaultPath: defaultSavePath(defaultDir, suggestedName),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      return p || null;
    },
    async writeFile(path, data) {
      await tauri.fs.writeFile(path, normalizeRawBytes(data));
    },
  };
}

if (typeof window !== "undefined") window.nativeApp = makeNativeApp(window.__TAURI__);
if (typeof module !== "undefined") module.exports = { makeNativeApp };
