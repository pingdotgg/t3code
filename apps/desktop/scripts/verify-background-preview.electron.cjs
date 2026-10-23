// Electron entry for verify-background-preview.mjs. CommonJS, because an ESM
// entry delays `ready` until its top-level await settles.
const NodeFS = require("node:fs");
const NodeOS = require("node:os");
const NodePath = require("node:path");
const NodeURL = require("node:url");
const { app, BrowserWindow, nativeImage } = require("electron");

const testHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-background-preview-"));
app.setPath("userData", NodePath.join(testHome, "userdata"));
app.on("quit", () => NodeFS.rmSync(testHome, { recursive: true, force: true }));

const CAPTURE_TIMEOUT_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, ms) =>
  Promise.race([
    promise.then((value) => ({ ok: true, value })),
    sleep(ms).then(() => ({ ok: false })),
  ]);
const page = (html) => `data:text/html,${encodeURIComponent(html)}`;

async function captureColor(tab, rgb) {
  await tab.debugger.sendCommand("Runtime.evaluate", {
    expression: `document.body.style.background = 'rgb(${rgb.join(",")})'`,
  });
  const shot = await withTimeout(
    tab.debugger.sendCommand("Page.captureScreenshot", { format: "png" }),
    CAPTURE_TIMEOUT_MS,
  );
  if (!shot.ok) return "timed out";
  const pixels = nativeImage.createFromBuffer(Buffer.from(shot.value.data, "base64")).toBitmap();
  const got = [pixels[2], pixels[1], pixels[0]];
  // Color management can shift a channel by a few levels.
  return got.every((value, index) => Math.abs(value - rgb[index]) <= 6)
    ? null
    : `stale: rgb(${got.join(",")})`;
}

async function main() {
  const { backgroundTabWindowOptions } = await import(
    NodeURL.pathToFileURL(NodePath.join(__dirname, "../src/preview/BackgroundTabWindow.ts")).href
  );
  const preload = NodePath.join(testHome, "preload.cjs");
  NodeFS.writeFileSync(preload, "");
  // Each state closes its windows, which would otherwise quit the app.
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const failures = [];
  for (const state of ["hidden", "minimized"]) {
    console.log(`Checking app window ${state}`);
    const appWindow = new BrowserWindow({ width: 480, height: 320, show: true });
    await appWindow.loadURL(page("<body>T3 Code</body>"));
    await sleep(500);
    if (state === "hidden") appWindow.hide();
    else appWindow.minimize();
    await sleep(1_500);

    // Created only after the app window is gone, as an agent's tab would be.
    const tabWindow = new BrowserWindow(
      backgroundTabWindowOptions({
        partition: `t3-background-preview-${state}`,
        preload,
        passkeyBridgeArgument: undefined,
      }),
    );
    await tabWindow.loadURL(page("<body style='margin:0'></body>"));
    console.log(`Background tab loaded (${state})`);
    const tab = tabWindow.webContents;
    tab.debugger.attach("1.3");
    for (const [step, rgb] of [
      [1, [0, 200, 0]],
      [2, [200, 200, 0]],
      [3, [0, 200, 200]],
    ]) {
      const failure = await captureColor(tab, rgb);
      console.log(`App window ${state}, capture ${step}: ${failure ?? "fresh"}`);
      if (failure) failures.push(`app window ${state}, capture ${step}: ${failure}`);
      await sleep(1_000);
    }
    tabWindow.destroy();
    appWindow.destroy();
  }

  if (failures.length > 0) {
    console.error("Background preview tabs stopped painting:");
    for (const failure of failures) console.error(` - ${failure}`);
    app.exit(1);
    return;
  }
  console.log("Background preview tabs paint while the app window is hidden or minimized.");
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
