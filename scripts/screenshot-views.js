// Drives the loaded DevTools++ panel through the scenes used by the docs screenshots.
// The parent script supplies a Playwright page with the demo capture loaded (viewport and
// device scale are configured there) and an absolute output directory.
const path = require("node:path");

const VISIBLE = { state: "visible", timeout: 20000 };

function shot(page, outputDir, name) {
  return page.screenshot({
    path: path.join(outputDir, name),
    animations: "disabled",
    caret: "hide",
  });
}

async function settled(page) {
  await page.evaluate(() => document.fonts.ready);
  // Two frames so Monaco and the virtualised lists have painted the latest state.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function panelReady(page) {
  await page.locator("#title").filter({ hasText: "DevTools++" }).waitFor(VISIBLE);
  await page.waitForFunction(
    () => /\d+ mapped/.test(document.getElementById("status-text")?.textContent || ""),
    null,
    { timeout: 30000 }
  );
  await page.locator("#btn-export-all:not([disabled])").waitFor(VISIBLE);
  await closeOverlays(page);
}

async function closeOverlays(page) {
  const open = async () =>
    page.evaluate(() => {
      const shown = (id) => {
        const node = document.getElementById(id);
        return Boolean(node) && !node.hidden && node.style.display !== "none";
      };
      return [
        "quick-picker",
        "editor-settings-modal",
        "source-filter-popover",
        "context-menu",
        "request-domain-popover",
      ].some(shown);
    });
  for (let i = 0; i < 4 && (await open()); i++) {
    await page.keyboard.press("Escape");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  if (await open()) throw new Error("An overlay stayed open after Escape");
}

async function showWorkspace(page, workspace) {
  const tab = page.locator(`.workspace-tab[data-workspace="${workspace}"]`);
  await tab.click();
  await page.locator(`.workspace-tab[data-workspace="${workspace}"].active`).waitFor(VISIBLE);
}

async function showView(page, view) {
  const panel = page.locator(`.view[data-view="${view}"]`);
  if (!(await panel.isVisible())) {
    await page.locator(`.activity-btn[data-view="${view}"]`).click();
  }
  await panel.waitFor(VISIBLE);
}

async function editorShows(page, text) {
  await page.waitForFunction(
    (needle) => {
      const lines = document.querySelector("#editor-container .view-lines");
      return Boolean(lines) && lines.textContent.replace(/\u00a0/g, " ").includes(needle);
    },
    text,
    { timeout: 20000 }
  );
}

// Opens a file through the quick picker; the tree reveals it, expanding its folders.
async function openSampleFile(page, fileName, firstLine) {
  await showWorkspace(page, "files");
  await showView(page, "explorer");
  await page.keyboard.press("Control+P");
  const input = page.locator("#quick-picker-input");
  await input.waitFor(VISIBLE);
  await input.fill(fileName);
  const item = page
    .locator("#quick-picker-results .quick-picker-item")
    .filter({ hasText: "mapped" })
    .filter({ hasText: fileName })
    .first();
  await item.waitFor(VISIBLE);
  await item.click();
  await page.locator("#quick-picker").waitFor({ state: "hidden", timeout: 20000 });
  await page
    .locator(".preview-tab.active .tab-name")
    .filter({ hasText: fileName })
    .waitFor(VISIBLE);
  await page
    .locator(`#tree-root .tree-node.selected[data-type="file"]`)
    .filter({ hasText: fileName })
    .waitFor(VISIBLE);
  await editorShows(page, firstLine);
  await settled(page);
}

async function openSettings(page, category) {
  await page.locator("#btn-settings").click();
  await page.locator("#editor-settings-modal").waitFor(VISIBLE);
  const nav = page.locator("#es-nav .es-nav-item").filter({ hasText: category });
  await nav.first().waitFor(VISIBLE);
  await nav.first().click();
  await settled(page);
}

async function closeSettings(page) {
  await page.locator("#es-close").click();
  await page.locator("#editor-settings-modal").waitFor({ state: "hidden", timeout: 20000 });
}

async function themeOf(page) {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

async function waitTheme(page, theme) {
  await page.waitForFunction(
    (wanted) => document.documentElement.getAttribute("data-theme") === wanted,
    theme,
    { timeout: 20000 }
  );
}

async function captureFileViews(page, outputDir) {
  await panelReady(page);
  await openSampleFile(page, "ProductCard.tsx", "useState");
  await shot(page, outputDir, "files-editor.png");

  // Navy theme through Settings > Appearance, then back to the default.
  const defaultTheme = await themeOf(page);
  await openSettings(page, "Appearance");
  const row = page.locator('.es-row[data-setting-key="se.editorTheme"]');
  await row.waitFor(VISIBLE);
  await row.locator("select").selectOption("source-exporter");
  await waitTheme(page, "source-exporter");
  await closeSettings(page);
  await editorShows(page, "useState");
  await settled(page);
  await shot(page, outputDir, "files-editor-navy.png");

  await openSettings(page, "Appearance");
  const reset = page.locator('.es-row[data-setting-key="se.editorTheme"] .es-reset-btn');
  await reset.click();
  await waitTheme(page, defaultTheme);
  await closeSettings(page);
  await settled(page);
}

async function captureSearch(page, outputDir) {
  await showWorkspace(page, "files");
  await showView(page, "search");
  const input = page.locator("#workspace-search-input");
  await input.fill("useCart");
  const group = page.locator(".search-file-group").filter({
    has: page.locator(".search-file-name", { hasText: /^useCart\.ts$/ }),
  });
  await group.waitFor(VISIBLE);
  await page.waitForFunction(
    () =>
      /matches? in \d+ files?/.test(
        document.getElementById("workspace-search-summary").textContent
      ),
    null,
    { timeout: 20000 }
  );
  await group.locator(".workspace-search-result").first().click();
  await page
    .locator(".preview-tab.active .tab-name")
    .filter({ hasText: "useCart.ts" })
    .waitFor(VISIBLE);
  await editorShows(page, "export function useCart");
  await settled(page);
  await shot(page, outputDir, "search.png");
  await input.fill("");
  await page.waitForFunction(
    () => !document.querySelector("#workspace-search-results .workspace-search-result"),
    null,
    { timeout: 20000 }
  );
}

async function captureSourceFilter(page, outputDir) {
  await openSampleFile(page, "ProductCard.tsx", "useState");
  await page.locator("#btn-source-filter").click();
  const popover = page.locator("#source-filter-popover");
  await popover.waitFor(VISIBLE);
  await popover.getByRole("button", { name: /^TypeScript/ }).click();
  await popover.getByRole("button", { name: /^Styles/ }).click();
  await page.locator("#sf-exclude").fill("path:pages");
  await page.waitForFunction(
    () => {
      const badge = document.getElementById("source-filter-badge");
      const summary = document.getElementById("sf-summary").textContent;
      return badge && !badge.hidden && /Showing \d+ of \d+ files/.test(summary);
    },
    null,
    { timeout: 20000 }
  );
  await page.locator("#sf-include").focus();
  await settled(page);
  await shot(page, outputDir, "source-filter.png");
  await page.locator("#sf-clear").click();
  await page.waitForFunction(
    () =>
      !document.getElementById("sf-include").value && !document.getElementById("sf-exclude").value,
    null,
    { timeout: 20000 }
  );
  await closeOverlays(page);
}

async function captureSettings(page, outputDir) {
  await showWorkspace(page, "files");
  await openSettings(page, "Code Formatting");
  const title = page.locator(".es-section-title").filter({ hasText: "Code Formatting" });
  await title.waitFor(VISIBLE);
  await page.locator('.es-row[data-setting-key="se.codeBraceStyle"]').waitFor(VISIBLE);
  await settled(page);
  await shot(page, outputDir, "settings.png");
  await closeSettings(page);
}

function requestRow(page, method, urlPath) {
  return page
    .locator("#network-table-body .network-row")
    .filter({ has: page.locator(".network-cell-method", { hasText: new RegExp(`^${method}$`) }) })
    .filter({ has: page.locator(".network-cell-url", { hasText: urlPath }) });
}

async function selectRequest(page, method, urlPath, tab) {
  const row = requestRow(page, method, urlPath).first();
  await row.waitFor(VISIBLE);
  await row.click();
  await page.locator("#request-detail").waitFor(VISIBLE);
  await page.locator(`#request-tab-${tab}`).click();
  await page.locator(`#request-tab-${tab}[aria-selected="true"]`).waitFor(VISIBLE);
}

async function captureNetwork(page, outputDir) {
  await showWorkspace(page, "network");
  await showView(page, "requests");
  await page.locator("#network-table-body .network-row").first().waitFor(VISIBLE);

  // Formatted JSON response.
  await selectRequest(page, "GET", "/v2/products", "response");
  await page.locator("#request-body-view-toggle [data-body-view='source']").click();
  const viewer = page.locator("#request-response-viewer");
  await viewer.locator(".monaco-editor").waitFor(VISIBLE);
  await page.waitForFunction(
    () => {
      const lines = document.querySelector("#request-response-viewer .view-lines");
      return Boolean(lines) && lines.textContent.includes("sku_10482");
    },
    null,
    { timeout: 20000 }
  );
  await settled(page);
  await shot(page, outputDir, "network-response.png");

  // Binary protobuf response in the hex viewer with the Data Inspector.
  await selectRequest(page, "GET", "/v1/recommendations", "response");
  const hexHost = page.locator("#request-response-hex");
  await hexHost.locator(".hexv-row").first().waitFor(VISIBLE);
  await hexHost.locator(".hexv-select").selectOption("text");
  await hexHost.locator(".hexv-find").fill("Trail Runner GTX");
  await hexHost.locator(".hexv-find").press("Enter");
  await hexHost
    .locator(".hexv-st-sel")
    .filter({ hasText: /\| 16 bytes\)/ })
    .waitFor(VISIBLE);
  await hexHost.locator(".hexv-b.sel").first().waitFor(VISIBLE);
  await hexHost.locator(".hexv-ilist").waitFor(VISIBLE);
  await settled(page);
  await shot(page, outputDir, "network-hex.png");

  // Request context menu with the Copy as formats.
  await selectRequest(page, "POST", "/v2/cart", "payload");
  await page.locator("#request-payload-viewer .monaco-editor").waitFor(VISIBLE);
  await page.waitForFunction(
    () =>
      document
        .querySelector("#request-payload-viewer .view-lines")
        ?.textContent.includes("sku_10482"),
    null,
    { timeout: 20000 }
  );
  await requestRow(page, "POST", "/v2/cart").first().click({ button: "right" });
  const menu = page.locator("#context-menu");
  await menu.waitFor(VISIBLE);
  await menu.locator(".ctx-submenu-trigger").hover();
  const submenu = page.locator("#context-submenu");
  await submenu.waitFor(VISIBLE);
  await submenu.getByRole("menuitem", { name: /cURL \(bash\)/ }).waitFor(VISIBLE);
  await settled(page);
  await shot(page, outputDir, "network-copy-as.png");
  await closeOverlays(page);
}

async function captureSampleViews(page, outputDir) {
  await panelReady(page);
  await captureSearch(page, outputDir);
  await captureSourceFilter(page, outputDir);
  await captureSettings(page, outputDir);
  await captureNetwork(page, outputDir);
  await showWorkspace(page, "files");
}

module.exports = { captureFileViews, captureSampleViews };
