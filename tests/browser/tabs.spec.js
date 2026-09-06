const { test, expect } = require("@playwright/test");
const { activeEditor, installFakeTauri, openEditor } = require("./helpers.js");

test("welcome appears only for a truly new session and restored blank content stays blank", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await expect(activeEditor(page)).toHaveValue(/# Welcome to MDedit/);

  const blankPage = await page.context().newPage();
  const workspace = {
    selectionStart: 0,
    selectionEnd: 0,
    editorScrollTop: 0,
    previewScrollTop: 0,
    viewMode: "edit",
    tocOpen: false,
    find: { open: false, query: "", replacement: "", matchIndex: -1 },
  };
  await installFakeTauri(blankPage, {
    recoveryManifest: JSON.stringify({
      schemaVersion: 1,
      generation: 4,
      activeDocumentId: "blank",
      nextUntitledNumber: 2,
      tabs: [{ documentId: "blank", displayName: "Untitled 1", snapshotRevision: 0 }],
    }),
    recoveryDocuments: {
      "blank:0": JSON.stringify({
        schemaVersion: 1,
        documentId: "blank",
        snapshotRevision: 0,
        editRevision: 0,
        displayName: "Untitled 1",
        path: null,
        canonicalPath: null,
        content: "",
        savedContentSha256: await page.evaluate(async () => {
          const bytes = new TextEncoder().encode("");
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        }),
        expectedDiskSha256: null,
        fileStatus: "normal",
        workspace,
      }),
    },
  });
  await openEditor(blankPage);

  await expect(activeEditor(blankPage)).toHaveValue("");
  await expect(blankPage.getByRole("tab", { name: /Untitled 1/ })).toHaveAttribute("aria-selected", "true");
  await expect(blankPage.locator("body")).toHaveAttribute("data-view", "edit");
  await expect(blankPage.locator(".dirty-dot")).not.toHaveClass(/on/);
});

