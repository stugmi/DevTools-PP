chrome.devtools.panels.create(
  "Source Exporter",
  "/icons/icon16.png",
  "/panel/panel.html",
  (panel) => {
    panel.onShown.addListener((panelWindow) => {
      try {
        panelWindow.postMessage({ type: "PANEL_SHOWN" }, "*");
      } catch (_) {
        /* panel page may not be ready yet */
      }
    });
  }
);
