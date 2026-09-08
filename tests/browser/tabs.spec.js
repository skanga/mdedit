const { test, expect } = require("@playwright/test");
const { activeEditor, installFakeTauri, openEditor, setEditorContent } = require("./helpers.js");

test('formatting toolbar preserves selection and undo, exposes menus, and follows view mode', async ({ page }) => {
  await installFakeTauri(page); await openEditor(page);
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'More formatting', exact: true })).toBeHidden();
  await expect(bar.getByRole('button', { name: 'Horizontal rule', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Equation', exact: true })).toBeVisible();
  await activeEditor(page).fill('hello world');
  await activeEditor(page).evaluate(el => el.setSelectionRange(6, 11));
  await bar.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(activeEditor(page)).toHaveValue('hello **world**');
  await activeEditor(page).press('ControlOrMeta+z');
  await expect(activeEditor(page)).toHaveValue('hello world');
  await bar.getByRole('button', { name: 'Heading', exact: true }).click();
  await bar.getByRole('button', { name: 'Heading 6', exact: true }).click();
  await expect(activeEditor(page)).toHaveValue('###### hello world');
  await bar.getByRole('button', { name: 'List', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(bar.getByRole('button', { name: 'Bulleted list', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar.getByRole('button', { name: 'List', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(bar).toBeHidden();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(bar).toBeVisible();
});

test('formatting toolbar adapts to narrow panes and persists its visibility preference', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.addInitScript(() => localStorage.setItem('mdedit-theme', 'dark'));
  await installFakeTauri(page); await openEditor(page);
  await activeEditor(page).fill('# A focused writing space\n\nSelect text to format it, or insert a table, image, or list.');
  await expect(page.locator('#preview')).toContainText('A focused writing space');
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await page.screenshot({ path: 'test-results/formatting-dark.png' });
  await page.locator('#btn-theme').click();
  await expect(page.locator('#preview')).toContainText('A focused writing space');
  await page.screenshot({ path: 'test-results/formatting-light.png' });
  await page.setViewportSize({ width: 800, height: 700 });
  await expect(bar.locator(':scope > .format-secondary')).toHaveCount(6);
  await expect(bar.locator(':scope > .format-secondary').first()).toBeHidden();
  await bar.getByRole('button', { name: 'More formatting', exact: true }).click();
  const menuBox = await page.locator('#format-menu-more').boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(800);
  await bar.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(activeEditor(page)).toHaveValue(/\| Column 1 \| Column 2 \|/);
  await page.locator('#btn-editor-options').click();
  await expect(page.locator('#editor-options [data-format]')).toHaveCount(0);
  await page.getByLabel('Show formatting toolbar', { exact: true }).uncheck();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(page.locator('#formatting-toolbar')).toBeHidden();
  await page.locator('#btn-editor-options').click();
  await page.getByLabel('Show formatting toolbar', { exact: true }).check();
  await expect(bar).toBeVisible();
});

test('opening formatting menus preserves caret and independent scroll positions', async ({ page }) => {
  await installFakeTauri(page); await openEditor(page);
  const content = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} with some text.\n`).join('\n');
  await activeEditor(page).fill(content);
  await expect(page.locator('#preview')).toContainText('Paragraph 99');
  await activeEditor(page).evaluate(el => { el.setSelectionRange(0, 0); el.scrollTop = 500; });
  await expect.poll(() => page.locator('#preview-pane').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  // Preview can be scrolled independently; the caret need not be in the viewport.
  await page.locator('#preview-pane').evaluate(el => { el.scrollTop = 0; });
  const before = await activeEditor(page).evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }));
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Heading', exact: true }).click();
  await expect.poll(() => activeEditor(page).evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop }))).toEqual(before);
  await expect(page.locator('#document-details')).toContainText('Ln: 1, Col: 1');
  expect(await page.locator('#preview-pane').evaluate(el => el.scrollTop)).toBe(0);
});

test("document details follow the caret, edits, and active tab", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  await activeEditor(page).fill("hello\né😀");
  const details = page.locator("#document-details");
  await expect(details).toHaveText("Ln: 2, Col: 3 ◦ UTF-8 ◦ LF ◦ 12 B");
  await activeEditor(page).press("ArrowLeft");
  await expect(details).toHaveText("Ln: 2, Col: 2 ◦ UTF-8 ◦ LF ◦ 12 B");
  await activeEditor(page).evaluate(editor => editor.setSelectionRange(0, 2, "backward"));
  await expect(details).toHaveText("Ln: 1, Col: 1 ◦ UTF-8 ◦ LF ◦ 12 B");
  await page.getByRole("button", { name: "New document" }).click();
  await expect(details).toHaveText("Ln: 1, Col: 1 ◦ UTF-8 ◦ None ◦ 0 B");
  await page.getByRole("tab", { name: /Untitled 1/ }).click();
  await expect(details).toContainText("UTF-8 ◦ LF ◦ 12 B");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(details).toBeVisible();
});

test("document details use original bytes and line endings when opening files", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/docs/crlf.md", "/docs/mixed.md", "/docs/cr.md"],
    documents: {
      "/docs/crlf.md": { content: "\uFEFFé\r\nx" },
      "/docs/mixed.md": { content: "a\r\nb\nc" },
      "/docs/cr.md": { content: "a\rb" },
    },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const details = page.locator("#document-details");
  await page.getByRole("tab", { name: /crlf.md/ }).click();
  await expect(details).toContainText("UTF-8 BOM ◦ CRLF ◦ 8 B");
  await page.getByRole("tab", { name: /mixed.md/ }).click();
  await expect(details).toContainText("UTF-8 ◦ Mixed ◦ 6 B");
  await page.getByRole("tab", { name: /cr.md/ }).click();
  await expect(details).toContainText("UTF-8 ◦ CR ◦ 3 B");
  await activeEditor(page).fill("x".repeat(12 * 1024));
  await expect(details).toContainText("UTF-8 ◦ None ◦ 12 KB");
});

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
  expect(await page.evaluate(() => window.__testBridge.calls.destroyCalls)).toBe(0);
});

for (const action of ["Close", "Save All & Quit", "Quit and Restore Next Time", "Discard All & Quit"]) {
  test(`desktop quit completes after choosing ${action}`, async ({ page }) => {
    await installFakeTauri(page, {
      savePath: "/quit.md",
      documents: {
        "/quit.md": { error: "failed to read document /quit.md: No such file or directory (os error 2)" },
      },
    });
    await openEditor(page);
    if (action !== "Close") await setEditorContent(page, "Unsaved quit content");
    await page.evaluate(() => {
      window.__quitRequest = window.__testBridge.requestClose();
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: action, exact: true }).click();
    const result = await page.evaluate(async () => (await window.__quitRequest).promise);
    expect(result.allowClose, JSON.stringify(result)).toBe(true);
    expect(await page.evaluate(() => window.__testBridge.calls.closeCalls)).toBe(1);
    expect(await page.evaluate(() => window.__testBridge.calls.destroyCalls)).toBe(1);
    await expect(page.getByRole("dialog")).toBeHidden();
  });
}

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
  const browserTab = page.getByRole("tab", { name: /browser\.md/ });
  await expect(browserTab).toBeVisible();
  await expect(browserTab).toHaveAttribute("aria-selected", "true");
  await expect(activeEditor(page)).toHaveValue("disk-original");
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
  await expect(page.locator("#preview")).toContainText("disk-external");

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

test("browser Save All and dirty close share guarded handles while canceled Save As stays dirty", async ({ page }) => {
  await page.addInitScript(() => {
    window.__MDEDIT_TEST_HOOK__ = { restored: false };
    const state = { a: "a", b: "b", writes: { a: [], b: [] } };
    const makeHandle = (key) => ({
      key,
      name: `${key}.md`,
      async isSameEntry(other) { return Boolean(other && other.key === key); },
      async queryPermission() { return "granted"; },
      async getFile() { return new File([state[key]], `${key}.md`, { type: "text/markdown" }); },
      async createWritable() {
        let pending;
        return {
          async write(content) { pending = String(content); },
          async close() { state.writes[key].push(pending); state[key] = pending; },
        };
      },
    });
    window.__browserBulkTest = { state, handles: [makeHandle("a"), makeHandle("b")] };
    window.showOpenFilePicker = async () => window.__browserBulkTest.handles;
    window.showSaveFilePicker = async () => { throw new DOMException("canceled", "AbortError"); };
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("aria-selected", "true");
  await setEditorContent(page, "b edited");
  await expect.poll(() => page.getByRole("tab", { name: /^b\.md/ }).evaluate(
    (tab) => tab.parentElement.classList.contains("is-dirty"),
  )).toBe(true);
  await page.getByRole("tab", { name: /a\.md/ }).click();
  await setEditorContent(page, "a edited");
  await expect.poll(() => page.getByRole("tab", { name: /a\.md/ }).evaluate(
    (tab) => tab.parentElement.classList.contains("is-dirty"),
  )).toBe(true);

  await page.getByRole("button", { name: "Save All", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("Saved 2 documents");
  expect(await page.evaluate(() => window.__browserBulkTest.state.writes)).toEqual({
    a: ["a edited"],
    b: ["b edited"],
  });

  await setEditorContent(page, "a close edit");
  await page.getByRole("button", { name: "Close a.md" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("tab", { name: /a\.md/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.__browserBulkTest.state.writes.a)).toEqual(["a edited", "a close edit"]);

  await page.getByRole("button", { name: "New document" }).click();
  await setEditorContent(page, "unsaved draft");
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await page.getByRole("tab", { name: /b\.md/ }).click();
  await setEditorContent(page, "b after canceled draft");
  await page.getByRole("tab", { name: /Untitled 2/ }).click();
  await page.getByRole("button", { name: "Save All", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Save All canceled");
  await expect(page.getByRole("button", { name: "Save All", exact: true })).toBeEnabled();
  await expect(activeEditor(page)).toHaveValue("unsaved draft");
  expect(await page.evaluate(() => window.__browserBulkTest.state.writes.b)).toEqual(["b edited"]);
  await expect.poll(() => page.getByRole("tab", { name: /^b\.md/ }).evaluate(
    (tab) => tab.parentElement.classList.contains("is-dirty"),
  )).toBe(true);
});

test("browser Save All stops after conflict and Save All and Quit only succeeds after every handle saves", async ({ page }) => {
  await page.addInitScript(() => {
    window.__MDEDIT_TEST_HOOK__ = { restored: false };
    const state = { a: "a", b: "b", writes: { a: [], b: [] } };
    const makeHandle = (key) => ({
      key,
      name: `${key}.md`,
      async isSameEntry(other) { return Boolean(other && other.key === key); },
      async queryPermission() { return "granted"; },
      async getFile() { return new File([state[key]], `${key}.md`, { type: "text/markdown" }); },
      async createWritable() {
        let pending;
        return {
          async write(content) { pending = String(content); },
          async close() { state.writes[key].push(pending); state[key] = pending; },
        };
      },
    });
    window.__browserQuitTest = { state, handles: [makeHandle("a"), makeHandle("b")] };
    window.showOpenFilePicker = async () => window.__browserQuitTest.handles;
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("aria-selected", "true");
  await setEditorContent(page, "b edited");
  await expect.poll(() => page.getByRole("tab", { name: /b\.md/ }).evaluate(
    (tab) => tab.parentElement.classList.contains("is-dirty"),
  )).toBe(true);
  await page.getByRole("tab", { name: /a\.md/ }).click();
  await setEditorContent(page, "a edited");
  await expect.poll(() => page.getByRole("tab", { name: /a\.md/ }).evaluate(
    (tab) => tab.parentElement.classList.contains("is-dirty"),
  )).toBe(true);
  await page.evaluate(() => { window.__browserQuitTest.state.a = "a external"; });

  await page.getByRole("button", { name: "Save All", exact: true }).click();
  await page.getByRole("button", { name: "Keep Editing" }).click();

  await expect(page.getByRole("status")).toContainText("0 saved; 2 remain unsaved: a.md, b.md");
  expect(await page.evaluate(() => window.__browserQuitTest.state.writes)).toEqual({ a: [], b: [] });

  await page.evaluate(() => {
    window.__browserQuitTest.pendingQuit = window.__MDEDIT_TEST_HOOK__.controller.requestQuit();
  });
  await page.getByRole("button", { name: "Save All & Quit" }).click();
  const blocked = await page.evaluate(() => window.__browserQuitTest.pendingQuit);
  expect(blocked.allowClose).toBe(false);
  expect(await page.evaluate(() => window.__browserQuitTest.state.writes.a)).toEqual([]);

  await page.locator("#btn-save").click();
  await page.getByRole("button", { name: "Reload Disk Version" }).click();
  await page.getByRole("button", { name: "Discard and Reload" }).click();
  await expect(activeEditor(page)).toHaveValue("a external");
  await activeEditor(page).evaluate((editor) => {
    editor.value = "a final";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("tab", { name: /b\.md/ }).click();
  await activeEditor(page).evaluate((editor) => {
    editor.value = "b final";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.evaluate(() => {
    window.__browserQuitTest.pendingQuit = window.__MDEDIT_TEST_HOOK__.controller.requestQuit();
  });
  await page.getByRole("button", { name: "Save All & Quit" }).click();
  const successful = await page.evaluate(() => window.__browserQuitTest.pendingQuit);
  expect(successful.allowClose).toBe(true);
  expect(await page.evaluate(() => window.__browserQuitTest.state.writes)).toEqual({
    a: ["a final"],
    b: ["b final"],
  });
});

test("browser Save All stops createWritable at the first failed handle", async ({ page }) => {
  await page.addInitScript(() => {
    window.__MDEDIT_TEST_HOOK__ = { restored: false };
    const state = {
      a: "a",
      b: "b",
      c: "c",
      fail: "a",
      creates: { a: 0, b: 0, c: 0 },
      writes: { a: [], b: [], c: [] },
    };
    const makeHandle = (key) => ({
      key,
      name: `${key}.md`,
      async isSameEntry(other) { return Boolean(other && other.key === key); },
      async queryPermission() { return "granted"; },
      async getFile() { return new File([state[key]], `${key}.md`, { type: "text/markdown" }); },
      async createWritable() {
        state.creates[key] += 1;
        let pending;
        return {
          async write(content) { pending = String(content); },
          async close() {
            if (state.fail === key) throw new Error(`${key} write failed`);
            state.writes[key].push(pending);
            state[key] = pending;
          },
        };
      },
    });
    window.__browserFailureTest = { state, handles: [makeHandle("a"), makeHandle("b"), makeHandle("c")] };
    window.showOpenFilePicker = async () => window.__browserFailureTest.handles;
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /c\.md/ })).toHaveAttribute("aria-selected", "true");
  for (const name of ["a", "b", "c"]) {
    await page.getByRole("tab", { name: new RegExp(`${name}\\.md`) }).click();
    await setEditorContent(page, `${name} edited`);
  }

  await page.getByRole("button", { name: "Save All", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("Save All stopped after 0 saved; 3 remain unsaved");
  expect(await page.evaluate(() => window.__browserFailureTest.state.creates)).toEqual({ a: 1, b: 0, c: 0 });

  await page.evaluate(() => { window.__browserFailureTest.state.fail = "b"; });
  await page.getByRole("button", { name: "Save All", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("Save All stopped after 1 saved; 2 remain unsaved: b.md, c.md");
  expect(await page.evaluate(() => window.__browserFailureTest.state.creates)).toEqual({ a: 2, b: 1, c: 0 });
  expect(await page.evaluate(() => window.__browserFailureTest.state.writes)).toEqual({
    a: ["a edited"],
    b: [],
    c: [],
  });
});

for (const action of ['find-replace', 'find-all']) {
  test(`review regression: ${action} uses current editor offsets`, async ({ page }) => {
    await installFakeTauri(page);
    await openEditor(page);
    await activeEditor(page).fill('cat dog');
    await activeEditor(page).press('Control+f');
    await page.locator('#find-input').fill('dog');
    await page.locator('#replace-input').fill('fox');
    await activeEditor(page).fill('XXX cat dog');
    await page.locator(`#${action}`).click();
    await expect(activeEditor(page)).toHaveValue('XXX cat fox');
    await activeEditor(page).fill('no matches');
    await expect(page.locator('#find-count')).toHaveText('0/0');
    await page.locator(`#${action}`).click();
    await expect(activeEditor(page)).toHaveValue('no matches');
  });

  test(`review regression: ${action} preserves Unicode and literal query offsets`, async ({ page }) => {
    await installFakeTauri(page);
    await openEditor(page);
    await activeEditor(page).fill('İ cat CAT');
    await activeEditor(page).press('Control+f');
    await page.locator('#find-input').fill('cat');
    await page.locator('#replace-input').fill('dog');
    await page.locator(`#${action}`).click();
    await expect(activeEditor(page)).toHaveValue(action === 'find-all' ? 'İ dog dog' : 'İ dog CAT');
    await activeEditor(page).fill('İ [a].* [A].*');
    await page.locator('#find-input').fill('[a].*');
    await page.locator(`#${action}`).click();
    await expect(activeEditor(page)).toHaveValue(action === 'find-all' ? 'İ dog dog' : 'İ dog [A].*');
  });
}

test('review regression: native reload refreshes the preview and find matches', async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ['/notes/reload.md'],
    documents: { '/notes/reload.md': { content: '# original', sha256: 'original' } },
  });
  await openEditor(page);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('#preview')).toContainText('original');
  await activeEditor(page).press('Control+f');
  await page.locator('#find-input').fill('original');
  await page.evaluate(async () => {
    const controller = window.__MDEDIT_TEST_HOOK__.controller;
    controller.io.readDocument = async () => ({ path: '/notes/reload.md', canonicalPath: '/notes/reload.md', content: '# changed', sha256: 'changed' });
    await controller.resolveConflict(controller.activeDocument().id, 'reload');
  });
  await expect(activeEditor(page)).toHaveValue('# changed');
  await expect(page.locator('#preview')).toContainText('changed');
  await expect(page.locator('#preview')).not.toContainText('original');
  await expect(page.locator('#find-count')).toHaveText('0/0');
});

for (const theme of ['light', 'dark']) {
  test(`review regression: PDF prints current Edit-mode content in ${theme} theme`, async ({ page }) => {
    await installFakeTauri(page);
    await page.addInitScript((theme) => localStorage.setItem('mdedit-theme', theme), theme);
    await openEditor(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await activeEditor(page).fill('# Print the current revision');
    const printed = await page.evaluate(async () => {
      let printed;
      window.print = () => {
        printed = { content: document.querySelector('#preview').textContent, theme: document.documentElement.dataset.theme };
        window.dispatchEvent(new Event('afterprint'));
      };
      await window.__MDEDIT_TEST_HOOK__.controller.exportActive('pdf');
      return printed;
    });
    expect(printed).toEqual({ content: 'Print the current revision\n', theme: 'light' });
    await expect(page.locator('body')).toHaveAttribute('data-view', 'edit');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });
}

test('review regression: native wakeups drain queued files once', async ({ page }) => {
  await installFakeTauri(page, {
    pendingFiles: ['/notes/early.md'],
    documents: {
      '/notes/early.md': { content: 'early' },
      '/notes/late.md': { content: 'late' },
    },
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.restored)).toBe(true);
  await expect(activeEditor(page)).toHaveValue('early');
  await page.evaluate(async () => {
    window.__testBridge.pendingFiles.push('/notes/late.md');
    await Promise.all([
      window.__testBridge.emit('file-opened', null),
      window.__testBridge.emit('file-opened', null),
    ]);
  });
  await expect(activeEditor(page)).toHaveValue('late');
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await page.evaluate(() => window.__testBridge.calls.invokes
    .filter(call => call.command === 'read_document').map(call => call.args.path)))
    .toEqual(['/notes/early.md', '/notes/late.md']);
});

test('native startup waits for listener registration before draining queued opens', async ({ page }) => {
  await installFakeTauri(page, {
    delayFileListener: true,
    documents: { '/notes/early.md': { content: 'arrived before listener' } },
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(window.__MDEDIT_TEST_HOOK__.controller))).toBe(true);
  await page.evaluate(async () => {
    window.__testBridge.pendingFiles.push('/notes/early.md');
    await window.__testBridge.emit('file-opened', null);
    window.__testBridge.releaseFileListener();
  });
  await expect.poll(() => page.evaluate(() => window.__MDEDIT_TEST_HOOK__.restored)).toBe(true);
  await expect(activeEditor(page)).toHaveValue('arrived before listener');
  await expect(page.getByRole('tab')).toHaveCount(1);
});

for (const interruption of ['edit', 'switch', 'print-error']) {
  test(`PDF restores dark theme after ${interruption} and never prints a stale capture`, async ({ page }) => {
    await installFakeTauri(page);
    await page.addInitScript(() => localStorage.setItem('mdedit-theme', 'dark'));
    await openEditor(page);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await activeEditor(page).fill('# Captured content');
    const result = await page.evaluate(async (interruption) => {
      const controller = window.__MDEDIT_TEST_HOOK__.controller;
      let printCalls = 0;
      window.print = () => { printCalls++; throw new Error('print unavailable'); };
      const exporting = controller.exportActive('pdf');
      if (interruption === 'edit') controller.onEditorInput(controller.activeDocument().id, '# New content');
      if (interruption === 'switch') controller.createUntitled();
      let error;
      try { await exporting; } catch (reason) { error = reason.message; }
      return { printCalls, error };
    }, interruption);
    expect(result.printCalls).toBe(interruption === 'print-error' ? 1 : 0);
    expect(result.error).toContain(interruption === 'print-error' ? 'print unavailable' : 'active document changed');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
}

for (const appTheme of ['light', 'dark']) {
  test(`native scrollbar scheme follows ${appTheme} app theme instead of OS preference`, async ({ page }) => {
    const osTheme = appTheme === 'light' ? 'dark' : 'light';
    await page.emulateMedia({ colorScheme: osTheme });
    await installFakeTauri(page);
    await page.addInitScript((theme) => localStorage.setItem('mdedit-theme', theme), appTheme);
    await openEditor(page);
    const schemes = () => page.evaluate(() => ['html', '.document-editor', '#preview-pane', '#document-tabs']
      .map(selector => getComputedStyle(document.querySelector(selector)).colorScheme));
    expect(await schemes()).toEqual(Array(4).fill(appTheme));
    await page.locator('#btn-theme').click();
    expect(await schemes()).toEqual(Array(4).fill(osTheme));
  });
}

test("recent documents is desktop-only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open recent documents", exact: true })).toBeHidden();
});

