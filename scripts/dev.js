// Serve panel sources directly; build once for the same vendor assets as dist/.
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src");
const vendor = path.join(root, "dist", "vendor");
const { values } = parseArgs({ options: { port: { type: "string", default: "5173" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("--port must be an integer from 0 to 65535 (0 chooses a free port)");
}
execFileSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });

const clients = new Set();
let revision = Date.now();
let reloadTimer;
const reload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    revision++;
    for (const client of clients) client.write(`data: ${revision}\n\n`);
  }, 100);
};
const watchers = [
  fs.watch(source, { recursive: true }, reload),
  // Watch the directory so editor saves that replace package.json stay observable.
  fs.watch(root, (_event, filename) => {
    if (filename === null || filename === "package.json") reload();
  }),
  fs.watch(__dirname, (_event, filename) => {
    if (filename === null || ["dev-data.js", "dev-preview.js"].includes(filename)) reload();
  }),
];

const clientScript = `"use strict";
(() => {
  let revision;
  const events = new EventSource("/__dev/events");
  events.onmessage = ({ data }) => {
    if (revision !== undefined && revision !== data) location.reload();
    revision = data;
  };
})();
`;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = http.createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      response.writeHead(302, { Location: "/panel/panel.html" }).end();
      return;
    }
    if (pathname === "/__dev/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      clients.add(response);
      response.write(`data: ${revision}\n\n`);
      response.on("close", () => clients.delete(response));
      return;
    }
    if (pathname === "/__dev/client.js") {
      response.writeHead(200, { "Content-Type": contentTypes[".js"] });
      response.end(request.method === "HEAD" ? undefined : clientScript);
      return;
    }
    if (pathname === "/__dev/data.js") {
      const dataModule = require.resolve("./dev-data.js");
      delete require.cache[dataModule];
      const { createSampleCapture } = require(dataModule);
      response.writeHead(200, { "Content-Type": contentTypes[".js"] });
      response.end(
        request.method === "HEAD"
          ? undefined
          : `window.DEV_CAPTURE = ${JSON.stringify(createSampleCapture())};\n`
      );
      return;
    }
    if (pathname === "/__dev/preview.js") {
      response.writeHead(200, { "Content-Type": contentTypes[".js"] });
      response.end(
        request.method === "HEAD"
          ? undefined
          : fs.readFileSync(path.join(__dirname, "dev-preview.js"))
      );
      return;
    }
    const isVendor = pathname.startsWith("/vendor/");
    const base = isVendor ? vendor : source;
    const relative = isVendor ? pathname.slice("/vendor/".length) : pathname.slice(1);
    const file = path.resolve(base, relative);
    const inside = (candidate) => {
      const resolved = path.relative(base, candidate);
      return (
        resolved !== ".." && !resolved.startsWith(`..${path.sep}`) && !path.isAbsolute(resolved)
      );
    };
    if (!inside(file) || !inside(fs.realpathSync(file))) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!fs.statSync(file).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    let body = fs.readFileSync(file);
    if (file === path.join(source, "panel", "panel.html")) {
      const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      body = body
        .toString("utf8")
        .replace("{{version}}", version)
        .replace(
          "</head>",
          '<script src="/__dev/data.js"></script><script src="/__dev/preview.js"></script></head>'
        )
        .replace("</body>", '<script src="/__dev/client.js"></script></body>');
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status = error instanceof URIError ? 400 : error.code === "ENOENT" ? 404 : 500;
    if (status === 500) console.error(error);
    response.writeHead(status).end(http.STATUS_CODES[status]);
  }
});

const heartbeat = setInterval(() => {
  for (const client of clients) client.write(": keep-alive\n\n");
}, 15000);
server.on("error", (error) => {
  console.error(error.message);
  shutdown(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Live panel: http://127.0.0.1:${server.address().port}/panel/panel.html`);
  console.log("Watching src/, package.json, and demo data. Save to reload; Ctrl+C to stop.");
});

function shutdown(code = 0) {
  clearTimeout(reloadTimer);
  clearInterval(heartbeat);
  for (const watcher of watchers) watcher.close();
  for (const client of clients) client.end();
  server.close();
  server.closeAllConnections();
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
