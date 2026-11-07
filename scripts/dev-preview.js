// Dev-server-only adapter: inspect the local demo capture, never an external tab.
"use strict";

(() => {
  const capture = window.DEV_CAPTURE;
  const event = () => {
    const listeners = new Set();
    return {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
      hasListener: (listener) => listeners.has(listener),
      dispatch: (...args) => {
        for (const listener of listeners) listener(...args);
      },
    };
  };
  const resources = capture.resources.map(({ content, encoding, ...resource }) => ({
    ...resource,
    getContent: (callback) => callback(content, encoding || null),
  }));
  const entries = capture.requests.map((entry) => ({
    ...entry,
    getContent: (callback) =>
      callback(entry.response.content.text ?? null, entry.response.content.encoding || null),
  }));
  const postVisibility = () =>
    window.postMessage({ type: document.hidden ? "PANEL_HIDDEN" : "PANEL_SHOWN" }, location.origin);

  window.chrome = {
    devtools: {
      inspectedWindow: {
        tabId: 0,
        getResources: (callback) => callback(resources),
        eval: (expression, callback) => {
          if (expression === "performance.timeOrigin") callback(performance.timeOrigin);
          else
            callback(null, {
              isException: true,
              value: "Demo inspection only supports page identity",
            });
        },
        onResourceAdded: event(),
      },
      network: {
        getHAR: (callback) => callback({ entries }),
        onNavigated: event(),
        onRequestFinished: event(),
      },
      panels: {
        openResource: (...args) => {
          const callback = args.at(-1);
          callback({ isError: true, description: "Native DevTools is unavailable in the demo" });
        },
      },
    },
    runtime: {
      sendMessage: async ({ type }) => {
        if (type !== "PANEL_READY") throw new Error(`Unsupported demo message: ${type}`);
        if (document.readyState === "complete") postVisibility();
        else window.addEventListener("load", postVisibility, { once: true });
      },
    },
    tabs: { create: ({ url }) => window.open(url, "_blank", "noopener,noreferrer") },
  };
  document.addEventListener("visibilitychange", postVisibility);
})();
