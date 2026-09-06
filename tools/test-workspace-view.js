const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  WorkspaceView,
  captureEditorState,
  tabDescriptor,
} = require("../src/workspace-view.js");

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
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = "";
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
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

function makeFixture(callbacks = {}) {
  const document = new FakeDocument();
  const elements = {};
  for (const name of [
    "tabList", "addButton", "editorSurfaces", "dialogBackdrop", "dialog",
    "dialogTitle", "dialogMessage", "dialogDocuments", "dialogActions",
  ]) elements[name] = document.createElement(name === "dialog" ? "section" : "div");
  elements.dialog.hidden = true;
  elements.dialogBackdrop.hidden = true;
  Object.values(elements).forEach((element) => document.body.appendChild(element));
  const view = new WorkspaceView({ document, ...elements, ...callbacks });
  return { document, elements, view };
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
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("browser wrapper merges workspace exports into window.MDEdit", () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "workspace-view.js"), "utf8");
  const sandbox = { window: { MDEdit: {} }, Promise };

  vm.runInNewContext(code, sandbox, { filename: "workspace-view.js" });

  assert.equal(typeof sandbox.window.MDEdit.WorkspaceView, "function");
  assert.equal(typeof sandbox.window.MDEdit.tabDescriptor, "function");
  assert.equal(typeof sandbox.window.MDEdit.captureEditorState, "function");
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
    selectionStart: 0,
    selectionEnd: 0,
    editorScrollTop: 7,
  });
  assert.deepEqual(captureEditorState(null), {
    selectionStart: 0,
    selectionEnd: 0,
    editorScrollTop: 0,
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
  assert.equal(secondTab.getAttribute("aria-selected"), "true");
  assert.equal(secondTab.getAttribute("tabindex"), "0");
  assert.equal(firstClose.getAttribute("aria-label"), 'Close <img src=x onerror="boom">');
  assert.equal(status.textContent, "Unsaved changes");
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
  assert.equal(one.parentNode.hidden, true);
  assert.equal(two.parentNode.hidden, false);
  const firstTab = find(elements.tabList.children[0], (el) => el.getAttribute("role") === "tab");
  const secondTab = find(elements.tabList.children[1], (el) => el.getAttribute("role") === "tab");
  assert.equal(firstTab.getAttribute("aria-selected"), "false");
  assert.equal(firstTab.getAttribute("tabindex"), "-1");
  assert.equal(secondTab.getAttribute("aria-selected"), "true");
  assert.equal(secondTab.getAttribute("tabindex"), "0");
  assert.equal(one.getAttribute("data-document-id"), "one");
  assert.equal(two.getAttribute("data-document-id"), "two");
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

test("a stale asynchronous dialog action cannot close its replacement", async () => {
  const pending = deferred();
  const { document, elements, view } = makeFixture();
  const first = view.showDialog({
    title: "First",
    actions: [{ id: "wait", label: "Wait", callback: () => pending.promise }],
  });
  elements.dialogActions.children[0].dispatchEvent({ type: "click", bubbles: true });

  const second = view.showDialog({ title: "Second", actions: [] });
  assert.equal(await first, null);
  pending.resolve("old result");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(elements.dialog.hidden, false);
  assert.equal(elements.dialogTitle.textContent, "Second");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(await second, null);
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
  assert.match(template, /id="btn-add-document"[^>]*aria-label="Add document"/);
  assert.match(template, /id="editor-surfaces"[\s\S]*?<textarea id="editor"/);
  assert.match(template, /id="workspace-dialog-backdrop"[^>]*hidden/);
  assert.match(template, /<section id="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title" hidden>/);
  for (const id of [
    "workspace-dialog-title", "workspace-dialog-message", "workspace-dialog-documents", "workspace-dialog-actions",
  ]) assert.match(template, new RegExp(`id="${id}"`));
  assert.match(template, /#document-tabs-wrap\s*\{[^}]*height:\s*36px/s);
  assert.match(template, /\.document-tab-close\s*\{[^}]*min-width:\s*32px[^}]*min-height:\s*32px/s);
  assert.match(template, /\.editor-surface\[hidden\]\s*\{\s*display:\s*none/);
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
