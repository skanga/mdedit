const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  WorkspaceView,
  captureEditorState,
  commandForKey,
  openLaunchFiles,
  tabDescriptor,
  windowTitle,
} = require("../src/workspace-view.js");
const { SessionController } = require("../src/session-controller.js");

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _names() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this._names();
    names.forEach((name) => values.add(name));
    this.element.className = [...values].join(" ");
  }

  remove(...names) {
    const values = this._names();
    names.forEach((name) => values.delete(name));
    this.element.className = [...values].join(" ");
  }

  toggle(name, force) {
    const values = this._names();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this.element.className = [...values].join(" ");
    return enabled;
  }

  contains(name) {
    return this._names().has(name);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.listeners = new Map();
    this._text = "";
  }

  set id(value) { this.setAttribute("id", value); }
  get id() { return this.getAttribute("id") || ""; }

  set textContent(value) {
    this._text = String(value ?? "");
    this.textContentWrites = (this.textContentWrites || 0) + 1;
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set innerHTML(_value) {
    throw new Error("unsafe innerHTML used");
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    if (this.children.some((child) => child.contains(this.ownerDocument.activeElement))) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = "";
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    const string = String(value);
    this.attributes.set(name, string);
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = string;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => { event.propagationStopped = true; };
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles && !event.propagationStopped && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  contains(candidate) {
    return candidate === this || this.children.some((child) => child.contains(candidate));
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector === "[data-action]" && current.getAttribute("data-action")) return current;
      if (selector === "[data-dialog-action]" && current.getAttribute("data-dialog-action")) return current;
      current = current.parentNode;
    }
    return null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  scrollIntoView(options) {
    this.scrollIntoViewCalls ||= [];
    this.scrollIntoViewCalls.push(options);
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.listeners = new Map();
    this.body = this.createElement("body");
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function find(element, predicate) {
  return descendants(element).find(predicate);
}

function makeFixture(callbacks = {}, fixtureOptions = {}) {
  const document = new FakeDocument();
  const elements = {};
  const ids = {
    tabList: "document-tabs",
    addButton: "btn-add-tab",
    editorSurfaces: "editor-surfaces",
    dialogBackdrop: "dialog-backdrop",
    dialog: "app-dialog",
    dialogTitle: "dialog-title",
    dialogMessage: "dialog-message",
    dialogDocuments: "dialog-documents",
    dialogActions: "dialog-actions",
    statusElement: "status",
  };
  for (const name of [
    "tabList", "addButton", "editorSurfaces", "dialogBackdrop", "dialog",
    "dialogTitle", "dialogMessage", "dialogDocuments", "dialogActions", "statusElement",
  ]) {
    elements[name] = document.createElement(name === "dialog" ? "section" : "div");
    elements[name].id = ids[name];
  }
  elements.dialog.hidden = true;
  elements.dialogBackdrop.hidden = true;
  Object.values(elements).forEach((element) => document.body.appendChild(element));
  let legacy = null;
  if (fixtureOptions.legacy) {
    const surface = document.createElement("div");
    surface.className = "editor-surface";
    const editor = document.createElement("textarea");
    editor.id = "editor";
    surface.appendChild(editor);
    elements.editorSurfaces.appendChild(surface);
    legacy = { surface, editor };
  }
  const view = new WorkspaceView({ document, ...elements, ...callbacks });
  return { document, elements, legacy, view };
}

function doc(id, overrides = {}) {
  return {
    id,
    displayName: `${id}.md`,
    content: `content:${id}`,
    dirty: false,
    fileStatus: "normal",
    workspace: {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("browser wrapper merges workspace exports into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "workspace-view.js"), "utf8");
  const sandbox = { window: { MDEdit: {} }, Promise };

  vm.runInNewContext(code, sandbox, { filename: "workspace-view.js" });

  assert.equal(typeof sandbox.window.MDEdit.WorkspaceView, "function");
  assert.equal(typeof sandbox.window.MDEdit.tabDescriptor, "function");
  assert.equal(typeof sandbox.window.MDEdit.captureEditorState, "function");
  assert.equal(typeof sandbox.window.MDEdit.commandForKey, "function");
  assert.equal(typeof sandbox.window.MDEdit.isTabCommandKey, "function");
  assert.equal(typeof sandbox.window.MDEdit.openLaunchFiles, "function");
});

test("openLaunchFiles awaits handles in order, reports individual failures, and opens once", async () => {
  let resolveFirst;
  let resolveThird;
  const firstRead = new Promise((resolve) => { resolveFirst = resolve; });
  const thirdRead = new Promise((resolve) => { resolveThird = resolve; });
  const firstFile = { name: "a.md" };
  const thirdFile = { name: "c.md" };
  const calls = [];
  const errors = [];
  const handles = [
    { async getFile() { calls.push("a"); return firstRead; } },
    { async getFile() { calls.push("bad"); throw new Error("handle denied"); } },
    { async getFile() { calls.push("c"); return thirdRead; } },
  ];
  const opened = [];
  let callbackCalls = 0;
  const opening = openLaunchFiles(
    handles,
    async (filesPromise, successfulHandlesPromise) => {
      callbackCalls += 1;
      const files = await filesPromise;
      const successfulHandles = await successfulHandlesPromise;
      opened.push([files, successfulHandles]);
      return { opened: files, failed: [], results: files.map((file) => ({ file, document: file, error: null })) };
    },
    (error, _handle, index) => errors.push([index, error.message]),
  );

  assert.equal(callbackCalls, 1);
  assert.equal(opened.length, 0);
  await Promise.resolve();
  assert.deepEqual(calls, ["a"]);
  resolveFirst(firstFile);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "bad", "c"]);
  resolveThird(thirdFile);
  const result = await opening;

  assert.deepEqual(errors, [[1, "handle denied"]]);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0][0], [firstFile, thirdFile]);
  assert.deepEqual(opened[0][1], [handles[0], handles[2]]);
  assert.deepEqual(result.results.map((item) => item.error && item.error.message), [null, "handle denied", null]);
  assert.deepEqual(result.opened, [firstFile, thirdFile]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "browser file");
});

