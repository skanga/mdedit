const { test, expect } = require("@playwright/test");
const { activeEditor, installFakeTauri, openEditor } = require("./helpers.js");

test("tabs retain content, selection, view, and accessible state", async ({ page }) => {
  await installFakeTauri(page);
  await openEditor(page);
  const first = page.getByRole("tab", { name: /Untitled 1/ });
  await activeEditor(page).fill("first document has a selection");
  await activeEditor(page).evaluate((editor) => {
    editor.setSelectionRange(6, 14);
    editor.scrollTop = 17;
  });
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  await page.getByRole("button", { name: "New document" }).click();
  await activeEditor(page).fill("# second");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await first.click();

  const firstEditor = page.locator(`textarea[data-document-id="${await first.getAttribute("data-document-id")}"]`);
  await expect(firstEditor).toHaveValue("first document has a selection");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("tabindex", "0");
  await expect(page.locator("body")).toHaveAttribute("data-view", "preview");
  await expect(first).toHaveAttribute("aria-controls", /document-panel-/);
  const state = await firstEditor.evaluate((editor) => ({
    start: editor.selectionStart,
    end: editor.selectionEnd,
    scrollTop: editor.scrollTop,
    panelHidden: editor.parentElement.hidden,
    panelRole: editor.parentElement.getAttribute("role"),
  }));
  expect(state).toMatchObject({ start: 6, end: 14, panelHidden: false, panelRole: "tabpanel" });
  expect(state.scrollTop).toBeGreaterThanOrEqual(0);
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
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("status")).toContainText("conflicted.md");
  await page.getByRole("button", { name: "Keep Editing" }).click();

  await page.getByRole("tab", { name: /failing\.md/ }).click();
  await activeEditor(page).fill("editor failure");
  await page.getByRole("button", { name: /^Save/ }).click();
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
  await page.getByRole("button", { name: "New document" }).click();
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
  await expect(page.getByRole("tab", { name: /broken-two\.md/ })).toHaveCount(0);
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
  await activeEditor(page).fill("editor-version");
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep Editing" }).click();
  await expect(activeEditor(page)).toHaveValue("editor-version");

  await page.getByRole("button", { name: /^Save/ }).click();
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