for (const theme of ["light", "dark"]) {
  test(`desktop recent documents opens files and preserves dirty tabs in ${theme} mode`, async ({ page }) => {
    await installFakeTauri(page, {
      recentDocuments: [{ path: "/notes/a.md", canonicalPath: "/notes/a.md" }],
      documents: { "/notes/a.md": { content: "original" } },
    });
    await openEditor(page);
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
    const trigger = page.getByRole("button", { name: "Open recent documents", exact: true });
    await trigger.click();
    const recent = page.getByRole("dialog", { name: "Recent documents", exact: true });
    await expect(recent).toBeVisible();
    await expect(recent).toContainText("/notes");
    expect(await recent.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(24, 24, 27)");
    await recent.getByRole("button", { name: "Open /notes/a.md", exact: true }).click();
    await expect(activeEditor(page)).toHaveValue("original");
    await setEditorContent(page, "unsaved edits");
    const tabCount = await page.getByRole("tab").count();
    const reads = await page.evaluate(() => window.__testBridge.calls.invokes.filter((c) => c.command === "read_document").length);
    await trigger.click();
    await recent.getByRole("button", { name: "Open /notes/a.md", exact: true }).click();
    await expect(activeEditor(page)).toHaveValue("unsaved edits");
    await expect(page.getByRole("tab")).toHaveCount(tabCount);
    expect(await page.evaluate(() => window.__testBridge.calls.invokes.filter((c) => c.command === "read_document").length)).toBe(reads);
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(recent).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("desktop recents retain missing files and support removal and clear without closing tabs", async ({ page }) => {
  await installFakeTauri(page, {
    recentDocuments: [
      { path: "/gone/a.md", canonicalPath: "/gone/a.md" },
      { path: "/other/a.md", canonicalPath: "/other/a.md" },
    ],
    documents: { "/gone/a.md": { error: "No such file or directory" } },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open recent documents", exact: true }).click();
  const recent = page.getByRole("dialog", { name: "Recent documents", exact: true });
  await recent.getByRole("button", { name: "Open /gone/a.md", exact: true }).click();
  await expect(recent).toContainText("Could not open");
  await expect(recent.getByRole("button", { name: "Open /gone/a.md", exact: true })).toBeVisible();
  await recent.getByRole("button", { name: "Remove /gone/a.md from recent documents", exact: true }).click();
  await expect(recent.getByRole("button", { name: "Open /gone/a.md", exact: true })).toHaveCount(0);
  await recent.getByRole("button", { name: "Clear recent documents", exact: true }).click();
  await expect(recent).toContainText("No recent documents");
  await expect(page.getByRole("tab")).toHaveCount(1);
  expect(await page.evaluate(() => window.__testBridge.recentDocuments)).toEqual([]);
});

test("desktop recents record picker opens in order and remain usable after a history write failure", async ({ page }) => {
  await installFakeTauri(page, {
    openPaths: ["/one/a.md", "/two/b.md"],
    documents: { "/one/a.md": { content: "one" }, "/two/b.md": { content: "two" } },
  });
  await openEditor(page);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("button", { name: "Open recent documents", exact: true }).click();
  const recent = page.getByRole("dialog", { name: "Recent documents", exact: true });
  await expect(recent.locator(".recent-name")).toHaveText(["b.md", "a.md"]);
  await page.keyboard.press("End");
  await expect(recent.getByRole("button", { name: "Clear recent documents", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recent.getByRole("button", { name: "Open /two/b.md", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");

  const other = await page.context().newPage();
  await installFakeTauri(other, { openPaths: ["/one/a.md"], documents: { "/one/a.md": { content: "one" } }, recentWriteError: "disk full" });
  await openEditor(other);
  await other.getByRole("button", { name: "Open", exact: true }).click();
  await expect(activeEditor(other)).toHaveValue("one");
  await other.getByRole("button", { name: "Open recent documents", exact: true }).click();
  await expect(other.getByRole("dialog", { name: "Recent documents", exact: true })).toContainText("No recent documents");
  await other.close();
});

test("recent document failures preserve keyboard navigation and Escape dismissal", async ({ page }) => {
  await installFakeTauri(page, {
    recentDocuments: [{ path: "/missing.md", canonicalPath: "/missing.md" }],
    documents: { "/missing.md": { error: "File not found", delayMs: 100 } },
  });
  await openEditor(page);
  const trigger = page.getByRole("button", { name: "Open recent documents", exact: true });
  await trigger.click();
  const recent = page.getByRole("dialog", { name: "Recent documents", exact: true });
  const open = recent.getByRole("button", { name: "Open /missing.md", exact: true });
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(recent).toContainText("Could not open");
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recent).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('editor essentials: formatting and smart lists preserve native undo', async ({page}) => {
  await installFakeTauri(page); await openEditor(page);
  await setEditorContent(page,'alpha');
  await activeEditor(page).evaluate(el=>{el.focus();el.select();});
  await activeEditor(page).press('Control+b');
  await expect(activeEditor(page)).toHaveValue('**alpha**');
  await activeEditor(page).press('Control+z');
  await expect(activeEditor(page)).toHaveValue('alpha');
  await setEditorContent(page,'- [x] done');
  await activeEditor(page).press('Control+End');
  await activeEditor(page).press('Enter');
  await expect(activeEditor(page)).toHaveValue('- [x] done\n- [ ] ');
  await activeEditor(page).press('Enter');
  await expect(activeEditor(page)).toHaveValue('- [x] done\n');
  await setEditorContent(page,'a\nb');
  await activeEditor(page).evaluate(el=>{el.focus();el.select();});
  await activeEditor(page).press('Control+Alt+2');
  await expect(activeEditor(page)).toHaveValue('## a\n## b');
});

test('editor essentials: preferences persist and apply to new tabs in both themes', async ({page}) => {
  await installFakeTauri(page); await openEditor(page);
  await page.locator('#btn-editor-options').click();
  await page.locator('#editor-font-size').fill('18');
  await page.locator('#editor-font-size').press('Tab');
  await page.locator('#editor-tab-width').selectOption('4');
  await page.locator('#editor-wrap').uncheck();
  await page.locator('#editor-line-numbers').check();
  await page.locator('#editor-options').press('Escape');
  await setEditorContent(page,'one\ntwo\nthree');
  await expect(activeEditor(page)).toHaveCSS('font-size','18px');
  await expect(activeEditor(page)).toHaveAttribute('wrap','off');
  await expect(page.locator('.editor-surface:not([hidden]):not(.is-inactive) .editor-gutter')).toContainText('123');
  await page.locator('#btn-new').click();
  await expect(activeEditor(page)).toHaveCSS('tab-size','4');
  await activeEditor(page).press('Tab');
  await expect(activeEditor(page)).toHaveValue('    ');
  for (const theme of ['light','dark']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.locator('#btn-editor-options').click();
    const colors=await page.locator('#editor-options').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color}));
    expect(colors.bg).not.toBe(colors.text);
    await page.locator('#editor-options').press('Escape');
  }
  await page.reload();
  await expect(activeEditor(page)).toHaveCSS('font-size','18px');
  await expect(activeEditor(page)).toHaveAttribute('wrap','off');
});

test('editor essentials: search modes, capture replacements and invalid regex stay in the active document', async ({page}) => {
  await installFakeTauri(page);await openEditor(page);
  await setEditorContent(page,'Cat cat scatter cat12');
  await activeEditor(page).press('Control+f');
  await page.locator('#find-input').fill('cat');
  await expect(page.locator('#find-count')).toHaveText('1/4');
  await page.locator('#find-case').check();
  await expect(page.locator('#find-count')).toHaveText('1/3');
  await page.locator('#find-word').check();
  await expect(page.locator('#find-count')).toHaveText('1/1');
  await page.locator('#find-word').uncheck();
  await page.locator('#find-regex').check();
  await page.locator('#find-input').fill('cat(\\d+)');
  await page.locator('#replace-input').fill('dog$1');
  await page.locator('#find-all').click();
  await expect(activeEditor(page)).toHaveValue('Cat cat scatter dog12');
  await page.locator('#find-input').fill('[');
  await expect(page.locator('#find-error')).toContainText('Invalid regular expression');
  await expect(page.locator('#find-all')).toBeDisabled();
  await expect(activeEditor(page)).toHaveValue('Cat cat scatter dog12');
});

const pixelBytes=Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));

test('editor essentials: desktop attachments insert relative links and embed in HTML export', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/notes/a.md'],documents:{'/notes/a.md':{content:'start\n'}},attachmentPaths:['/photos/a.png'],assets:{'assets/imported.png':{bytes:pixelBytes,mime:'image/png'}},savePath:'/out/a.html'});
  await openEditor(page);await page.locator('#btn-open').click();
  await expect(activeEditor(page)).toHaveValue('start\n');
  await activeEditor(page).press('Control+End');await page.locator('#btn-attach').click();
  await expect(activeEditor(page)).toHaveValue('start\n![a.png](assets/imported.png)\n');
  await expect(page.locator('#preview img')).toHaveAttribute('src',/^data:image\/png;base64,/);
  await expect.poll(()=>page.locator('#preview img').evaluate(img=>img.naturalWidth)).toBe(1);
  await page.locator('#btn-export').click();await page.locator('[data-exp="html"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__testBridge.calls.writes.length)).toBe(1);
  const html=await page.evaluate(()=>new TextDecoder().decode(new Uint8Array(window.__testBridge.calls.writes[0].data)));
  expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain('src="assets/');
});

test('editor essentials: slow attachment import cannot edit a different tab', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'original'}},attachmentPaths:['/a.png'],importDelayMs:700});
  await openEditor(page);await page.locator('#btn-open').click();await expect(activeEditor(page)).toHaveValue('original');
  await page.locator('#btn-attach').click();
  await expect.poll(()=>page.evaluate(()=>window.__testBridge.calls.invokes.some(call=>call.command==='import_document_attachment'))).toBe(true);
  await page.locator('#btn-new').click();await setEditorContent(page,'other');
  await expect(page.locator('#status')).toContainText('its link was not inserted');
  await expect(activeEditor(page)).toHaveValue('other');
});

test('editor essentials: external clean reload and dirty comparison preserve edits', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'first',sha256:'first'}}});
  await openEditor(page);await page.locator('#btn-open').click();await expect(activeEditor(page)).toHaveValue('first');
  await page.evaluate(()=>{window.__testBridge.documents['/a.md']={content:'second',sha256:'second'};window.dispatchEvent(new Event('focus'));});
  await expect(activeEditor(page)).toHaveValue('second');
  await setEditorContent(page,'my edits');
  await page.evaluate(()=>{window.__testBridge.documents['/a.md']={content:'third',sha256:'third'};window.dispatchEvent(new Event('focus'));});
  await page.getByRole('button',{name:'Compare changes'}).click();
  await expect(page.getByRole('textbox',{name:'Your edits',exact:true})).toHaveValue('my edits');
  await expect(page.getByRole('textbox',{name:'Disk version',exact:true})).toHaveValue('third');
  await page.getByRole('button',{name:'Keep editing',exact:true}).click();
  await expect(activeEditor(page)).toHaveValue('my edits');
  await page.getByRole('button',{name:'Compare changes'}).click();
  await page.getByRole('button',{name:'Reload from disk…',exact:true}).click();
  await page.getByRole('button',{name:'Discard and Reload',exact:true}).click();
  await expect(activeEditor(page)).toHaveValue('third');
});

