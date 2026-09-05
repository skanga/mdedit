/* Native file access bridge for the desktop (Tauri) shell.
 *
 * In a plain browser this defines window.nativeApp = null and everything else
 * in the app runs exactly as before. Inside the Tauri shell,
 * app.withGlobalTauri exposes window.__TAURI__ with the dialog and fs plugin
 * APIs, and this file wraps them in the tiny surface the app needs:
 *
 *   nativeApp.pickFile()                            -> path string, null on cancel
 *   nativeApp.pickFiles()                           -> path strings, [] on cancel
 *   nativeApp.readFile(path)                        -> file text (utf-8)
 *   nativeApp.readDocument(path)                    -> session-backed document text
 *   nativeApp.saveAs({ defaultDir, suggestedName, data })
 *                                                -> chosen path, null on cancel
 *   nativeApp.chooseSavePath({ defaultDir, suggestedName })
 *                                                -> chosen path, null on cancel
 *   nativeApp.writeFile(path, data)                 -> write to a known path (write-back)
 *
 * defaultDir (optional) anchors the save dialog next to the document being
 * edited; without it the OS picks its own default location.
 *
 * data is a string (written as utf-8) or a Uint8Array (raw bytes, for PNG exports).
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

function makeNativeApp(tauri) {
  if (!tauri || !tauri.dialog || !tauri.fs || !tauri.core || typeof tauri.core.invoke !== "function") return null;
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
    async readFile(path) {
      return tauri.fs.readTextFile(path);
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
      return tauri.core.invoke("write_recovery_document", { documentId, revision, json });
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
    async chooseSavePath({ defaultDir = "", suggestedName } = {}) {
      const p = await tauri.dialog.save({
        defaultPath: defaultSavePath(defaultDir, suggestedName),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      return p || null;
    },
    async saveAs({ defaultDir = "", suggestedName, data }) {
      const p = await this.chooseSavePath({ defaultDir, suggestedName });
      if (!p) return null;
      await this.writeFile(p, data);
      return p;
    },
    async writeFile(path, data) {
      if (typeof data === "string") await tauri.fs.writeTextFile(path, data);
      else await tauri.fs.writeFile(path, data);
    },
  };
}

if (typeof window !== "undefined") window.nativeApp = makeNativeApp(window.__TAURI__);
if (typeof module !== "undefined") module.exports = { makeNativeApp };