test("commandForKey maps only the exact tab-management shortcuts", () => {
  const fixture = [
    [{ key: "Tab", ctrlKey: true }, "next-tab"],
    [{ key: "Tab", ctrlKey: true, shiftKey: true }, "previous-tab"],
    [{ key: "ArrowLeft", altKey: true, shiftKey: true }, "move-tab-left"],
    [{ key: "ArrowRight", altKey: true, shiftKey: true }, "move-tab-right"],
    [{ key: "w", ctrlKey: true, isMac: false }, "close-tab"],
    [{ key: "W", metaKey: true, isMac: true }, "close-tab"],
  ];
  for (const [event, expected] of fixture) assert.equal(commandForKey(event), expected);
  assert.equal(commandForKey({ key: "w", metaKey: true }, { isMac: true }), "close-tab");
  assert.equal(commandForKey({ key: "w", ctrlKey: true, isMac: true }, { isMac: false }), "close-tab");

  for (const event of [
    { key: "Tab", metaKey: true, isMac: true },
    { key: "Tab", ctrlKey: true, altKey: true },
    { key: "ArrowLeft", altKey: true },
    { key: "ArrowRight", altKey: true, shiftKey: true, ctrlKey: true },
    { key: "w", metaKey: true, isMac: false },
    { key: "w", ctrlKey: true, isMac: true },
    { key: "w", ctrlKey: true, shiftKey: true },
    { key: "w", ctrlKey: true, metaKey: true },
    { key: "w", ctrlKey: true, repeat: true },
    { key: "Tab", ctrlKey: true, repeat: true },
    { key: "ArrowLeft", altKey: true, shiftKey: true, repeat: true },
    { key: "q", ctrlKey: true },
  ]) assert.equal(commandForKey(event), null, JSON.stringify(event));
});

test("tabDescriptor exposes stable tab semantics and document status", () => {
  const dirty = tabDescriptor(doc("a/b", { displayName: "Draft <one>", dirty: true }), {
    activeId: "a/b", index: 0, size: 3,
  });
  const conflict = tabDescriptor(doc("two", { fileStatus: "externally-changed" }), {
    activeId: "a/b", index: 1, size: 3,
  });

  assert.deepEqual(dirty, {
    documentId: "a/b",
    displayName: "Draft <one>",
    selected: true,
    position: 1,
    setSize: 3,
    statusText: "Unsaved changes",
    statusKind: "dirty",
    closeLabel: "Close Draft <one>",
    tabId: "document-tab-a%2Fb",
    panelId: "document-panel-a%2Fb",
    ariaControls: "document-panel-a%2Fb",
  });
  assert.equal(conflict.statusText, "File changed outside MDedit");
  assert.equal(conflict.statusKind, "conflict");
  assert.equal(tabDescriptor(doc("m", { fileStatus: "missing" }), { index: 0, size: 1 }).statusText, "File is missing");
  assert.equal(tabDescriptor(doc("r", { fileStatus: "read-error" }), { index: 0, size: 1 }).statusText, "File could not be read");
  assert.equal(
    tabDescriptor(doc("both", { dirty: true, fileStatus: "externally-changed" }), { index: 0, size: 1 }).statusText,
    "File changed outside MDedit; Unsaved changes",
  );
});

test("captureEditorState defensively clamps caret and scroll values", () => {
  assert.deepEqual(captureEditorState({ value: "abc", selectionStart: 9, selectionEnd: -4, scrollTop: Infinity }), {
    selectionStart: 3,
    selectionEnd: 3,
    editorScrollTop: 0,
  });
  assert.deepEqual(captureEditorState({ value: null, selectionStart: 1.9, selectionEnd: 2.8, scrollTop: 7.9 }), {
    selectionStart: 1,
    selectionEnd: 2,
    editorScrollTop: 7,
  });
  assert.deepEqual(captureEditorState(null), {
    selectionStart: 0,
    selectionEnd: 0,
    editorScrollTop: 0,
  });
});

test("captureEditorState preserves normalized selection when value is unavailable", () => {
  assert.deepEqual(captureEditorState({ selectionStart: 3, selectionEnd: 5, scrollTop: 22 }), {
    selectionStart: 3,
    selectionEnd: 5,
    editorScrollTop: 22,
  });
});

