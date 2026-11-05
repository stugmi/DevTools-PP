// DevTools page: registers the Source Exporter panel and tells the panel page
// when it is shown or hidden, so it only does capture work while visible.

chrome.devtools.panels.create(
  "Source Exporter",
  "icons/icon16.png",
  "panel/panel.html",
  (panel) => {
    let activePanelWindow = null;
    // Whether the panel is visible, so a late PANEL_READY gets the PANEL_SHOWN it missed.
    let shown = false;
    const post = (type) => {
      try {
        activePanelWindow?.postMessage({ type }, location.origin);
      } catch (_) {
        // The panel page may not be ready yet or may already be gone.
      }
    };
    panel.onShown.addListener((shownWindow) => {
      activePanelWindow = shownWindow;
      shown = true;
      post("PANEL_SHOWN");
    });
    panel.onHidden.addListener(() => {
      shown = false;
      post("PANEL_HIDDEN");
    });
    // Sent by the panel page once its capture script has run. Every DevTools page receives
    // it, so only answer for this inspected tab.
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "PANEL_READY") return;
      if (message.tabId !== chrome.devtools.inspectedWindow.tabId) return;
      if (shown) post("PANEL_SHOWN");
    });
  }
);
