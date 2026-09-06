(function initWorkspaceView(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDEdit = Object.assign(root.MDEdit || {}, api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const STATUS_BY_FILE_STATE = {
    "externally-changed": "File changed outside MDedit",
    missing: "File is missing",
    "read-error": "File could not be read",
  };
  const RECOVERY_STATUS_TEXT = {
    pending: "Recovery pending",
    writing: "Saving recovery…",
    failed: "Recovery save failed",
  };

  function normalizedInteger(value, fallback = 0) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
  }

  function stableToken(documentId) {
    return encodeURIComponent(String(documentId));
  }

  function documentStatus(document) {
    const statusText = STATUS_BY_FILE_STATE[document && document.fileStatus];
    if (statusText) {
      return {
        statusText: document && document.dirty ? `${statusText}; Unsaved changes` : statusText,
        statusKind: "conflict",
      };
    }
    if (document && document.dirty) return { statusText: "Unsaved changes", statusKind: "dirty" };
    return { statusText: "", statusKind: "clean" };
  }

  function tabDescriptor(document, { activeId = null, index = 0, size = 1 } = {}) {
    if (!document || typeof document !== "object") throw new TypeError("document is required");
    const documentId = String(document.id);
    const displayName = typeof document.displayName === "string" ? document.displayName : "Untitled";
    const token = stableToken(documentId);
    const { statusText, statusKind } = documentStatus(document);

    return {
      documentId,
      displayName,
      selected: documentId === activeId,
      position: normalizedInteger(index) + 1,
      setSize: Math.max(1, normalizedInteger(size, 1)),
      statusText,
      statusKind,
      closeLabel: `Close ${displayName}`,
      tabId: `document-tab-${token}`,
      panelId: `document-panel-${token}`,
      ariaControls: `document-panel-${token}`,
    };
  }

  function captureEditorState(editor) {
    if (!editor || typeof editor !== "object") {
      return { selectionStart: 0, selectionEnd: 0, editorScrollTop: 0 };
    }

    const hasStringValue = typeof editor.value === "string";
    const length = hasStringValue ? editor.value.length : 0;
    let selectionStart = normalizedInteger(editor.selectionStart);
    let selectionEnd = Math.max(selectionStart, normalizedInteger(editor.selectionEnd));
    if (hasStringValue) {
      selectionStart = Math.min(length, selectionStart);
      selectionEnd = Math.min(length, Math.max(selectionStart, selectionEnd));
    }
    return {
      selectionStart,
      selectionEnd,
      editorScrollTop: normalizedInteger(editor.scrollTop),
    };
  }

  function requireElement(value, name) {
    if (!value || typeof value.addEventListener !== "function") {
      throw new TypeError(`${name} element is required`);
    }
    return value;
  }

  function callbackFrom(options, intents, names) {
    for (const name of names) {
      if (typeof options[name] === "function") return options[name];
      if (typeof intents[name] === "function") return intents[name];
    }
    return () => {};
  }

  function eventActionTarget(target, attribute) {
    if (!target) return null;
    if (typeof target.closest === "function") return target.closest(`[${attribute}]`);
    let current = target;
    while (current) {
      if (typeof current.getAttribute === "function" && current.getAttribute(attribute)) return current;
      current = current.parentNode;
    }
    return null;
  }

  function recoveryStatus(value) {
    if (value === null || value === undefined || value === "clean") return null;
    if (typeof value === "string") {
      return RECOVERY_STATUS_TEXT[value]
        ? { kind: value, message: RECOVERY_STATUS_TEXT[value] }
        : { kind: "message", message: value };
    }
    if (typeof value !== "object") return null;
    const kind = value.recoveryStatus || value.status;
    if (kind === "clean") return null;
    const fallback = RECOVERY_STATUS_TEXT[kind] || "";
    const message = typeof value.message === "string" && value.message ? value.message : fallback;
    return message ? { kind: RECOVERY_STATUS_TEXT[kind] ? kind : "message", message } : null;
  }

  class WorkspaceView {
    constructor(options = {}) {
      const elements = options.elements || options;
      const intents = options.intents || options.callbacks || {};
      this.document = options.document || (elements.tabList && elements.tabList.ownerDocument);
      if (!this.document || typeof this.document.createElement !== "function") {
        throw new TypeError("document is required");
      }

      this.tabList = requireElement(elements.tabList, "tab list");
      this.addButton = elements.addButton || null;
      this.editorSurfaces = requireElement(elements.editorSurfaces, "editor surfaces");
      this.dialogBackdrop = elements.dialogBackdrop || null;
      this.dialog = elements.dialog || null;
      this.dialogTitle = elements.dialogTitle || null;
      this.dialogMessage = elements.dialogMessage || null;
      this.dialogDocuments = elements.dialogDocuments || null;
      this.dialogActions = elements.dialogActions || null;

      this.onActivate = callbackFrom(options, intents, ["onActivate", "activate", "activateDocument"]);
      this.onClose = callbackFrom(options, intents, ["onClose", "close", "closeDocument"]);
      this.onAdd = callbackFrom(options, intents, ["onAdd", "add", "addDocument"]);
      this.onEditorInput = callbackFrom(options, intents, ["onEditorInput", "editorInput", "editDocument"]);

      this._tabs = new Map();
      this._editors = new Map();
      this._runtimeStatuses = new Map();
      this._legacySurfaces = [...this.editorSurfaces.children].map((surface) => ({
        surface,
        hidden: Boolean(surface.hidden),
      }));
      this._tabOrder = [];
      this._activeDocumentId = null;
      this._dialogState = null;
      this._disposed = false;

      this._handleTabClick = (event) => this._onTabClick(event);
      this._handleTabKeydown = (event) => this._onTabKeydown(event);
      this._handleAdd = () => this.onAdd();
      this._handleDialogClick = (event) => this._onDialogClick(event);
      this._handleBackdropClick = () => this.closeDialog(null);
      this._handleDocumentKeydown = (event) => this._onDocumentKeydown(event);

      this.tabList.addEventListener("click", this._handleTabClick);
      this.tabList.addEventListener("keydown", this._handleTabKeydown);
      if (this.addButton) this.addButton.addEventListener("click", this._handleAdd);
      if (this.dialogActions) this.dialogActions.addEventListener("click", this._handleDialogClick);
      if (this.dialogBackdrop) this.dialogBackdrop.addEventListener("click", this._handleBackdropClick);
      this.document.addEventListener("keydown", this._handleDocumentKeydown);
    }

    renderTabs(documents, activeId) {
      const focused = this._focusedTabControl();
      let ordered = documents;
      if (documents && !Array.isArray(documents) && Array.isArray(documents.tabOrder) && documents.documents) {
        ordered = documents.tabOrder.map((id) => documents.documents.get(id)).filter(Boolean);
        activeId = documents.activeDocumentId;
      }
      if (!Array.isArray(ordered)) ordered = [];

      const fragment = [];
      const tabs = new Map();
      const order = [];
      ordered.forEach((document, index) => {
        const descriptor = tabDescriptor(document, { activeId, index, size: ordered.length });
        const shell = this.document.createElement("div");
        shell.className = "document-tab";
        shell.setAttribute("data-document-id", descriptor.documentId);
        shell.classList.toggle("is-selected", descriptor.selected);
        shell.classList.toggle("is-dirty", Boolean(document.dirty));
        shell.classList.toggle("is-conflict", descriptor.statusKind === "conflict");

        const tab = this.document.createElement("button");
        tab.setAttribute("type", "button");
        tab.setAttribute("role", "tab");
        tab.setAttribute("id", descriptor.tabId);
        tab.setAttribute("data-action", "activate");
        tab.setAttribute("data-document-id", descriptor.documentId);
        tab.setAttribute("aria-controls", descriptor.ariaControls);
        tab.setAttribute("aria-selected", String(descriptor.selected));
        tab.setAttribute("aria-posinset", String(descriptor.position));
        tab.setAttribute("aria-setsize", String(descriptor.setSize));
        tab.setAttribute("tabindex", descriptor.selected ? "0" : "-1");

        const name = this.document.createElement("span");
        name.className = "document-tab-name";
        name.textContent = descriptor.displayName;
        const status = this.document.createElement("span");
        status.className = "document-tab-status visually-hidden";
        const recovery = this.document.createElement("span");
        recovery.className = "document-tab-recovery";
        recovery.setAttribute("aria-hidden", "true");
        recovery.hidden = true;
        tab.append(name, status, recovery);

        const close = this.document.createElement("button");
        close.className = "document-tab-close";
        close.setAttribute("type", "button");
        close.setAttribute("data-action", "close");
        close.setAttribute("data-document-id", descriptor.documentId);
        close.setAttribute("aria-label", descriptor.closeLabel);
        close.textContent = "×";
        shell.append(tab, close);
        fragment.push(shell);
        const record = {
          shell,
          tab,
          status,
          recovery,
          close,
          baseStatusText: descriptor.statusText,
          dirty: Boolean(document.dirty),
          conflict: descriptor.statusKind === "conflict",
        };
        this._applyTabStatus(record, this._runtimeStatuses.get(descriptor.documentId));
        tabs.set(descriptor.documentId, record);
        order.push(descriptor.documentId);
      });

      this.tabList.replaceChildren(...fragment);
      this._tabs = tabs;
      this._tabOrder = order;
      this._activeDocumentId = activeId === undefined || activeId === null ? null : String(activeId);
      const focusRecord = focused && tabs.get(focused.documentId);
      if (focusRecord) {
        const control = focused.action === "close" ? focusRecord.close : focusRecord.tab;
        if (typeof control.focus === "function") control.focus();
      }
      const scrollRecord = focusRecord || tabs.get(this._activeDocumentId);
      if (scrollRecord && typeof scrollRecord.tab.scrollIntoView === "function") {
        scrollRecord.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      return order.length;
    }

    ensureEditor(document) {
      if (!document || typeof document !== "object") throw new TypeError("document is required");
      const documentId = String(document.id);
      const existing = this._editors.get(documentId);
      if (existing) return existing.editor;

      const descriptor = tabDescriptor(document);
      const surface = this.document.createElement("div");
      surface.className = "editor-surface";
      surface.hidden = true;
      surface.setAttribute("id", descriptor.panelId);
      surface.setAttribute("role", "tabpanel");
      surface.setAttribute("aria-labelledby", descriptor.tabId);
      surface.setAttribute("data-document-id", documentId);

      const editor = this.document.createElement("textarea");
      editor.className = "document-editor";
      editor.setAttribute("id", `document-editor-${stableToken(documentId)}`);
      editor.setAttribute("data-document-id", documentId);
      editor.setAttribute("spellcheck", "false");
      editor.setAttribute("placeholder", "Type markdown here, or drop a .md file anywhere…");
      editor.value = typeof document.content === "string" ? document.content : "";
      const onInput = (event) => this.onEditorInput(documentId, editor.value, event);
      editor.addEventListener("input", onInput);

      surface.appendChild(editor);
      this.editorSurfaces.appendChild(surface);
      this._editors.set(documentId, { surface, editor, onInput });
      this._setLegacySurfacesHidden(true);
      return editor;
    }

    removeEditor(documentId) {
      const id = String(documentId);
      const record = this._editors.get(id);
      if (!record) return false;
      record.editor.removeEventListener("input", record.onInput);
      record.surface.remove();
      this._editors.delete(id);
      if (this._activeDocumentId === id) this._activeDocumentId = null;
      if (this._editors.size === 0) this._restoreLegacySurfaces();
      return true;
    }

    editorFor(documentId) {
      const record = this._editors.get(String(documentId));
      return record ? record.editor : null;
    }

    activateEditor(documentId) {
      const id = documentId === undefined || documentId === null ? null : String(documentId);
      let found = false;
      for (const [candidate, record] of this._editors) {
        const active = candidate === id;
        record.surface.hidden = !active;
        if (active) found = true;
      }
      if (found) this._setLegacySurfacesHidden(true);
      else if (this._editors.size === 0) this._restoreLegacySurfaces();
      this._activeDocumentId = found ? id : null;
      for (const [candidate, record] of this._tabs) {
        const selected = found && candidate === id;
        record.shell.classList.toggle("is-selected", selected);
        record.tab.setAttribute("aria-selected", String(selected));
        record.tab.setAttribute("tabindex", selected ? "0" : "-1");
      }
      return found ? this.editorFor(id) : null;
    }

    captureWorkspace(documentId = this._activeDocumentId) {
      return captureEditorState(this.editorFor(documentId));
    }

    applyWorkspace(documentId, workspace) {
      if (documentId && typeof documentId === "object") {
        workspace = workspace || documentId.workspace;
        documentId = documentId.id;
      }
      const editor = this.editorFor(documentId);
      if (!editor) return false;
      const source = workspace && typeof workspace === "object" ? workspace : {};
      const state = captureEditorState({
        value: editor.value,
        selectionStart: source.selectionStart,
        selectionEnd: source.selectionEnd,
        scrollTop: source.editorScrollTop,
      });
      if (typeof editor.setSelectionRange === "function") {
        editor.setSelectionRange(state.selectionStart, state.selectionEnd);
      } else {
        editor.selectionStart = state.selectionStart;
        editor.selectionEnd = state.selectionEnd;
      }
      editor.scrollTop = state.editorScrollTop;
      return true;
    }

    setDocumentStatus(documentId, status) {
      if (documentId && typeof documentId === "object") {
        status = documentId;
        documentId = documentId.id;
      }
      const record = this._tabs.get(String(documentId));
      const id = String(documentId);
      const isBaseStatus = status && typeof status === "object"
        && (Object.prototype.hasOwnProperty.call(status, "dirty") || Object.prototype.hasOwnProperty.call(status, "fileStatus"))
        && !Object.prototype.hasOwnProperty.call(status, "recoveryStatus")
        && !Object.prototype.hasOwnProperty.call(status, "status")
        && !Object.prototype.hasOwnProperty.call(status, "message");
      if (isBaseStatus && record) {
        const descriptor = documentStatus(status);
        record.baseStatusText = descriptor.statusText;
        record.dirty = Boolean(status.dirty);
        record.conflict = descriptor.statusKind === "conflict";
      } else {
        const runtime = recoveryStatus(status);
        if (runtime) this._runtimeStatuses.set(id, runtime);
        else this._runtimeStatuses.delete(id);
      }
      if (!record) return false;
      this._applyTabStatus(record, this._runtimeStatuses.get(id));
      return true;
    }

    focusActiveEditor() {
      const editor = this.editorFor(this._activeDocumentId);
      if (!editor || typeof editor.focus !== "function") return false;
      editor.focus();
      return true;
    }

    showDialog({ title = "", message = "", documents = [], actions = [] } = {}) {
      this._requireDialogElements();
      if (this._dialogState && this._dialogState.busy) return this._dialogState.promise;
      if (this._dialogState) this.closeDialog(null);

      this.dialogTitle.textContent = String(title);
      this.dialogMessage.textContent = String(message);
      this.dialogMessage.removeAttribute("role");
      const documentNodes = (Array.isArray(documents) ? documents : []).map((item) => {
        const row = this.document.createElement("li");
        row.textContent = typeof item === "string" ? item : String(item && (item.displayName || item.name || item.id) || "");
        return row;
      });
      this.dialogDocuments.replaceChildren(...documentNodes);
      this.dialogDocuments.hidden = documentNodes.length === 0;

      const actionMap = new Map();
      const actionNodes = (Array.isArray(actions) ? actions : []).map((action, index) => {
        const normalized = action && typeof action === "object" ? action : { label: String(action) };
        const id = String(normalized.id ?? normalized.value ?? index);
        const button = this.document.createElement("button");
        button.className = normalized.primary ? "btn primary" : "btn";
        button.setAttribute("type", "button");
        button.setAttribute("data-dialog-action", id);
        button.textContent = String(normalized.label ?? normalized.title ?? id);
        actionMap.set(id, normalized);
        return button;
      });
      this.dialogActions.replaceChildren(...actionNodes);

      const priorFocus = this.document.activeElement;
      this.dialogBackdrop.hidden = false;
      this.dialog.hidden = false;
      this.dialog.setAttribute("tabindex", "-1");

      let state;
      const promise = new Promise((resolve, reject) => {
        state = { actions: actionMap, priorFocus, resolve, reject, busy: false, promise: null };
      });
      state.promise = promise;
      this._dialogState = state;
      (actionNodes[0] || this.dialog).focus();
      return promise;
    }

    closeDialog(result = null, error = null, force = false) {
      const state = this._dialogState;
      if (!state) return false;
      if (state.busy && !force) return false;
      this._dialogState = null;
      this.dialog.removeAttribute("aria-busy");
      this.dialogActions.removeAttribute("aria-busy");
      this.dialog.hidden = true;
      this.dialogBackdrop.hidden = true;
      if (state.priorFocus && typeof state.priorFocus.focus === "function") state.priorFocus.focus();
      if (error) state.reject(error);
      else state.resolve(result);
      return true;
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this.tabList.removeEventListener("click", this._handleTabClick);
      this.tabList.removeEventListener("keydown", this._handleTabKeydown);
      if (this.addButton) this.addButton.removeEventListener("click", this._handleAdd);
      if (this.dialogActions) this.dialogActions.removeEventListener("click", this._handleDialogClick);
      if (this.dialogBackdrop) this.dialogBackdrop.removeEventListener("click", this._handleBackdropClick);
      this.document.removeEventListener("keydown", this._handleDocumentKeydown);
      if (this._dialogState) this.closeDialog(null);
      for (const record of this._editors.values()) {
        record.editor.removeEventListener("input", record.onInput);
        record.surface.remove();
      }
      this._editors.clear();
      this._restoreLegacySurfaces();
    }

    _requireDialogElements() {
      for (const [name, element] of [
        ["dialog backdrop", this.dialogBackdrop],
        ["dialog", this.dialog],
        ["dialog title", this.dialogTitle],
        ["dialog message", this.dialogMessage],
        ["dialog documents", this.dialogDocuments],
        ["dialog actions", this.dialogActions],
      ]) {
        if (!element) throw new TypeError(`${name} element is required`);
      }
    }

    _onTabClick(event) {
      const target = eventActionTarget(event.target, "data-action");
      if (!target || !this.tabList.contains(target)) return;
      const action = target.getAttribute("data-action");
      const documentId = target.getAttribute("data-document-id");
      if (!documentId) return;
      if (action === "close") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        this.onClose(documentId);
      } else if (action === "activate") {
        this.onActivate(documentId);
      }
    }

    _onTabKeydown(event) {
      const target = eventActionTarget(event.target, "data-action");
      if (!target || target.getAttribute("role") !== "tab") return;
      const currentId = target.getAttribute("data-document-id");
      const index = this._tabOrder.indexOf(currentId);
      if (index < 0) return;
      let nextIndex;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % this._tabOrder.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + this._tabOrder.length) % this._tabOrder.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = this._tabOrder.length - 1;
      else if (event.key === "Delete") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        this.onClose(currentId);
        return;
      } else return;

      if (typeof event.preventDefault === "function") event.preventDefault();
      const nextId = this._tabOrder[nextIndex];
      const next = this._tabs.get(nextId);
      if (next && typeof next.tab.focus === "function") next.tab.focus();
      this.onActivate(nextId);
    }

    async _onDialogClick(event) {
      const target = eventActionTarget(event.target, "data-dialog-action");
      const state = this._dialogState;
      if (!target || !state || state.busy || !this.dialogActions.contains(target)) return;
      const action = state.actions.get(target.getAttribute("data-dialog-action"));
      if (!action) return;
      state.busy = true;
      for (const child of this.dialogActions.children) child.disabled = true;
      this.dialog.setAttribute("aria-busy", "true");
      this.dialogActions.setAttribute("aria-busy", "true");
      try {
        let result = action.value ?? action.id ?? target.getAttribute("data-dialog-action");
        const callback = action.callback || action.onSelect || action.onClick;
        if (typeof callback === "function") result = await callback(action);
        if (this._dialogState === state) this.closeDialog(result, null, true);
      } catch (error) {
        if (this._dialogState === state) {
          state.busy = false;
          this.dialog.removeAttribute("aria-busy");
          this.dialogActions.removeAttribute("aria-busy");
          for (const child of this.dialogActions.children) child.disabled = false;
          this.dialogMessage.setAttribute("role", "alert");
          this.dialogMessage.textContent = error instanceof Error ? error.message : String(error);
          const first = this.dialogActions.children[0];
          if (first && typeof first.focus === "function") first.focus();
        }
      }
    }

    _onDocumentKeydown(event) {
      if (!this._dialogState) return;
      if (event.key === "Escape") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (this._dialogState.busy) return;
        this.closeDialog(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...this.dialogActions.children].filter((element) => !element.disabled);
      if (focusable.length === 0) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        this.dialog.focus();
        return;
      }
      const current = focusable.indexOf(this.document.activeElement);
      const leavingEnd = !event.shiftKey && current === focusable.length - 1;
      const leavingStart = event.shiftKey && current <= 0;
      if (!leavingEnd && !leavingStart) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
    }

    _focusedTabControl() {
      const target = eventActionTarget(this.document.activeElement, "data-action");
      if (!target || !this.tabList.contains(target)) return null;
      const action = target.getAttribute("data-action");
      if (action !== "activate" && action !== "close") return null;
      const documentId = target.getAttribute("data-document-id");
      return documentId ? { documentId, action } : null;
    }

    _applyTabStatus(record, runtime) {
      record.status.textContent = [record.baseStatusText, runtime && runtime.message].filter(Boolean).join("; ");
      record.shell.classList.toggle("is-dirty", record.dirty);
      record.shell.classList.toggle("is-conflict", record.conflict);
      for (const kind of ["pending", "writing", "failed"]) {
        record.shell.classList.toggle(`recovery-${kind}`, Boolean(runtime && runtime.kind === kind));
      }
      const visibleFailure = runtime && runtime.kind === "failed";
      record.recovery.hidden = !visibleFailure;
      record.recovery.textContent = visibleFailure ? runtime.message : "";
    }

    _setLegacySurfacesHidden(hidden) {
      for (const legacy of this._legacySurfaces) legacy.surface.hidden = hidden;
    }

    _restoreLegacySurfaces() {
      for (const legacy of this._legacySurfaces) legacy.surface.hidden = legacy.hidden;
    }
  }

  return { WorkspaceView, captureEditorState, tabDescriptor };
});
