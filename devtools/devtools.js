// Register the main DevTools panel.
// Chrome's native DevTools tab strip right-click menu (Close / Move to drawer /
// Move left / Move right) is provided automatically for any panel registered
// this way — no extra work needed.  If it doesn't appear, it usually means the
// DevTools window lost focus; click the tab once then right-click.
chrome.devtools.panels.create(
  "Source Exporter",
  "/icons/icon16.png",
  "/panel/panel.html",
  (panel) => {
    // panel.onShown fires each time the user switches to this tab.
    // We message the panel page so it can refresh state if needed.
    panel.onShown.addListener((panelWindow) => {
      try {
        panelWindow.postMessage({ type: "PANEL_SHOWN" }, "*");
      } catch (_) {}
    });

    panel.onHidden.addListener(() => {
      // Nothing needed, but the listener pair keeps the panel "active"
      // in Chrome's tab-strip, which is what enables the right-click menu.
    });
  }
);
