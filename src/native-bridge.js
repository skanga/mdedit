/* Native file access bridge for the desktop (Tauri) shell.
 *
 * In a plain browser this defines window.nativeApp = null and everything else
 * in the app runs exactly as before. Inside the Tauri shell,
 * app.withGlobalTauri exposes window.__TAURI__ with the dialog and fs plugin
 * APIs, and this file wraps them in the tiny surface the app needs:
 *
 *   nativeApp.pickFile()                            -> path string, null on cancel
 *   nativeApp.readFile(path)                        -> file text (utf-8)
 *   nativeApp.saveAs({ defaultDir, suggestedName, data })
 *                                                -> chosen path, null on cancel
 *   nativeApp.writeFile(path, data)                 -> write to a known path (write-back)
 *
 * defaultDir (optional) anchors the save dialog next to the document being
 * edited; without it the OS picks its own default location.
 *
 * data is a string (written as utf-8) or a Uint8Array (raw bytes, for PNG exports).
 */
function makeNativeApp(tauri) {
  if (!tauri || !tauri.dialog || !tauri.fs) return null;
  return {
    async pickFile() {
      const p = await tauri.dialog.open({
        multiple: false,
        directory: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }],
      });
      return p || null;
    },
    async readFile(path) {
      return tauri.fs.readTextFile(path);
    },
    async saveAs({ defaultDir = "", suggestedName, data }) {
      const p = await tauri.dialog.save({
        defaultPath: (defaultDir ? defaultDir.replace(/[/\\]$/, "") + "/" : "") + (suggestedName || "untitled.md"),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
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
