(function initRecentDocuments(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  function installRecentDocuments({ document, controller, nativeApp }) {
    if (!nativeApp) return;
    const wrap = document.getElementById("recent-wrap");
    const trigger = document.getElementById("btn-recent");
    const panel = document.getElementById("recent-pop");
    const list = document.getElementById("recent-list");
    const message = document.getElementById("recent-message");
    const clear = document.getElementById("recent-clear");
    let generation = 0;
    let busy = false;
    wrap.hidden = false;

    function close(restoreFocus = false) {
      generation += 1;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.classList.remove("toggled");
      if (restoreFocus) trigger.focus();
    }

    function buttons() { return [...panel.querySelectorAll("button:not(:disabled)")]; }

    async function refresh() {
      const current = ++generation;
      list.replaceChildren();
      message.textContent = "Loading recent documents…";
      clear.disabled = true;
      try {
        const entries = await nativeApp.listRecentDocuments();
        if (current !== generation || panel.hidden) return;
        if (!Array.isArray(entries)) throw new Error("Invalid recent document list");
        for (const entry of entries) {
          const row = document.createElement("li");
          const open = document.createElement("button");
          open.type = "button";
          open.className = "recent-open";
          open.setAttribute("aria-label", `Open ${entry.path}`);
          open.title = entry.path;
          const separator = Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\"));
          const name = document.createElement("span");
          name.className = "recent-name";
          name.textContent = entry.path.slice(separator + 1);
          const folder = document.createElement("span");
          folder.className = "recent-folder";
          folder.textContent = entry.path.slice(0, separator) || "/";
          open.append(name, folder);
          open.addEventListener("click", () => run(async () => {
            const existing = controller.session?.findByCanonicalPath(entry.canonicalPath);
            if (existing) {
              controller.activateDocument(existing.id);
              nativeApp.rememberRecentDocument(entry.path).catch(() => {});
            } else {
              const result = await controller.openPaths([entry.path]);
              if (result.failed.length) {
                throw new Error(`Could not open ${entry.path}. ${result.failed[0].error.message} You can retry or remove it from this list.`);
              }
            }
            close();
          }));
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "recent-remove";
          remove.textContent = "×";
          remove.title = "Remove from list";
          remove.setAttribute("aria-label", `Remove ${entry.path} from recent documents`);
          remove.addEventListener("click", () => run(async () => {
            await nativeApp.removeRecentDocument(entry.canonicalPath);
            await refresh();
          }));
          row.append(open, remove);
          list.append(row);
        }
        message.textContent = entries.length ? "" : "No recent documents";
        clear.disabled = entries.length === 0;
      } catch (error) {
        if (current !== generation || panel.hidden) return;
        message.textContent = `Could not load recent documents. ${error.message || error}`;
        clear.disabled = false;
      }
      if (current === generation && !panel.hidden &&
          (document.activeElement === trigger || panel.contains(document.activeElement) || document.activeElement === document.body)) {
        (buttons()[0] || panel).focus();
      }
    }

    async function run(action) {
      if (busy) return;
      busy = true;
      const current = generation;
      const priorFocus = document.activeElement;
      const hadFocus = panel.contains(priorFocus);
      const enabled = buttons();
      enabled.forEach((button) => { button.disabled = true; });
      if (hadFocus) panel.focus();
      try { await action(); }
      catch (error) { message.textContent = error.message || String(error); }
      finally {
        busy = false;
        if (current === generation) {
          enabled.forEach((button) => { button.disabled = false; });
          if (!panel.hidden && document.activeElement === panel && enabled.includes(priorFocus)) priorFocus.focus();
        }
      }
    }

    trigger.addEventListener("click", () => {
      if (!panel.hidden) { close(true); return; }
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.classList.add("toggled");
      refresh();
    });
    clear.addEventListener("click", () => run(async () => {
      await nativeApp.clearRecentDocuments();
      await refresh();
    }));
    document.addEventListener("click", (event) => {
      if (!event.composedPath().includes(wrap)) close();
    });
    document.addEventListener("focusin", (event) => {
      if (!wrap.contains(event.target)) close();
    });
    wrap.addEventListener("keydown", (event) => {
      if (panel.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = buttons();
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[target].focus();
      }
    });
  }

  return { installRecentDocuments };
});