test('editor essentials: tab context menu reveals and reopens the correct saved file', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'saved'}}});
  await openEditor(page);await page.locator('#btn-open').click();await expect(activeEditor(page)).toHaveValue('saved');
  const tab=page.locator('#document-tabs [role="tab"]').filter({hasText:'a.md'});
  await tab.click({button:'right'});
  await page.getByRole('menuitem',{name:'Show in file manager'}).click();
  expect(await page.evaluate(()=>window.__testBridge.calls.invokes.filter(c=>c.command==='reveal_document'))).toEqual([{command:'reveal_document',args:{path:'/a.md'}}]);
  await tab.focus();await tab.press('Shift+F10');
  await page.getByRole('menuitem',{name:'Close tab',exact:true}).click();
  await expect(tab).toHaveCount(0);
  await page.keyboard.press('Control+Shift+t');
  await expect(tab).toHaveCount(1);await expect(activeEditor(page)).toHaveValue('saved');
});

test('editor essentials: desktop controls stay absent in the browser build', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#btn-editor-options')).toBeVisible();
  await expect(page.locator('#btn-attach')).toBeHidden();
  await expect(page.locator('#document-menu')).toHaveCount(0);
  await expect(page.locator('.external-banner')).toHaveCount(0);
});

test('editor essentials: search options follow tab queries', async ({page}) => {
  await installFakeTauri(page);await openEditor(page);
  await setEditorContent(page,'a.b axb');await activeEditor(page).press('Control+f');
  await page.locator('#find-input').fill('a.b');
  await expect(page.locator('#find-count')).toHaveText('1/1');
  const firstId=await page.evaluate(()=>window.__MDEDIT_TEST_HOOK__.controller.activeDocument().id);
  await page.locator('#btn-new').click();await setEditorContent(page,'a.b axb');
  await activeEditor(page).press('Control+f');await page.locator('#find-input').fill('a.b');await page.locator('#find-regex').check();
  await expect(page.locator('#find-count')).toHaveText('1/2');
  await page.locator(`#document-tabs [role="tab"][data-document-id="${firstId}"]`).click();
  await expect(page.locator('#find-regex')).not.toBeChecked();await expect(page.locator('#find-count')).toHaveText('1/1');
  await page.keyboard.press('Control+Tab');await expect(page.locator('#find-regex')).toBeChecked();
});

