chrome.devtools.panels.create(
  "Source Exporter",
  "icons/icon16.png",
  "panel/panel.html",
  (panel) => {
    let activePanelWindow = null;
    panel.onShown.addListener((shownWindow) => {
      activePanelWindow = shownWindow;
      try {
        shownWindow.postMessage({ type: "PANEL_SHOWN" }, "*");
      } catch (_) {
        /* panel page may not be ready yet */
      }
    });
    panel.onHidden.addListener(() => {
      try {
        activePanelWindow?.postMessage({ type: "PANEL_HIDDEN" }, "*");
      } catch (_) {
        /* panel page may already be gone */
      }
    });
  }
);
