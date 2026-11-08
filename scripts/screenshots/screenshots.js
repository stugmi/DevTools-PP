// Render the same simulated panel as `bun run dev`, without an inspected browser tab.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const { captureFileViews, captureSampleViews } = require("./screenshot-views.js");

const root = path.resolve(__dirname, "..", "..");
const names = [
  "files-editor.png",
  "files-editor-navy.png",
  "search.png",
  "source-filter.png",
  "settings.png",
  "network-response.png",
  "network-hex.png",
  "network-copy-as.png",
];

function startPreview() {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "dev", "dev.js"), "--port", "0"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const ready = new Promise((resolve, reject) => {
    let log = "";
    const deadline = setTimeout(
      () => reject(new Error(`Preview startup timed out:\n${log}`)),
      30000
    );
    const finish = (error, url) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(url);
    };
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`Preview exited (${code}):\n${log}`)));
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.stdout.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/Live panel: (http:\/\/127\.0\.0\.1:\d+\/panel\/panel\.html)/);
      if (match) finish(null, match[1]);
    });
  });
  return { child, ready };
}

async function launchRenderer() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!error.message.includes("Executable doesn't exist")) throw error;
    console.log("Installing the isolated screenshot renderer...");
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    execFileSync(process.execPath, [cli, "install", "chromium", "--only-shell", "--no-remove"], {
      stdio: "inherit",
    });
    return chromium.launch({ headless: true });
  }
}

async function render(browser, url, directory, capture) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  try {
    // The fixture's URLs are labels, not destinations. Rendering must remain local.
    const origin = new URL(url).origin;
    await context.route("**/*", (route) => {
      const target = new URL(route.request().url());
      return target.origin === origin || ["data:", "blob:"].includes(target.protocol)
        ? route.continue()
        : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(url, { waitUntil: "load" });
    await capture(page, directory);
    if (errors.length) throw new AggregateError(errors, "Panel errors during screenshot capture");
  } finally {
    await context.close();
  }
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-screenshots-"));
  const { child, ready } = startPreview();
  let browser;
  try {
    const url = await ready;
    browser = await launchRenderer();
    await render(browser, url, temporary, captureFileViews);
    await render(browser, url, temporary, captureSampleViews);
    // Only publish the new set after every required scene was captured successfully.
    const output = path.join(root, "docs", "images");
    fs.mkdirSync(output, { recursive: true });
    for (const name of names) {
      fs.copyFileSync(path.join(temporary, name), path.join(output, name));
      console.log(`Updated docs/images/${name}`);
    }
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