test('editor essentials: pasted images save untitled documents before import, and cancel imports nothing', async ({page}) => {
  await installFakeTauri(page,{savePath:'/notes/pasted.md',assets:{'assets/imported.png':{bytes:pixelBytes,mime:'image/png'}}});
  await openEditor(page);await setEditorContent(page,'draft');
  await activeEditor(page).evaluate((el,bytes)=>{
    el.focus();el.setSelectionRange(el.value.length,el.value.length);
    const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'paste.png',{type:'image/png'}));
    el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  },pixelBytes);
  await expect(activeEditor(page)).toHaveValue('draft![paste.png](assets/imported.png)\n');
  const commands=await page.evaluate(()=>window.__testBridge.calls.invokes.map(c=>c.command));
  expect(commands.indexOf('save_document')).toBeLessThan(commands.indexOf('import_document_asset'));
  const other=await page.context().newPage();await installFakeTauri(other);await openEditor(other);
  await activeEditor(other).evaluate(el=>{
    const data=new DataTransfer();data.items.add(new File(['image'],'x.png',{type:'image/png'}));
    el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await expect.poll(()=>other.evaluate(()=>window.__testBridge.calls.invokes.some(c=>c.command==='import_document_asset'))).toBe(false);
  await other.close();
});

test('editor essentials: exports reread changed image bytes and reject missing local images', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'![x](assets/x.png)'}},assets:{'assets/x.png':{bytes:pixelBytes,mime:'image/png'}},savePath:'/out/a.html'});
  await openEditor(page);await page.locator('#btn-open').click();
  await expect(page.locator('#preview img')).toHaveAttribute('src',/^data:/);
  await page.evaluate(()=>{window.__testBridge.assets['assets/x.png']={bytes:Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="2" height="1" fill="red"/></svg>')),mime:'image/svg+xml'};});
  await page.locator('#btn-export').click();await page.locator('[data-exp="html"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__testBridge.calls.writes.length)).toBe(1);
  const exported=await page.evaluate(()=>new TextDecoder().decode(new Uint8Array(window.__testBridge.calls.writes[0].data)));
  expect(exported).toContain('data:image/svg+xml;base64,');
  expect(await page.evaluate(()=>window.__testBridge.calls.invokes.filter(c=>c.command==='read_document_asset').length)).toBeGreaterThanOrEqual(2);
  await setEditorContent(page,'![missing](assets/nope.png)');
  await page.locator('#btn-export').click();await page.locator('[data-exp="html"]').click();
  await expect(page.locator('#status')).toContainText('Could not include assets/nope.png');
  expect(await page.evaluate(()=>window.__testBridge.calls.writes.length)).toBe(1);
});

for (const theme of ['light','dark']) test(`editor essentials: controls fit the minimum desktop window in ${theme} mode`, async ({page}) => {
  await page.setViewportSize({width:700,height:480});await page.emulateMedia({colorScheme:theme});
  await installFakeTauri(page);await openEditor(page);
  await page.locator('#btn-editor-options').click();
  const box=await page.locator('#editor-options').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(700);expect(box.y+box.height).toBeLessThanOrEqual(480);
  await page.screenshot({path:`/tmp/mdedit-editor-${theme}.png`});
  await page.locator('#editor-options').press('Escape');
  await activeEditor(page).press('Control+f');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(overflow).toBe(false);
});

test('editor essentials: native drop inserts attachments before opening dropped documents', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'a\n'},'/b.md':{content:'b'}},assets:{'assets/imported.png':{bytes:pixelBytes,mime:'image/png'}}});
  await openEditor(page);await page.locator('#btn-open').click();await expect(activeEditor(page)).toHaveValue('a\n');
  await activeEditor(page).press('Control+End');await page.evaluate(()=>window.__testBridge.drop(['/photo.png','/b.md']));
  await expect(activeEditor(page)).toHaveValue('b');
  await page.locator('#document-tabs [role="tab"]').filter({hasText:'a.md'}).click();
  await expect(activeEditor(page)).toHaveValue('a\n![photo.png](assets/imported.png)\n');
});