test("renderTabs builds safe ARIA tabs, statuses, and close labels", () => {
  const { elements, view } = makeFixture();
  view.renderTabs([
    doc("one", { displayName: '<img src=x onerror="boom">', dirty: true }),
    doc("two", { fileStatus: "externally-changed" }),
  ], "two");

  assert.equal(elements.tabList.children.length, 2);
  const firstTab = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  const firstClose = find(elements.tabList.children[0], (el) => el.getAttribute("data-action") === "close");
  const secondTab = find(elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  const status = find(elements.tabList.children[0], (el) => el.classList.contains("document-tab-status"));

  assert.equal(firstTab.textContent, '<img src=x onerror="boom">Unsaved changes');
  assert.equal(firstTab.getAttribute("aria-selected"), "false");
  assert.equal(firstTab.getAttribute("tabindex"), "-1");
  assert.equal(firstTab.getAttribute("aria-posinset"), "1");
  assert.equal(firstTab.getAttribute("aria-setsize"), "2");
  assert.equal(firstTab.getAttribute("draggable"), "true");
  assert.equal(secondTab.getAttribute("aria-selected"), "true");
  assert.equal(secondTab.getAttribute("tabindex"), "0");
  assert.equal(firstClose.getAttribute("aria-label"), 'Close <img src=x onerror="boom">');
  assert.equal(status.textContent, "Unsaved changes");
});

test("dragging a tab delegates a reorder without activating it", () => {
  const reorders = [];
  const { elements, view } = makeFixture({
    onReorder(sourceId, targetId) { reorders.push([sourceId, targetId]); },
  });
  view.renderTabs([doc("one"), doc("two"), doc("three")], "two");
  const first = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  const third = find(elements.tabList.children[2], (el) => el.getAttribute("role") === "tab");
  const values = new Map();
  const dataTransfer = {
    effectAllowed: "",
    dropEffect: "",
    setData(type, value) { values.set(type, value); },
    getData(type) { return values.get(type) || ""; },
  };

  first.dispatchEvent({ type: "dragstart", bubbles: true, dataTransfer });
  third.dispatchEvent({ type: "dragover", bubbles: true, dataTransfer });
  third.dispatchEvent({ type: "drop", bubbles: true, dataTransfer });
  first.dispatchEvent({ type: "dragend", bubbles: true, dataTransfer });

  assert.equal(dataTransfer.effectAllowed, "move");
  assert.equal(dataTransfer.dropEffect, "move");
  assert.deepEqual(reorders, [["one", "three"]]);
  assert.equal(elements.tabList.children[1].classList.contains("is-selected"), true);
});

test("windowTitle identifies the active document and dirty state", () => {
  assert.equal(windowTitle(doc("one", { displayName: "notes.md" })), "notes.md — MDedit");
  assert.equal(windowTitle(doc("one", { displayName: "notes.md", dirty: true })), "notes.md * — MDedit");
  assert.equal(windowTitle(null), "MDedit");
});

test("editors stay independently mounted while activation only changes visibility", () => {
  const { elements, view } = makeFixture();
  view.renderTabs([doc("one"), doc("two")], "one");
  const one = view.ensureEditor(doc("one", { content: "first" }));
  const two = view.ensureEditor(doc("two", { content: "second" }));
  one.value = "locally edited";
  one.setSelectionRange(2, 5);
  one.scrollTop = 11;

  view.activateEditor("two");

  assert.equal(elements.editorSurfaces.children.length, 2);
  assert.equal(one.value, "locally edited");
  assert.equal(view.editorFor("one"), one);
  assert.equal(view.editorFor("two"), two);
  assert.equal(one.parentNode.classList.contains("is-inactive"), true);
  assert.equal(one.parentNode.getAttribute("aria-hidden"), "true");
  assert.equal(one.getAttribute("tabindex"), "-1");
  assert.equal(two.parentNode.classList.contains("is-inactive"), false);
  assert.equal(two.parentNode.getAttribute("aria-hidden"), "false");
  assert.equal(two.getAttribute("tabindex"), "0");
  const firstTab = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  const secondTab = find(elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  assert.equal(firstTab.getAttribute("aria-selected"), "false");
  assert.equal(firstTab.getAttribute("tabindex"), "-1");
  assert.equal(secondTab.getAttribute("aria-selected"), "true");
  assert.equal(secondTab.getAttribute("tabindex"), "0");
  assert.equal(one.getAttribute("data-document-id"), "one");
  assert.equal(two.getAttribute("data-document-id"), "two");
});

test("selection-only tab renders update only the outgoing and incoming controls", () => {
  const { elements, view } = makeFixture();
  const documents = [doc("one"), doc("two"), doc("three")];
  view.renderTabs(documents, "one");
  const names = elements.tabList.children.map((shell) => (
    find(shell, (element) => element.classList.contains("document-tab-name"))
  ));
  const writes = names.map((name) => name.textContentWrites);

  view.renderTabs(documents, "two");

  assert.deepEqual(names.map((name) => name.textContentWrites), writes);
  const firstTab = find(elements.tabList.children[0], (element) => element.getAttribute("role") === "tab");
  const secondTab = find(elements.tabList.children[1], (element) => element.getAttribute("role") === "tab");
  assert.equal(firstTab.getAttribute("aria-selected"), "false");
  assert.equal(secondTab.getAttribute("aria-selected"), "true");
});

test("ensureEditor synchronizes genuine model changes without rereading unchanged textarea content", () => {
  const { view } = makeFixture();
  const editor = view.ensureEditor(doc("one", { content: "first" }));
  let storedValue = editor.value;
  let reads = 0;
  Object.defineProperty(editor, "value", {
    configurable: true,
    get() { reads += 1; return storedValue; },
    set(value) { storedValue = value; },
  });

  view.ensureEditor(doc("one", { content: "first" }));
  assert.equal(reads, 0);
  view.captureWorkspace("one");
  assert.equal(reads, 0);
  view.ensureEditor(doc("one", { content: "replaced" }));
  assert.equal(reads, 0);
  assert.equal(storedValue, "replaced");
});

test("managed editors hide the legacy bootstrap surface and lifecycle restores it alone", () => {
  const { elements, legacy, view } = makeFixture({}, { legacy: true });
  assert.equal(legacy.surface.hidden, false);
  const first = view.ensureEditor(doc("one"));
  view.activateEditor("one");
  assert.equal(legacy.surface.hidden, true);
  assert.equal(first.parentNode.classList.contains("is-inactive"), false);

  assert.equal(view.removeEditor("one"), true);
  assert.equal(legacy.surface.hidden, false);
  const second = view.ensureEditor(doc("two"));
  view.activateEditor("two");
  view.dispose();
  assert.equal(second.parentNode.parentNode, null);
  assert.equal(elements.editorSurfaces.children.length, 1);
  assert.equal(legacy.surface.hidden, false);
});

test("captureWorkspace and applyWorkspace clamp state and focus the active editor", () => {
  const { document, view } = makeFixture();
  const editor = view.ensureEditor(doc("one", { content: "abcd" }));
  view.activateEditor("one");
  view.applyWorkspace("one", { selectionStart: -3, selectionEnd: 99, editorScrollTop: -8 });

  assert.deepEqual(view.captureWorkspace("one"), {
    selectionStart: 0,
    selectionEnd: 4,
    editorScrollTop: 0,
  });
  assert.equal(view.focusActiveEditor(), true);
  assert.equal(document.activeElement, editor);
  assert.equal(view.applyWorkspace("absent", {}), false);
});

test("workspace adapters capture and apply shared preview, view, TOC, and find state", () => {
  const applied = [];
  let editor;
  const shared = {
    previewScrollTop: 41,
    viewMode: "split",
    tocOpen: true,
    find: { open: true, query: "needle", replacement: "thread", matchIndex: 2 },
  };
  const { view } = makeFixture({
    captureSharedWorkspace: () => shared,
    applySharedWorkspace: (workspace) => {
      applied.push(workspace);
      // A real view-mode change can make the textarea non-rendered and reset its
      // native scroll position. Editor state must be restored after that change.
      if (editor) editor.scrollTop = 0;
    },
  });
  editor = view.ensureEditor(doc("one", { content: "abcd" }));
  editor.setSelectionRange(1, 3);
  editor.scrollTop = 12;
  view.activateEditor("one");

  const captured = view.captureWorkspace("one");
  shared.find.query = "mutated";
  shared.viewMode = "preview";
  captured.viewMode = "preview";
  view.applyWorkspace("one", captured);

  assert.equal(captured.previewScrollTop, 41);
  assert.equal(captured.find.query, "needle");
  assert.equal(applied.length, 1);
  assert.notEqual(applied[0], captured);
  assert.notEqual(applied[0].find, captured.find);
  assert.equal(applied[0].find.query, "needle");
  assert.equal(editor.scrollTop, 12);

  editor.scrollTop = 0;
  const hiddenCapture = view.captureWorkspace("one");
  assert.equal(hiddenCapture.viewMode, "preview");
  assert.equal(hiddenCapture.editorScrollTop, 12);
});

test("delegated tab, close, add, and keyboard events emit intents without mutating models", () => {
  const calls = [];
  const one = doc("one");
  const two = doc("two");
  const { elements, view } = makeFixture({
    onActivate: (id) => calls.push(["activate", id]),
    onClose: (id) => calls.push(["close", id]),
    onAdd: () => calls.push(["add"]),
  });
  view.renderTabs([one, two], "one");
  const secondTab = find(elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  const firstClose = find(elements.tabList.children[0], (el) => el.getAttribute("data-action") === "close");

  secondTab.dispatchEvent({ type: "click", bubbles: true });
  firstClose.dispatchEvent({ type: "click", bubbles: true });
  elements.addButton.dispatchEvent({ type: "click" });
  secondTab.dispatchEvent({ type: "keydown", key: "Home", bubbles: true });

  assert.deepEqual(calls, [
    ["activate", "two"],
    ["close", "one"],
    ["add"],
    ["activate", "one"],
  ]);
  assert.equal(one.dirty, false);
  assert.equal(two.dirty, false);
});

test("tab-strip shortcuts emit one command and prevent browser handling", () => {
  const calls = [];
  const { elements, view } = makeFixture({
    onCommand: (command, event) => calls.push([command, event.key]),
  });
  view.renderTabs([doc("one"), doc("two")], "one");
  const first = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");

  const next = { type: "keydown", key: "Tab", ctrlKey: true, bubbles: true };
  first.dispatchEvent(next);
  const move = { type: "keydown", key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true };
  first.dispatchEvent(move);
  const close = { type: "keydown", key: "w", ctrlKey: true, bubbles: true };
  first.dispatchEvent(close);
  const repeatedNext = { type: "keydown", key: "Tab", ctrlKey: true, repeat: true, bubbles: true };
  first.dispatchEvent(repeatedNext);

  assert.deepEqual(calls, [
    ["next-tab", "Tab"],
    ["move-tab-right", "ArrowRight"],
    ["close-tab", "w"],
  ]);
  for (const event of [next, move, close, repeatedNext]) {
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
});

test("mac tab-strip close is Meta-only and repeated commands remain unhandled", () => {
  const calls = [];
  const { elements, view } = makeFixture({
    isMac: true,
    onCommand: (command) => calls.push(command),
  });
  view.renderTabs([doc("one")], "one");
  const tab = find(elements.tabList.children[0], (element) => element.getAttribute("role") === "tab");
  const control = { type: "keydown", key: "w", ctrlKey: true, bubbles: true };
  const command = { type: "keydown", key: "w", metaKey: true, bubbles: true };
  const repeat = { type: "keydown", key: "w", metaKey: true, repeat: true, bubbles: true };

  tab.dispatchEvent(control);
  tab.dispatchEvent(command);
  tab.dispatchEvent(repeat);

  assert.deepEqual(calls, ["close-tab"]);
  assert.equal(control.defaultPrevented, undefined);
  assert.equal(command.defaultPrevented, true);
  assert.equal(repeat.defaultPrevented, true);
  assert.equal(repeat.propagationStopped, true);
});

test("active, close, dirty, conflict, and recovery announcements share the live region without duplicates", () => {
  const { elements, view } = makeFixture();
  const documents = [doc("one", { displayName: "One.md" }), doc("two", { displayName: "Two.md" })];
  view.renderTabs(documents, "two");

  view.announceActiveDocument(documents[1], documents);
  assert.equal(elements.statusElement.textContent, "Two.md, tab 2 of 2");
  const activeWrites = elements.statusElement.textContentWrites;
  view.announceActiveDocument(documents[1], documents);
  assert.equal(elements.statusElement.textContentWrites, activeWrites);

  view.setDocumentStatus("two", { dirty: true, fileStatus: "normal" });
  assert.equal(elements.statusElement.textContent, "Two.md: Unsaved changes");
  view.setDocumentStatus("two", { dirty: true, fileStatus: "externally-changed" });
  assert.equal(elements.statusElement.textContent, "Two.md: File changed outside MDedit; Unsaved changes");
  view.setDocumentStatus("two", { recoveryStatus: "failed", message: "Recovery write failed" });
  assert.equal(elements.statusElement.textContent, "Two.md: File changed outside MDedit; Unsaved changes; Recovery write failed");

  view.announceCloseOutcome({ closed: true }, "One.md");
  assert.equal(elements.statusElement.textContent, "Closed One.md");
});

test("identical consecutive close outcomes produce distinct live-region updates", async () => {
  const { elements, view } = makeFixture();
  view.announceCloseOutcome({ closed: true }, "same.md");
  const firstWrites = elements.statusElement.textContentWrites;

  assert.equal(view.announceCloseOutcome({ closed: true }, "same.md"), true);
  assert.ok(elements.statusElement.textContentWrites > firstWrites);
  await Promise.resolve();
  assert.equal(elements.statusElement.textContent, "Closed same.md");
  assert.ok(elements.statusElement.textContentWrites >= firstWrites + 2);
});

test("controller-shaped status payloads announce combined layers and omit clean recovery noise", () => {
  const { elements, view } = makeFixture();
  view.renderTabs([doc("a", { displayName: "a.md" })], "a");

  view.setDocumentStatus("a", {
    dirty: true,
    fileStatus: "normal",
    recoveryStatus: "pending",
  });
  assert.equal(elements.statusElement.textContent, "a.md: Unsaved changes; Recovery pending");
  const status = find(elements.tabList.children[0], (element) => element.classList.contains("document-tab-status"));
  assert.equal(status.textContent, "Unsaved changes; Recovery pending");

  view.setDocumentStatus("a", {
    dirty: true,
    fileStatus: "externally-changed",
    recoveryStatus: "clean",
  });
  assert.equal(elements.statusElement.textContent, "a.md: File changed outside MDedit; Unsaved changes");
  assert.equal(status.textContent, "File changed outside MDedit; Unsaved changes");
  assert.doesNotMatch(elements.statusElement.textContent, /Recovery is current/);

  const writes = elements.statusElement.textContentWrites;
  view.setDocumentStatus("a", {
    dirty: false,
    fileStatus: "normal",
    recoveryStatus: "clean",
  });
  assert.equal(elements.statusElement.textContentWrites, writes);
});

test("renderTabs preserves control focus and scrolls the focused or active tab into view", () => {
  const { document, elements, view } = makeFixture();
  const documents = [doc("one"), doc("two")];
  view.renderTabs(documents, "one");
  const oldClose = find(elements.tabList.children[1], (el) => el.getAttribute("data-action") === "close");
  oldClose.focus();

  view.renderTabs(documents, "one");
  const newClose = find(elements.tabList.children[1], (el) => el.getAttribute("data-action") === "close");
  const focusedTab = find(elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  assert.equal(document.activeElement, newClose);
  assert.equal(focusedTab.scrollIntoViewCalls.length, 1);
  assert.deepEqual(focusedTab.scrollIntoViewCalls[0], { block: "nearest", inline: "nearest" });
});

test("keyboard activation keeps focus after a synchronous controller rerender", () => {
  const documents = [doc("one"), doc("two"), doc("three")];
  let view;
  const fixture = makeFixture({
    onActivate(id) { view.renderTabs(documents, id); },
  });
  view = fixture.view;
  view.renderTabs(documents, "one");
  const first = find(fixture.elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  first.focus();
  first.dispatchEvent({ type: "keydown", key: "End", bubbles: true });

  const last = find(fixture.elements.tabList.children[2], (el) => el.getAttribute("role") === "tab");
  assert.equal(fixture.document.activeElement, last);
  assert.equal(last.getAttribute("aria-selected"), "true");
  assert.equal(last.scrollIntoViewCalls.length, 1);
});

test("WorkspaceView keyboard navigation through SessionController keeps tab focus across frames", () => {
  const frames = [];
  let controller;
  const fixture = makeFixture({
    onActivate(id, options) { controller.activateDocument(id, options); },
  });
  fixture.view.renderSession = (session) => fixture.view.renderTabs(session, session.activeDocumentId);
  fixture.view.renderDocument = () => {};
  controller = new SessionController({
    io: {
      listenFileOpened() { return () => {}; },
      async loadRecoveryManifest() { return null; },
      async loadRecoveryDocument() { return null; },
      async writeRecoveryManifest() {},
      async recoveryDirectory() { return "memory"; },
    },
    scheduler: { changed() { return true; }, async flush() {} },
    view: fixture.view,
    dialogs: {},
    legacyStorage: { getItem() { return null; }, removeItem() {} },
    hashText: async (text) => `sha:${text}`,
    idFactory: (() => { let id = 0; return () => `doc-${++id}`; })(),
    requestAnimationFrame(callback) { frames.push(callback); },
  });
  const firstDocument = controller.createUntitled();
  controller.createUntitled();
  controller.createUntitled();
  frames.splice(0).forEach((callback) => callback());
  controller.activateDocument(firstDocument.id, { focusEditor: false });
  frames.splice(0).forEach((callback) => callback());

  let selected = find(fixture.elements.tabList.children[0], (element) => element.getAttribute("role") === "tab");
  selected.focus();
  selected.dispatchEvent({ type: "keydown", key: "ArrowRight", bubbles: true });
  frames.splice(0).forEach((callback) => callback());
  selected = find(fixture.elements.tabList.children[1], (element) => element.getAttribute("role") === "tab");
  assert.equal(fixture.document.activeElement, selected);

  selected.dispatchEvent({ type: "keydown", key: "ArrowRight", bubbles: true });
  frames.splice(0).forEach((callback) => callback());
  selected = find(fixture.elements.tabList.children[2], (element) => element.getAttribute("role") === "tab");
  assert.equal(fixture.document.activeElement, selected);
});

test("Ctrl+Tab through SessionController moves tab-strip focus to the newly active tab", () => {
  const frames = [];
  let controller;
  const fixture = makeFixture({
    onCommand(command, event) {
      const delta = command === "next-tab" ? 1 : -1;
      controller.activateAdjacentDocument(delta, { focusEditor: false, preserveTabFocus: true });
    },
  });
  fixture.view.renderSession = (session) => fixture.view.renderTabs(session, session.activeDocumentId);
  fixture.view.renderDocument = () => {};
  controller = new SessionController({
    io: {
      listenFileOpened() { return () => {}; },
      async loadRecoveryManifest() { return null; },
      async loadRecoveryDocument() { return null; },
      async writeRecoveryManifest() {},
      async recoveryDirectory() { return "memory"; },
    },
    scheduler: { changed() { return true; }, async flush() {} },
    view: fixture.view,
    dialogs: {},
    legacyStorage: { getItem() { return null; }, removeItem() {} },
    hashText: async (text) => `sha:${text}`,
    idFactory: (() => { let id = 0; return () => `doc-${++id}`; })(),
    requestAnimationFrame(callback) { frames.push(callback); },
  });
  controller.createUntitled();
  controller.createUntitled();
  frames.splice(0).forEach((callback) => callback());
  controller.activateDocument("doc-1", { focusEditor: false });
  frames.splice(0).forEach((callback) => callback());
  const first = find(fixture.elements.tabList.children[0], (element) => element.getAttribute("role") === "tab");
  first.focus();

  first.dispatchEvent({ type: "keydown", key: "Tab", ctrlKey: true, bubbles: true });
  frames.splice(0).forEach((callback) => callback());

  const second = find(fixture.elements.tabList.children[1], (element) => element.getAttribute("role") === "tab");
  assert.equal(controller.activeDocument().id, "doc-2");
  assert.equal(fixture.document.activeElement, second);
  assert.equal(second.getAttribute("tabindex"), "0");
});

test("closing a focused tab restores focus to the active neighbor and never steals outside focus", () => {
  let documents = [doc("one"), doc("two"), doc("three")];
  let view;
  const fixture = makeFixture({
    onClose(id) {
      documents = documents.filter((document) => document.id !== id);
      view.renderTabs(documents, id === "two" ? "three" : null);
    },
  });
  view = fixture.view;
  view.renderTabs(documents, "two");
  const close = find(fixture.elements.tabList.children[1], (el) => el.getAttribute("data-action") === "close");
  close.focus();
  close.dispatchEvent({ type: "click", bubbles: true });

  const neighbor = find(fixture.elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  assert.equal(neighbor.getAttribute("data-document-id"), "three");
  assert.equal(fixture.document.activeElement, neighbor);
  assert.equal(neighbor.scrollIntoViewCalls.length, 1);

  const outside = fixture.document.createElement("button");
  fixture.document.body.appendChild(outside);
  outside.focus();
  view.renderTabs(documents, "three");
  assert.equal(fixture.document.activeElement, outside);
});

test("closing the final focused tab moves focus to the add control", () => {
  let view;
  const fixture = makeFixture({ onClose() { view.renderTabs([], null); } });
  view = fixture.view;
  view.renderTabs([doc("only")], "only");
  const close = find(fixture.elements.tabList.children[0], (el) => el.getAttribute("data-action") === "close");
  close.focus();
  close.dispatchEvent({ type: "click", bubbles: true });
  assert.equal(fixture.document.activeElement, fixture.elements.addButton);
});

test("tablist focus falls forward to the selected tab after a rebuild", () => {
  const fixture = makeFixture();
  const documents = [doc("one"), doc("two")];
  fixture.view.renderTabs(documents, "one");
  fixture.elements.tabList.focus();
  fixture.view.renderTabs(documents, "two");
  const selected = find(fixture.elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  assert.equal(fixture.document.activeElement, selected);
});

test("showDialog safely renders text, awaits actions, closes, and restores focus", async () => {
  const action = [];
  const { document, elements, view } = makeFixture();
  const before = document.createElement("button");
  document.body.appendChild(before);
  before.focus();

  const result = view.showDialog({
    title: "Resolve <conflict>",
    message: "Choose without <script> markup",
    documents: ['<img src=x onerror="boom">'],
    actions: [{
      id: "keep",
      label: "Keep mine",
      primary: true,
      callback: async () => {
        await Promise.resolve();
        action.push("kept");
        return "callback-result";
      },
    }],
  });

  assert.equal(elements.dialog.hidden, false);
  assert.equal(elements.dialogBackdrop.hidden, false);
  assert.equal(elements.dialogTitle.textContent, "Resolve <conflict>");
  assert.equal(elements.dialogMessage.textContent, "Choose without <script> markup");
  assert.equal(elements.dialogDocuments.children[0].textContent, '<img src=x onerror="boom">');
  assert.equal(document.activeElement, elements.dialogActions.children[0]);

  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  assert.equal(await result, "callback-result");
  assert.deepEqual(action, ["kept"]);
  assert.equal(elements.dialog.hidden, true);
  assert.equal(elements.dialogBackdrop.hidden, true);
  assert.equal(document.activeElement, before);
});

test("Escape closes a dialog and status updates affect only the target document", async () => {
  const { document, elements, view } = makeFixture();
  view.renderTabs([doc("one"), doc("two")], "one");
  view.setDocumentStatus("two", { dirty: true, fileStatus: "normal" });

  const firstStatus = find(elements.tabList.children[0], (el) => el.classList.contains("document-tab-status"));
  const secondStatus = find(elements.tabList.children[1], (el) => el.classList.contains("document-tab-status"));
  assert.equal(firstStatus.textContent, "");
  assert.equal(secondStatus.textContent, "Unsaved changes");
  assert.equal(elements.tabList.children[0].classList.contains("is-dirty"), false);
  assert.equal(elements.tabList.children[1].classList.contains("is-dirty"), true);

  const result = view.showDialog({ title: "Question", message: "Cancel?", actions: [] });
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(await result, null);
  assert.equal(elements.dialog.hidden, true);
});

test("showDialog cannot replace a dialog with an action in flight", async () => {
  const pending = deferred();
  const { elements, view } = makeFixture();
  const first = view.showDialog({
    title: "First",
    actions: [{ id: "wait", label: "Wait", callback: () => pending.promise }],
  });
  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });

  const second = view.showDialog({ title: "Second", actions: [] });
  assert.equal(second, first);
  assert.equal(elements.dialogTitle.textContent, "First");
  pending.resolve("old result");
  assert.equal(await second, "old result");
});

test("a busy dialog ignores Escape and backdrop cancellation until its action settles", async () => {
  const pending = deferred();
  const { document, elements, view } = makeFixture();
  const result = view.showDialog({
    title: "Saving",
    actions: [{ id: "save", label: "Save", callback: () => pending.promise }],
  });
  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  assert.equal(elements.dialog.getAttribute("aria-busy"), "true");
  assert.equal(elements.dialogActions.getAttribute("aria-busy"), "true");
  assert.equal(elements.dialogActions.children[0].disabled, true);

  document.dispatchEvent({ type: "keydown", key: "Escape" });
  elements.dialogBackdrop.dispatchEvent({ type: "click" });
  assert.equal(elements.dialog.hidden, false);
  assert.equal(await Promise.race([result.then(() => "settled"), Promise.resolve("pending")]), "pending");

  pending.resolve("saved");
  assert.equal(await result, "saved");
  assert.equal(elements.dialog.hidden, true);
});

test("a non-cancelable dialog ignores Escape and exposes its document list label", async () => {
  const { document, elements, view } = makeFixture();
  const result = view.showDialog({
    title: "Closing",
    documents: ["alpha.md", "beta.md"],
    documentLabel: "Documents with unsaved changes",
    cancelable: false,
    actions: [{ id: "continue", label: "Continue" }],
  });

  assert.equal(elements.dialogDocuments.getAttribute("aria-label"), "Documents with unsaved changes");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  elements.dialogBackdrop.dispatchEvent({ type: "click" });
  assert.equal(elements.dialog.hidden, false);

  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  assert.equal(await result, "continue");
});

test("a rejected dialog action re-enables the dialog and can be retried", async () => {
  let attempts = 0;
  const { elements, view } = makeFixture();
  const result = view.showDialog({
    title: "Retry",
    message: "Original message",
    actions: [{
      id: "retry",
      label: "Retry",
      callback: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Disk unavailable");
        return "recovered";
      },
    }],
  });
  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(elements.dialog.hidden, false);
  assert.equal(elements.dialogActions.children[0].disabled, false);
  assert.equal(elements.dialog.getAttribute("aria-busy"), null);
  assert.equal(elements.dialogMessage.textContent, "Disk unavailable");

  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  assert.equal(await result, "recovered");
});

test("dispose force-closes a busy dialog once and ignores its late rejection", async () => {
  const pending = deferred();
  const { document, elements, view } = makeFixture();
  const result = view.showDialog({
    title: "Working",
    actions: [{ id: "work", label: "Work", callback: () => pending.promise }],
  });
  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });
  view.dispose();

  assert.equal(await result, null);
  assert.equal(elements.dialog.hidden, true);
  assert.equal(elements.dialogBackdrop.hidden, true);
  assert.equal(elements.dialog.getAttribute("aria-busy"), null);
  assert.equal(elements.dialogActions.getAttribute("aria-busy"), null);
  assert.equal(elements.dialogActions.children[0].disabled, false);
  assert.equal((elements.dialogActions.listeners.get("click") || []).length, 0);
  assert.equal((document.listeners.get("keydown") || []).length, 0);

  pending.reject(new Error("late failure"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(elements.dialog.hidden, true);
  assert.equal(elements.dialogMessage.textContent, "");
});

test("recovery status layers over dirty and conflict state and survives tab rerenders", () => {
  const documents = [doc("one", { dirty: true, fileStatus: "externally-changed" }), doc("two")];
  const { elements, view } = makeFixture();
  view.renderTabs(documents, "one");
  view.setDocumentStatus("one", "pending");
  let firstStatus = find(elements.tabList.children[0], (el) => el.classList.contains("document-tab-status"));
  assert.match(firstStatus.textContent, /File changed outside MDedit; Unsaved changes/);
  assert.match(firstStatus.textContent, /Recovery pending/);

  view.setDocumentStatus("one", { recoveryStatus: "failed", message: "Recovery write failed" });
  const badge = find(elements.tabList.children[0], (el) => el.classList.contains("document-tab-recovery"));
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "Recovery write failed");
  assert.equal(elements.tabList.children[0].classList.contains("recovery-failed"), true);

  view.setDocumentStatus("one", "clean");
  firstStatus = find(elements.tabList.children[0], (el) => el.classList.contains("document-tab-status"));
  assert.equal(firstStatus.textContent, "File changed outside MDedit; Unsaved changes");
  assert.equal(elements.tabList.children[0].classList.contains("is-conflict"), true);
  assert.equal(elements.tabList.children[0].classList.contains("is-dirty"), true);
  assert.equal(badge.hidden, true);

  view.setDocumentStatus("two", "writing");
  view.renderTabs(documents, "one");
  const secondStatus = find(elements.tabList.children[1], (el) => el.classList.contains("document-tab-status"));
  assert.match(secondStatus.textContent, /Saving recovery/);
});

test("one full status object merges document state, recovery state, and live announcement", () => {
  const { elements, view } = makeFixture();
  view.renderTabs([doc("one")], "one");
  view.setDocumentStatus("one", {
    displayName: "Renamed.md",
    dirty: true,
    fileStatus: "externally-changed",
    recoveryStatus: "failed",
    message: "Recovery write failed",
  });

  const shell = elements.tabList.children[0];
  const name = find(shell, (el) => el.classList.contains("document-tab-name"));
  const status = find(shell, (el) => el.classList.contains("document-tab-status"));
  const recovery = find(shell, (el) => el.classList.contains("document-tab-recovery"));
  const close = find(shell, (el) => el.getAttribute("data-action") === "close");
  assert.equal(name.textContent, "Renamed.md");
  assert.equal(close.getAttribute("aria-label"), "Close Renamed.md");
  assert.equal(status.textContent, "File changed outside MDedit; Unsaved changes; Recovery write failed");
  assert.equal(recovery.textContent, "Recovery write failed");
  assert.equal(recovery.hidden, false);
  assert.equal(shell.classList.contains("is-dirty"), true);
  assert.equal(shell.classList.contains("is-conflict"), true);
  assert.equal(shell.classList.contains("recovery-failed"), true);
  assert.equal(elements.statusElement.textContent, "Renamed.md: File changed outside MDedit; Unsaved changes; Recovery write failed");

  view.setDocumentStatus("one", {
    displayName: "Renamed.md",
    dirty: true,
    fileStatus: "externally-changed",
    recoveryStatus: "clean",
  });
  assert.equal(status.textContent, "File changed outside MDedit; Unsaved changes");
  assert.equal(shell.classList.contains("is-dirty"), true);
  assert.equal(shell.classList.contains("is-conflict"), true);
  assert.equal(recovery.hidden, true);
  assert.equal(elements.statusElement.textContent, "Renamed.md: File changed outside MDedit; Unsaved changes");
  const writes = elements.statusElement.textContentWrites;
  view.setDocumentStatus("one", {
    displayName: "Renamed.md",
    dirty: true,
    fileStatus: "externally-changed",
    recoveryStatus: "clean",
  });
  assert.equal(elements.statusElement.textContentWrites, writes);
});

test("removeEditor and dispose clean up mounted surfaces and listeners", () => {
  let activations = 0;
  const { elements, view } = makeFixture({ onActivate: () => { activations += 1; } });
  view.renderTabs([doc("one")], "one");
  view.ensureEditor(doc("one"));
  assert.equal(view.removeEditor("one"), true);
  assert.equal(view.editorFor("one"), null);
  assert.equal(elements.editorSurfaces.children.length, 0);

  const tab = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  view.dispose();
  tab.dispatchEvent({ type: "click", bubbles: true });
  assert.equal(activations, 0);
});

test("template provides the accessible tab strip, editor host, and dialog contract", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "src", "index.template.html"), "utf8");
  assert.match(template, /<\/header>\s*<div id="document-tabs-wrap">/);
  assert.match(template, /id="document-tabs" role="tablist" aria-label="Open documents"/);
  assert.match(template, /id="btn-add-tab"[^>]*aria-label="New document"[^>]*title="New document"/);
  assert.match(template, /id="btn-save-all"[^>]*>Save All<\/button>/);
  assert.match(template, /id="editor-surfaces"[\s\S]*?<textarea id="editor"/);
  assert.match(template, /id="dialog-backdrop"[^>]*hidden/);
  assert.match(template, /<section id="app-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>/);
  for (const id of [
    "dialog-title", "dialog-message", "dialog-documents", "dialog-actions",
  ]) assert.match(template, new RegExp(`id="${id}"`));
  assert.match(template, /#document-tabs-wrap\s*\{[^}]*height:\s*36px/s);
  assert.match(template, /\.document-tab-close\s*\{[^}]*min-width:\s*32px[^}]*min-height:\s*32px/s);
  assert.match(template, /#editor-surfaces\s*\{[^}]*position:\s*relative/);
  assert.match(template, /\.editor-surface\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
  assert.match(template, /\.editor-surface\s*\{[^}]*z-index:\s*1/);
  assert.match(template, /\.editor-surface\.is-inactive\s*\{[^}]*z-index:\s*0[^}]*pointer-events:\s*none/);
  assert.match(template, /<span id="status" role="status" aria-live="polite"><\/span>/);
  assert.match(template, /<input type="file" id="file-input"[^>]*\bmultiple\b/);
  assert.match(template, /function shortcutFocusOptions\(event\)[\s\S]*focusEditor: isActiveEditorEvent\(event\)[\s\S]*preserveTabFocus: tabFocused/);
  assert.match(template, /function scheduleActiveDocumentStats\(documentId, content\)[\s\S]*requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) =>/);
  assert.match(template, /function syncActiveSurface\(\)[\s\S]*scheduleActiveDocumentStats\(active\.id, active\.content\)/);
  assert.match(template, /\$\("editor-surfaces"\)\.addEventListener\("keydown", \(e\) => \{[\s\S]*const command = keyboardCommand\(e\);[\s\S]*e\.stopPropagation\(\);[\s\S]*if \(e\.key !== "Tab"/);
  assert.match(template, /const items = Array\.from\(\(e\.dataTransfer && e\.dataTransfer\.items\)[\s\S]*for \(const item of items\)[\s\S]*files\.push\(file\)[\s\S]*await openBrowserFiles\(files, handles\)/);
  assert.match(template, /else \{\s*for \(const file of \(e\.dataTransfer && e\.dataTransfer\.files\) \|\| \[\]\)/);
  assert.doesNotMatch(template, /Promise\.all\([^)]*(?:getFile|\.text\()/);
});

test("template and builder keep application modules in dependency order", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "src", "index.template.html"), "utf8");
  const build = fs.readFileSync(path.join(__dirname, "..", "build.sh"), "utf8");
  const markers = [
    "/*__DOCUMENT_MODEL__*/",
    "/*__SESSION_MODEL__*/",
    "/*__RECOVERY_SCHEDULER__*/",
    "/*__SESSION_CONTROLLER__*/",
    "/*__WORKSPACE_VIEW__*/",
    "/*__NATIVE_BRIDGE__*/",
  ];
  let previous = -1;
  for (const marker of markers) {
    assert.equal(template.split(marker).length - 1, 1, `${marker} appears once`);
    assert.ok(template.indexOf(marker) > previous, `${marker} follows its dependencies`);
    assert.ok(build.includes(`"${marker}"`), `${marker} has a build mapping`);
    previous = template.indexOf(marker);
  }
  assert.match(build, /doc\.count\(marker\) != 1/);
});