test("tabs retain content, selection, view, and accessible state", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  const first = page.getByRole("tab", { name: /Untitled 1/ });
  const longContent = Array.from({ length: 300 }, (_, index) => `line ${index} has selectable text`).join("\n");
  await activeEditor(page).fill(longContent);
  await activeEditor(page).evaluate((editor) => {
    editor.setSelectionRange(6, 14);
    editor.scrollTop = 640;
  });
  const savedScrollTop = await activeEditor(page).evaluate((editor) => editor.scrollTop);
  expect(savedScrollTop).toBeGreaterThan(500);
  await expect(page.locator("#preview")).toContainText("line 299 has selectable text");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const firstId = await first.getAttribute("data-document-id");
  await expect.poll(() => page.evaluate((documentId) => window.__testBridge.calls.invokes.some((call) => {
    if (call.command !== "write_recovery_document" || call.args.documentId !== documentId) return false;
    return JSON.parse(call.args.json).workspace.viewMode === "edit";
  }), firstId)).toBe(true);

  await page.getByRole("button", { name: "New document" }).click();
  await activeEditor(page).fill("# second");
  await expect(page.locator("#preview")).toContainText("second");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const previewImmediatelyAfterEditOnlyActivation = await page.evaluate((documentId) => {
    const preview = document.querySelector("#preview");
    const before = preview.textContent;
    document.querySelector(`[role="tab"][data-document-id="${CSS.escape(documentId)}"]`).click();
    return {
      beforeHasSecond: before.includes("second"),
      beforeHasFirst: before.includes("line 299"),
      afterTextLength: preview.textContent.length,
      afterHasSecond: preview.textContent.includes("second"),
      afterHasFirst: preview.textContent.includes("line 299"),
      viewMode: document.body.dataset.view,
    };
  }, firstId);
  expect(previewImmediatelyAfterEditOnlyActivation).toMatchObject({
    beforeHasSecond: true,
    beforeHasFirst: false,
    afterTextLength: 0,
    afterHasSecond: false,
    afterHasFirst: false,
    viewMode: "edit",
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#preview")).toBeEmpty();

  const firstEditor = page.locator(`textarea[data-document-id="${firstId}"]`);
  await expect(firstEditor).toHaveValue(longContent);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(page.locator("body")).toHaveAttribute("data-view", "edit");
  await expect(first).toHaveAttribute("aria-controls", /document-panel-/);
  await expect.poll(() => firstEditor.evaluate((editor) => editor.scrollTop)).toBe(savedScrollTop);
  const state = await firstEditor.evaluate((editor) => ({
    start: editor.selectionStart,
    end: editor.selectionEnd,
    scrollTop: editor.scrollTop,
    panelHidden: editor.parentElement.hidden,
    panelRole: editor.parentElement.getAttribute("role"),
  }));
  expect(state).toMatchObject({ start: 6, end: 14, panelHidden: false, panelRole: "tabpanel" });
  expect(Math.abs(state.scrollTop - savedScrollTop)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-view", "preview");
  await expect(page.locator("#preview")).toContainText("line 299 has selectable text");
  await expect(page.locator("#preview")).not.toContainText("second");
});

test("dirty close and consolidated quit trap focus and preserve cancel", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await activeEditor(page).fill("dirty one");
  await page.getByRole("button", { name: /Close Untitled 1/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Untitled 1");
  const cancel = page.getByRole("button", { name: "Cancel" });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(activeEditor(page)).toHaveValue("dirty one");

  await page.getByRole("button", { name: "New document" }).click();
  await activeEditor(page).fill("dirty two");
  await page.evaluate(() => { window.__testBridge.requestClose(); });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Untitled 1");
  await expect(dialog).toContainText("Untitled 2");
  await expect(page.getByRole("button", { name: "Save All & Quit" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab")).toHaveCount(2);
  expect(await page.evaluate(() => window.__testBridge.calls.closeCalls)).toBe(0);
});

test("overflow keeps active tab and new-document button reachable", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  for (let index = 1; index < 30; index += 1) {
    await page.getByRole("button", { name: "New document" }).click();
  }
  const active = page.getByRole("tab", { name: /Untitled 30/ });
  await active.click();
  const boxes = await Promise.all([
    page.locator("#document-tabs-wrap").boundingBox(),
    page.locator("#document-tabs").boundingBox(),
    active.boundingBox(),
    page.getByRole("button", { name: "New document" }).boundingBox(),
  ]);
  const [wrap, strip, tab, add] = boxes;
  for (const box of boxes) expect(box).not.toBeNull();
  const intersects = (box, viewport) => box.x < viewport.x + viewport.width
    && box.x + box.width > viewport.x && box.y < viewport.y + viewport.height
    && box.y + box.height > viewport.y;
  expect(intersects(tab, strip)).toBe(true);
  expect(intersects(add, wrap)).toBe(true);
  await expect(active).toHaveAttribute("aria-selected", "true");
});

test("roving focus and shortcuts follow tab order", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("button", { name: "New document" }).click();
  const tab = (number) => page.getByRole("tab", { name: new RegExp(`Untitled ${number}`) });
  const labels = async () => page.getByRole("tab").evaluateAll((tabs) => tabs.map((item) => item.textContent.trim()));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await tab(3).focus();

  await page.keyboard.press("Control+Shift+Tab");
  await expect(tab(2)).toHaveAttribute("aria-selected", "true");
  await expect(tab(2)).toHaveAttribute("tabindex", "0");
  await expect(tab(2)).toBeFocused();

  await page.keyboard.press("Control+Tab");
  await expect(tab(3)).toHaveAttribute("aria-selected", "true");
  await expect(tab(3)).toBeFocused();

  await page.keyboard.press("Alt+Shift+ArrowLeft");
  expect((await labels()).join("|")).toMatch(/Untitled 1.*Untitled 3.*Untitled 2/);
  await expect(tab(3)).toHaveAttribute("tabindex", "0");
  await expect(tab(3)).toBeFocused();

  await page.keyboard.press("Alt+Shift+ArrowRight");
  expect((await labels()).join("|")).toMatch(/Untitled 1.*Untitled 2.*Untitled 3/);
  await page.keyboard.press("Control+w");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(tab(2)).toHaveAttribute("aria-selected", "true");
  await expect(tab(2)).toHaveAttribute("tabindex", "0");
  await expect(tab(2)).toBeFocused();
});

test("pointer drag reorders tabs, preserves the active document, and persists order", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByRole("button", { name: "New document" }).click();
  const first = page.getByRole("tab", { name: /Untitled 1/ });
  const second = page.getByRole("tab", { name: /Untitled 2/ });
  const third = page.getByRole("tab", { name: /Untitled 3/ });
  await second.click();

  await first.dragTo(third);

  await expect(second).toHaveAttribute("aria-selected", "true");
  expect(await page.getByRole("tab").allTextContents()).toEqual(expect.arrayContaining([
    expect.stringContaining("Untitled 2"),
    expect.stringContaining("Untitled 3"),
    expect.stringContaining("Untitled 1"),
  ]));
  const labels = await page.getByRole("tab").allTextContents();
  expect(labels.join("|")).toMatch(/Untitled 2.*Untitled 3.*Untitled 1/);
  await expect.poll(() => page.evaluate(() => window.__testBridge.calls.invokes
    .filter((call) => call.command === "write_recovery_manifest")
    .some((call) => JSON.parse(call.args.json).tabs.map((tab) => tab.displayName).join("|")
      .match(/Untitled 2.*Untitled 3.*Untitled 1/)))).toBe(true);
});

test("Save All saves every dirty document, announces the result, and does not quit", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/one.md", "/notes/two.md"],
    documents: {
      "/notes/one.md": { content: "one", sha256: "one-original" },
      "/notes/two.md": { content: "two", sha256: "two-original" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await activeEditor(page).fill("two edited");
  await page.getByRole("tab", { name: /one\.md/ }).click();
  await activeEditor(page).fill("one edited");

  await page.getByRole("button", { name: "Save All", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("Saved 2 documents");
  await expect(page.getByRole("button", { name: "Save All", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__testBridge.calls.saves.map((save) => save.path))).toEqual([
    "/notes/one.md", "/notes/two.md",
  ]);
  expect(await page.evaluate(() => window.__testBridge.calls.closeCalls)).toBe(0);
});

test("Save All stops at a conflict and names the document that remains dirty", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/one.md", "/notes/two.md"],
    documents: {
      "/notes/one.md": { content: "one", sha256: "one-original" },
      "/notes/two.md": { content: "two", sha256: "two-original" },
    },
    saveResults: {
      "/notes/two.md": { status: "conflict", actualSha256: "two-external" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await activeEditor(page).fill("two edited");
  await page.getByRole("tab", { name: /one\.md/ }).click();
  await activeEditor(page).fill("one edited");

  await page.getByRole("button", { name: "Save All", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("two.md");
  await page.getByRole("button", { name: "Keep Editing" }).click();

  await expect(page.getByRole("status")).toContainText("Save All stopped after 1 saved; 1 remain unsaved: two.md");
  await expect(page.getByRole("button", { name: "Save All", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__testBridge.calls.saves.map((save) => save.path))).toEqual([
    "/notes/one.md", "/notes/two.md",
  ]);
  expect(await page.evaluate(() => window.__testBridge.calls.closeCalls)).toBe(0);
});

test("window title follows active document, dirty state, and save", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/one.md", "/notes/two.md"],
    documents: {
      "/notes/one.md": { content: "one", sha256: "one-original" },
      "/notes/two.md": { content: "two", sha256: "two-original" },
    },
  });
  await openEditor(page);
  await expect(page).toHaveTitle("Untitled 1 — MDedit");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveTitle("two.md — MDedit");
  await activeEditor(page).fill("two edited");
  await expect(page).toHaveTitle("two.md * — MDedit");
  await page.getByRole("tab", { name: /one\.md/ }).click();
  await expect(page).toHaveTitle("one.md — MDedit");
  await page.getByRole("tab", { name: /two\.md/ }).click();
  await page.locator("#btn-save").click();
  await expect(page).toHaveTitle("two.md — MDedit");
  await expect.poll(() => page.evaluate(() => window.__testBridge.calls.titles.at(-1))).toBe("two.md — MDedit");
});

test("native title writes serialize so a delayed old title cannot finish last", async ({ page }) => {
  await installFakeTauri(page, { delayFirstTitle: true });
  await openEditor(page);
  await activeEditor(page).fill("dirty first");
  await page.getByRole("button", { name: "New document" }).click();
  await expect(page).toHaveTitle("Untitled 2 — MDedit");

  await page.evaluate(() => window.__testBridge.releaseFirstTitle());

  await expect.poll(() => page.evaluate(() => window.__testBridge.calls.nativeTitle)).toBe("Untitled 2 — MDedit");
  expect(await page.evaluate(() => window.__testBridge.calls.titleRequests.at(0))).toBe("Untitled 1 — MDedit");
  expect(await page.evaluate(() => window.__testBridge.calls.titles.at(-1))).toBe("Untitled 2 — MDedit");
});

test("status announcements identify their document", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/failing.md", "/notes/conflicted.md"],
    documents: {
      "/notes/failing.md": { content: "failing content", sha256: "fingerprint-failing" },
      "/notes/conflicted.md": { content: "conflicted content", sha256: "fingerprint-conflicted" },
    },
    saveResults: {
      "/notes/failing.md": { error: "disk is read-only" },
      "/notes/conflicted.md": { status: "conflict", actualSha256: "fingerprint-external" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /conflicted\.md/ })).toBeVisible();
  await activeEditor(page).fill("editor conflict");
  await page.locator("#btn-save").click();
  await expect(page.getByRole("status")).toContainText("conflicted.md");
  await page.getByRole("button", { name: "Keep Editing" }).click();

  await page.getByRole("tab", { name: /failing\.md/ }).click();
  await activeEditor(page).fill("editor failure");
  await page.locator("#btn-save").click();
  await expect(page.getByRole("status")).toContainText(/failing\.md.*(?:read-only|Couldn(?:'t| not) save)/);
});

test("late Mermaid completion cannot cross documents", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await page.evaluate(() => {
    let resolveRender;
    window.__mermaidStarted = false;
    window.__resolveMermaid = () => resolveRender && resolveRender({ svg: '<svg aria-label="prior diagram"><text>PRIOR-DOC</text></svg>' });
    window.mermaid.render = () => {
      window.__mermaidStarted = true;
      return new Promise((resolve) => { resolveRender = resolve; });
    };
  });
  await activeEditor(page).fill("```mermaid\nflowchart LR\nA[PRIOR-DOC] --> B\n```");
  await expect.poll(() => page.evaluate(() => window.__mermaidStarted)).toBe(true);
  const previewImmediatelyAfterSwitch = await page.evaluate(() => {
    document.querySelector('[aria-label="New document"]').click();
    return document.querySelector("#preview").textContent;
  });
  expect(previewImmediatelyAfterSwitch).not.toContain("PRIOR-DOC");
  await activeEditor(page).fill("# CURRENT-DOC");
  await expect(page.locator("#preview")).toContainText("CURRENT-DOC");
  await page.evaluate(() => window.__resolveMermaid());
  await page.waitForTimeout(50);
  await expect(page.locator("#preview")).toContainText("CURRENT-DOC");
  await expect(page.locator("#preview")).not.toContainText("PRIOR-DOC");
  await expect(page.locator('#preview svg[aria-label="prior diagram"]')).toHaveCount(0);
});

test("multi-file open continues after one failure", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/one.md", "/notes/broken-two.md", "/notes/three.md"],
    documents: {
      "/notes/one.md": { content: "# one" },
      "/notes/broken-two.md": { error: "simulated read failure" },
      "/notes/three.md": { content: "# three" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /one\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /three\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^broken-two\.md(?:\s|$)/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /three\.md/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("status")).toContainText("/notes/broken-two.md");
});

test("conflict actions preserve both versions", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/notes/both.md"],
    savePath: "/notes/editor-copy.md",
    documents: {
      "/notes/both.md": { content: "disk-original", sha256: "fingerprint-original" },
      "/notes/editor-copy.md": { error: "failed to read document /notes/editor-copy.md: No such file or directory (os error 2)" },
    },
    saveResults: {
      "/notes/both.md": [
        { status: "conflict", actualSha256: "fingerprint-external-1" },
        { status: "conflict", actualSha256: "fingerprint-external-2" },
      ],
      "/notes/editor-copy.md": { status: "saved", sha256: "fingerprint-copy", canonicalPath: "/notes/editor-copy.md" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^both\.md(?:\s|$)/ }))
    .toHaveAttribute("aria-selected", "true");
  await activeEditor(page).fill("editor-version");
  await page.locator("#btn-save").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep Editing" }).click();
  await expect(activeEditor(page)).toHaveValue("editor-version");

  await page.locator("#btn-save").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Save Editor Version As" }).click();
  await expect(page.getByRole("tab", { name: /editor-copy\.md/ })).toBeVisible();
  await expect(activeEditor(page)).toHaveValue("editor-version");

  const saves = await page.evaluate(() => window.__testBridge.calls.saves);
  expect(saves.filter((call) => call.path === "/notes/both.md")).toHaveLength(1);
  for (const call of saves.filter((entry) => entry.path === "/notes/both.md")) {
    expect(call.content).toBe("editor-version");
    expect(call.expectedSha256).toBe("fingerprint-original");
  }
  expect(saves.some((call) => call.content === "disk-original" && !call.expectedSha256)).toBe(false);
  expect(saves).toContainEqual(expect.objectContaining({
    path: "/notes/editor-copy.md",
    content: "editor-version",
    expectedSha256: null,
  }));
});

test("browser handle saves detect external changes and keep both versions available", async ({ page }) => {
  await page.addInitScript(() => {
    window.__MDEDIT_TEST_HOOK__ = { restored: false };
    const state = {
      original: "disk-original",
      copy: "copy-existing",
      writes: { original: [], copy: [] },
    };
    const makeHandle = (key, name) => ({
      key,
      name,
      async isSameEntry(other) { return Boolean(other && other.key === key); },
      async queryPermission() { return "granted"; },
      async getFile() {
        return new File([state[key]], name, { type: "text/markdown" });
      },
      async createWritable() {
        let pending = null;
        return {
          async write(content) { pending = String(content); },
          async close() {
            state.writes[key].push(pending);
            state[key] = pending;
          },
        };
      },
    });
    const original = makeHandle("original", "browser.md");
    const copy = makeHandle("copy", "browser-copy.md");
    window.__browserHandleTest = { state, original, copy };
    window.showOpenFilePicker = async () => [original];
    window.showSaveFilePicker = async () => copy;
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /browser\.md/ })).toBeVisible();
  await activeEditor(page).fill("editor-version");
  await page.evaluate(() => { window.__browserHandleTest.state.original = "disk-external"; });

  await page.locator("#btn-save").click();
  await expect(page.getByRole("dialog")).toContainText("browser.md");
  expect(await page.evaluate(() => window.__browserHandleTest.state.writes.original)).toEqual([]);
  await page.getByRole("button", { name: "Keep Editing" }).click();
  await expect(activeEditor(page)).toHaveValue("editor-version");

  await page.locator("#btn-save").click();
  await page.getByRole("button", { name: "Reload Disk Version" }).click();
  await page.getByRole("button", { name: "Discard and Reload" }).click();
  await expect(activeEditor(page)).toHaveValue("disk-external");

  await activeEditor(page).evaluate((editor) => {
    editor.value = "editor-copy";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => { window.__browserHandleTest.state.original = "disk-external-again"; });
  await page.locator("#btn-save").click();
  await page.getByRole("button", { name: "Save Editor Version As" }).click();
  await expect(page.getByRole("tab", { name: /browser-copy\.md/ })).toBeVisible();
  await expect(activeEditor(page)).toHaveValue("editor-copy");
  expect(await page.evaluate(() => window.__browserHandleTest.state.writes)).toEqual({
    original: [],
    copy: ["editor-copy"],
  });

  await page.locator("#btn-save").click();
  await expect.poll(() => page.evaluate(() => window.__browserHandleTest.state.writes.copy.length)).toBe(2);
  expect(await page.evaluate(() => window.__browserHandleTest.state.writes.copy)).toEqual(["editor-copy", "editor-copy"]);
});
