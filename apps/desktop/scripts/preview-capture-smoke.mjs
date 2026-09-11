// Run with Electron: electron apps/desktop/scripts/preview-capture-smoke.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import * as Effect from "effect/Effect";
import { capturePreviewPage } from "../src/preview/PreviewCapture.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-preview-capture-"));
app.setPath("userData", directory);
app.commandLine.appendSwitch("force-device-scale-factor", "2");
const page = `<!doctype html><style>
body { margin:48px; background:white; color:#171717; font:14px Arial }
.lines { width:160px; height:64px; margin-top:24px;
background:repeating-linear-gradient(90deg,#171717 0 1px,white 1px 2px) }
</style><p>Search projects</p><p>Ready for review</p><div class="lines"></div>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1500,
    height: 1000,
    webPreferences: { webviewTag: true, backgroundThrottling: false },
  });
  try {
    const attached = new Promise((resolve) => {
      window.webContents.once("did-attach-webview", (_event, guest) => {
        guest.once("did-finish-load", () => resolve(guest.id));
      });
    });
    await window.loadURL(
      "data:text/html," +
        encodeURIComponent(`<style>img { max-width:100%; height:auto }</style><body style="margin:0;background:black">
<webview data-preview-tab="test" style="position:absolute;left:0;top:0;display:flex;width:1280px;height:800px;transform-origin:top left"
src="data:text/html,${encodeURIComponent(page)}"></webview>`),
    );
    const guest = webContents.fromId(await attached);
    guest.setBackgroundThrottling(false);
    const capture = (rect) =>
      Effect.runPromise(capturePreviewPage("test", guest, rect).pipe(Effect.timeout("5 seconds")));
    const present = async (scale) => {
      await window.webContents.executeJavaScript(`(() => {
      document.querySelector("webview").style.transform = ${JSON.stringify(scale === 1 ? "none" : `scale(${scale})`)};
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
      await guest.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    };
    const viewport = () => guest.executeJavaScript("[innerWidth, innerHeight, devicePixelRatio]");
    const assertRestored = async () => {
      NodeAssert.equal(
        await window.webContents.executeJavaScript(
          'document.querySelectorAll("[id^=preview-capture-]").length',
        ),
        0,
      );
      NodeAssert.equal(
        await window.webContents.executeJavaScript(
          'getComputedStyle(document.querySelector("webview")).opacity',
        ),
        "1",
      );
    };

    for (const zoom of [1, 1.25]) {
      guest.setZoomFactor(zoom);
      await present(1);
      const baseline = await capture();
      const dimensions = await viewport();
      for (const scale of [0.4, 0.15]) {
        await present(scale);
        const before = await guest.capturePage();
        NodeAssert.notDeepEqual(before.toBitmap(), baseline.toBitmap());
        const after = await capture();
        NodeAssert.deepEqual(after.toBitmap(), baseline.toBitmap());
        for (const [name, image] of [
          ["before", before],
          ["after", after],
        ]) {
          NodeFS.writeFileSync(
            NodePath.join(directory, `${name}-${zoom}-${scale}.png`),
            image.resize({ width: 1280 }).toPNG(),
          );
        }
        NodeAssert.deepEqual(await viewport(), dimensions);
        await assertRestored();
        console.log(`PASS: scale=${scale}, zoom=${zoom}, native pixels match wide preview`);
      }
    }

    const [first, second] = await Promise.all([capture(), capture()]);
    NodeAssert.deepEqual(first.toBitmap(), second.toBitmap());
    await assertRestored();
    const originalCapture = guest.capturePage.bind(guest);
    let calls = 0;
    guest.capturePage = async (...args) => {
      if (++calls === 2) {
        const frozenWidth = await window.webContents.executeJavaScript(
          'document.querySelector("[id^=preview-capture-] img").getBoundingClientRect().width',
        );
        NodeAssert.equal(frozenWidth, 1280 * 0.15);
        throw new Error("capture failed");
      }
      return originalCapture(...args);
    };
    await NodeAssert.rejects(capture(), (error) => error.cause?.message === "capture failed");
    await assertRestored();
    guest.capturePage = originalCapture;
    await capture();
    console.log("PASS: concurrent captures, failure cleanup, and subsequent capture");
    calls = 0;
    const started = Promise.withResolvers();
    guest.capturePage = (...args) => {
      if (++calls === 2) {
        started.resolve();
        return new Promise(() => {});
      }
      return originalCapture(...args);
    };
    const controller = new AbortController();
    const interrupted = Effect.runPromise(capturePreviewPage("test", guest), {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await NodeAssert.rejects(interrupted);
    await assertRestored();
    guest.capturePage = originalCapture;
    await capture();
    console.log("PASS: interrupted capture restores the preview and releases its lock");

    guest.setZoomFactor(1);
    await present(1);
    const rect = { x: 48, y: 110, width: 160, height: 64 };
    const crop = await capture(rect);
    await present(0.15);
    NodeAssert.deepEqual((await capture(rect)).toBitmap(), crop.toBitmap());
    console.log("PASS: annotation crop retains native pixels");
    await present(1);
    const visible = await capture();
    await window.webContents.executeJavaScript(
      'document.querySelector("webview").style.zIndex = "-1"',
    );
    NodeAssert.deepEqual((await capture()).toBitmap(), visible.toBitmap());
    await guest.executeJavaScript(
      'document.querySelector("p").textContent = "Changed in background"',
    );
    await guest.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const hidden = await capture();
    NodeAssert.notDeepEqual(hidden.toBitmap(), visible.toBitmap());
    await window.webContents.executeJavaScript(
      'document.querySelector("webview").style.zIndex = "0"',
    );
    NodeAssert.deepEqual((await capture()).toBitmap(), hidden.toBitmap());
    console.log("PASS: background capture sees current DOM changes");
    console.log(`Evidence: ${directory}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode ?? 0);
  }
});