test('editor essentials: Save As resolves visible images from the new document folder', async ({page}) => {
  const svgBytes=Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"/>'));
  await installFakeTauri(page,{openPaths:['/old/a.md'],documents:{'/old/a.md':{content:'![x](x.png)'}},savePath:'/new/a.md',assets:{'/old/a.md':{'x.png':{bytes:pixelBytes,mime:'image/png'}},'/new/a.md':{'x.png':{bytes:svgBytes,mime:'image/svg+xml'}}}});
  await openEditor(page);await page.locator('#btn-open').click();
  await expect(page.locator('#preview img')).toHaveAttribute('src',/^data:image\/png/);
  await activeEditor(page).press('Control+Shift+s');
  await expect(page.locator('#preview img')).toHaveAttribute('src',/^data:image\/svg\+xml/);
});

test('editor essentials: PNG and PDF exports include decoded local images', async ({page}) => {
  await installFakeTauri(page,{openPaths:['/a.md'],documents:{'/a.md':{content:'![x](assets/x.png)'}},assets:{'assets/x.png':{bytes:pixelBytes,mime:'image/png'}},savePath:'/out/a.png'});
  await openEditor(page);await page.locator('#btn-open').click();await expect(page.locator('#preview img')).toHaveAttribute('src',/^data:image\/png/);
  await page.locator('#btn-export').click();await page.locator('[data-exp="png"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__testBridge.calls.writes.length)).toBe(1);
  expect(await page.evaluate(()=>Array.from(window.__testBridge.calls.writes[0].data).slice(0,8))).toEqual([137,80,78,71,13,10,26,10]);
  await page.evaluate(()=>{window.__printedImage=null;window.print=()=>{const img=document.querySelector('#preview img');window.__printedImage={src:img.src,width:img.naturalWidth};};});
  await page.locator('#btn-export').click();await page.locator('[data-exp="pdf"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__printedImage?.width)).toBe(1);
  expect(await page.evaluate(()=>window.__printedImage.src)).toMatch(/^data:image\/png/);
});
