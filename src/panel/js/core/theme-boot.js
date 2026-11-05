// Applies the saved editor theme and workspace from <head> before first paint, so the panel
// doesn't flash. External script because the extension CSP blocks inline scripts.
// Same defaults as state.js.
const bootRoot = document.documentElement;
bootRoot.setAttribute("data-theme", "vs-dark");
bootRoot.setAttribute("data-workspace", "files");
try {
  bootRoot.setAttribute("data-theme", localStorage.getItem("se.editorTheme") || "vs-dark");
  bootRoot.setAttribute(
    "data-workspace",
    localStorage.getItem("se.workspace") === "network" ? "network" : "files"
  );
} catch {
  // localStorage unavailable: keep the defaults.
}
