import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";

const { app, BrowserWindow, ipcMain, WebContentsView } = electron;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((value) => value.startsWith("--"))
    .map((value) => {
      const [key, ...rest] = value.slice(2).split("=");
      return [key, rest.join("=") || "true"];
    }),
);

const mode = args.mode ?? "automation";
const debugPort = Number(args.port ?? 0);
const outputDirectory = args.output;
const playwrightCoreBundle = args["playwright-core-bundle"];

function debug(message) {
  if (!outputDirectory) return;
  mkdirSync(outputDirectory, { recursive: true });
  appendFileSync(join(outputDirectory, "debug.log"), `${new Date().toISOString()} ${message}\n`);
}

debug(`startup electron=${process.versions.electron ?? "missing"}`);

const here = dirname(fileURLToPath(import.meta.url));
const guestUrl = new URL("./guest.html", import.meta.url).href;

function emitResult(result) {
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, "result.json"), JSON.stringify(result, null, 2));
  }
  process.stdout.write(`PHASE0_RESULT ${JSON.stringify(result)}\n`);
}

function attachDebugger(contents) {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  return (method, params) => contents.debugger.sendCommand(method, params);
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description;
    throw new Error(description ?? result.exceptionDetails.text ?? "Evaluation failed");
  }
  return result.result?.value;
}

function axValue(node, key) {
  return node[key]?.value ?? null;
}

async function runSemanticProbe(contents) {
  const send = attachDebugger(contents);
  await Promise.all([send("Runtime.enable"), send("DOM.enable"), send("Accessibility.enable")]);
  const tree = await send("Accessibility.getFullAXTree");
  const buttonNode = tree.nodes.find(
    (node) => axValue(node, "role") === "button" && axValue(node, "name") === "Increment count",
  );
  const inputNode = tree.nodes.find(
    (node) => axValue(node, "role") === "textbox" && axValue(node, "name") === "Message",
  );
  if (!buttonNode?.backendDOMNodeId || !inputNode?.backendDOMNodeId) {
    throw new Error("Semantic nodes were not found in the accessibility tree");
  }
  const box = await send("DOM.getBoxModel", { backendNodeId: buttonNode.backendDOMNodeId });
  const quad = box.model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  const resolvedInput = await send("DOM.resolveNode", { backendNodeId: inputNode.backendDOMNodeId });
  await send("Runtime.callFunctionOn", {
    objectId: resolvedInput.object.objectId,
    functionDeclaration: `function(value) {
      this.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(this, value);
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    arguments: [{ value: "semantic CDP attached" }],
  });
  const state = await evaluate(
    send,
    `({ count: document.querySelector('#count').textContent, value: document.querySelector('#message').value })`,
  );
  return {
    success: state.count === "1" && state.value === "semantic CDP attached",
    button: { role: axValue(buttonNode, "role"), name: axValue(buttonNode, "name") },
    input: { role: axValue(inputNode, "role"), name: axValue(inputNode, "name") },
    state,
  };
}

function readPlaywrightInjectedSource() {
  if (!playwrightCoreBundle) throw new Error("Playwright core bundle path is required");
  const bundle = readFileSync(playwrightCoreBundle, "utf8");
  const marker = "source3 = ";
  const start = bundle.indexOf(marker);
  const suffix = ";\n  }\n});\n\n// packages/playwright-core/src/server/dom.ts";
  const end = bundle.indexOf(suffix, start);
  if (start === -1 || end === -1) throw new Error("Could not locate Playwright injected source");
  const literal = bundle.slice(start + marker.length, end);
  return Function(`"use strict"; return (${literal});`)();
}

async function runInjectedRuntimeSpike(contents) {
  const send = attachDebugger(contents);
  await send("Runtime.enable");
  const injectedSource = readPlaywrightInjectedSource();
  const installStartedAt = performance.now();
  const install = await evaluate(
    send,
    `(() => {
      const module = {};
      ${injectedSource}
      const injected = new (module.exports.InjectedScript())(globalThis, {
        isUnderTest: false,
        sdkLanguage: "javascript",
        testIdAttributeName: "data-testid",
        stableRafCount: 2,
        browserName: "chromium",
        shouldPrependErrorPrefix: false,
        isUtilityWorld: true,
        customEngines: [],
      });
      globalThis.__phase05Injected = injected;
      return {
        methods: Object.getOwnPropertyNames(Object.getPrototypeOf(injected)).sort(),
        bytes: ${Buffer.byteLength(injectedSource)},
      };
    })()`,
  );
  const installMs = performance.now() - installStartedAt;
  const probe = await evaluate(
    send,
    `(async () => {
      const injected = globalThis.__phase05Injected;
      const resolve = (selector) => {
        const parsed = injected.parseSelector(selector);
        return injected.querySelectorAll(parsed, document.documentElement);
      };
      const roleSelector = 'internal:role=button[name="Increment count"i]';
      const buttonBefore = resolve(roleSelector);
      const shadow = resolve('internal:role=button[name="Shadow action"i]');
      const inputLocator = 'internal:role=textbox[name="Message"i]';
      const inputBefore = resolve(inputLocator)[0];
      inputBefore.value = "before replacement";
      document.querySelector("#replace").click();
      const inputAfter = resolve(inputLocator)[0];
      inputAfter.value = "after replacement";
      const frame = document.querySelector("#same-origin-frame");
      await new Promise((resolveReady) => {
        if (frame.contentDocument?.readyState === "complete") resolveReady();
        else frame.addEventListener("load", resolveReady, { once: true });
      });
      return {
        roleMatches: buttonBefore.length,
        shadowMatches: shadow.length,
        locatorReresolvedAfterReplacement: inputBefore !== inputAfter && inputAfter.value === "after replacement",
        sameOriginFrameRequiresSeparateRuntime: frame.contentDocument !== document,
      };
    })()`,
  );
  emitResult({ mode, install, installMs, probe });
  app.quit();
}

let rendererReloadStarted = false;
let rendererReloadNextGuestResolve;

async function runRendererReloadSpike(window, firstGuest) {
  rendererReloadStarted = true;
  const firstSend = attachDebugger(firstGuest);
  await firstSend("Runtime.enable");
  await evaluate(firstSend, `document.querySelector("#increment").click()`);
  const firstState = await evaluate(firstSend, `document.querySelector("#count").textContent`);
  const firstGuestId = firstGuest.id;

  const nativeView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: "persist:t3-phase05-view" },
  });
  nativeView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  window.contentView.addChildView(nativeView);
  await nativeView.webContents.loadFile(join(here, "guest.html"));
  await nativeView.webContents.executeJavaScript(`document.querySelector("#increment").click()`);
  const nativeId = nativeView.webContents.id;

  const nextGuest = new Promise((resolveGuest) => {
    rendererReloadNextGuestResolve = resolveGuest;
  });
  await window.webContents.reload();
  const secondGuest = await Promise.race([
    nextGuest,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Replacement webview timed out")), 5_000)),
  ]);
  const secondSend = attachDebugger(secondGuest);
  await secondSend("Runtime.enable");
  const secondState = await evaluate(secondSend, `document.querySelector("#count").textContent`);
  const nativeState = await nativeView.webContents.executeJavaScript(
    `document.querySelector("#count").textContent`,
  );
  emitResult({
    mode,
    webview: {
      firstGuestId,
      secondGuestId: secondGuest.id,
      firstState,
      secondState,
      firstDestroyed: firstGuest.isDestroyed(),
      survivedRendererReload: firstGuestId === secondGuest.id,
    },
    webContentsView: {
      idBefore: nativeId,
      idAfter: nativeView.webContents.id,
      stateAfter: nativeState,
      destroyed: nativeView.webContents.isDestroyed(),
    },
  });
  app.quit();
}

async function runInputOriginSpike(contents) {
  const send = attachDebugger(contents);
  await send("Input.enable").catch(() => undefined);
  const beforeInputEvents = [];
  contents.on("before-input-event", (_event, input) => beforeInputEvents.push(input));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  emitResult({
    mode,
    beforeInputEvents: beforeInputEvents.map(({ type, key, code, isAutoRepeat }) => ({
      type,
      key,
      code,
      isAutoRepeat,
    })),
    cdpDispatchVisibleAsBeforeInput: beforeInputEvents.length > 0,
  });
  app.quit();
}

async function runHiddenSpike(window, contents) {
  const send = attachDebugger(contents);
  await send("Runtime.enable");
  contents.setBackgroundThrottling(false);
  const before = await evaluate(send, `({ ticks: Number(document.querySelector('#timer').textContent), count: Number(document.querySelector('#count').textContent) })`);
  const cpuStart = process.getCPUUsage();
  window.hide();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await evaluate(send, `document.querySelector('#increment').click()`);
  const after = await evaluate(send, `({ ticks: Number(document.querySelector('#timer').textContent), count: Number(document.querySelector('#count').textContent), hidden: document.hidden })`);
  const image = await contents.capturePage();
  const processMemory = await process.getProcessMemoryInfo();
  const cpuUsage = process.getCPUUsage(cpuStart);
  const metrics = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    memoryKb: metric.memory.workingSetSize,
  }));
  if (outputDirectory) {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, "hidden-capture.png"), image.toPNG());
  }
  emitResult({
    mode,
    before,
    after,
    captureSize: image.getSize(),
    processPrivateKb: processMemory.private,
    mainProcessCpuPercent: cpuUsage.percentCPUUsage,
    metrics,
  });
  app.quit();
}

async function runRecordingSpike(window, contents, hideWindow = true) {
  if (!outputDirectory) throw new Error("recording mode requires --output");
  mkdirSync(outputDirectory, { recursive: true });
  const send = attachDebugger(contents);
  await Promise.all([send("Runtime.enable"), send("Page.enable")]);
  let frameIndex = 0;
  const timestamps = [];
  let lastWrittenTimestamp = Number.NEGATIVE_INFINITY;
  const onMessage = async (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    const timestamp = params.metadata?.timestamp ?? 0;
    if (timestamp - lastWrittenTimestamp < 1 / 12) {
      await send("Page.screencastFrameAck", { sessionId: params.sessionId });
      return;
    }
    lastWrittenTimestamp = timestamp;
    frameIndex += 1;
    timestamps.push(timestamp);
    writeFileSync(
      join(outputDirectory, `frame-${String(frameIndex).padStart(4, "0")}.jpg`),
      Buffer.from(params.data, "base64"),
    );
    await send("Page.screencastFrameAck", { sessionId: params.sessionId });
  };
  contents.debugger.on("message", onMessage);
  await send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 800,
    maxHeight: 600,
    everyNthFrame: 1,
  });
  if (hideWindow) window.hide();
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await send("Page.stopScreencast");
  contents.debugger.off("message", onMessage);

  const videoPath = join(outputDirectory, "webview-recording.mp4");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "12",
      "-i",
      join(outputDirectory, "frame-%04d.jpg"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", videoPath],
    { encoding: "utf8" },
  );
  emitResult({
    mode,
    frames: frameIndex,
    firstTimestamp: timestamps.at(0),
    lastTimestamp: timestamps.at(-1),
    ffmpegStatus: ffmpeg.status,
    ffmpegError: ffmpeg.stderr.trim() || null,
    probe: probe.status === 0 ? JSON.parse(probe.stdout) : { error: probe.stderr.trim() },
    videoPath,
  });
  app.quit();
}

async function runMediaRecorderSpike(window, contents) {
  if (!outputDirectory) throw new Error("media-recorder mode requires --output");
  mkdirSync(outputDirectory, { recursive: true });
  await window.webContents.executeJavaScript(`(() => {
    const guest = document.querySelector('webview');
    guest.style.position = 'fixed';
    guest.style.left = '0';
    guest.style.top = '0';
    guest.style.width = '800px';
    guest.style.height = '600px';
    guest.style.zIndex = '1';
    const cover = document.createElement('div');
    cover.style.position = 'fixed';
    cover.style.inset = '0';
    cover.style.background = '#111827';
    cover.style.zIndex = '2';
    document.body.appendChild(cover);
  })()`);
  const recordingInfo = await window.webContents.executeJavaScript(
    `window.phase0.startRecording({ width: 800, height: 600, fps: 12 })`,
  );
  const send = attachDebugger(contents);
  await send("Page.enable");
  let frameCount = 0;
  let lastSentTimestamp = Number.NEGATIVE_INFINITY;
  const onMessage = async (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    const timestamp = params.metadata?.timestamp ?? 0;
    if (timestamp - lastSentTimestamp >= 1 / 12) {
      lastSentTimestamp = timestamp;
      frameCount += 1;
      window.webContents.send("phase0:recording-frame", `data:image/jpeg;base64,${params.data}`);
    }
    await send("Page.screencastFrameAck", { sessionId: params.sessionId });
  };
  contents.debugger.on("message", onMessage);
  await send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 800,
    maxHeight: 600,
    everyNthFrame: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await send("Page.stopScreencast");
  contents.debugger.off("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const recordingResult = await window.webContents.executeJavaScript("window.phase0.stopRecording()");
  const videoPath = join(
    outputDirectory,
    recordingResult.mimeType.startsWith("video/mp4")
      ? "webview-recording.mp4"
      : "webview-recording.webm",
  );
  writeFileSync(videoPath, Buffer.from(recordingResult.bytes));
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_name,width,height,avg_frame_rate", "-of", "json", videoPath],
    { encoding: "utf8" },
  );
  emitResult({
    mode,
    frameCount,
    recordingInfo,
    videoPath,
    bytes: recordingResult.bytes.length,
    probe: probe.status === 0 ? JSON.parse(probe.stdout) : { error: probe.stderr.trim() },
  });
  app.quit();
}

async function runRecordingEnduranceSpike(window, contents) {
  if (!outputDirectory) throw new Error("recording-endurance mode requires --output");
  const width = 1600;
  const height = 1200;
  const fps = 12;
  const durationMs = 10_000;
  window.setSize(1700, 1300);
  contents.setBackgroundThrottling(false);
  await window.webContents.executeJavaScript(`(() => {
    const guest = document.querySelector('webview');
    guest.style.position = 'fixed';
    guest.style.left = '0';
    guest.style.top = '0';
    guest.style.width = '${width}px';
    guest.style.height = '${height}px';
    guest.style.zIndex = '1';
    const cover = document.createElement('div');
    cover.style.position = 'fixed';
    cover.style.inset = '0';
    cover.style.background = '#111827';
    cover.style.zIndex = '2';
    document.body.appendChild(cover);
  })()`);
  const recordingInfo = await window.webContents.executeJavaScript(
    `window.phase0.startRecording({ width: ${width}, height: ${height}, fps: ${fps} })`,
  );
  const send = attachDebugger(contents);
  await send("Page.enable");
  let frameCount = 0;
  let lastSentTimestamp = Number.NEGATIVE_INFINITY;
  const cpuStart = process.getCPUUsage();
  const onMessage = async (_event, method, params) => {
    if (method !== "Page.screencastFrame") return;
    const timestamp = params.metadata?.timestamp ?? 0;
    if (timestamp - lastSentTimestamp >= 1 / fps) {
      lastSentTimestamp = timestamp;
      frameCount += 1;
      window.webContents.send("phase0:recording-frame", `data:image/jpeg;base64,${params.data}`);
    }
    await send("Page.screencastFrameAck", { sessionId: params.sessionId });
  };
  contents.debugger.on("message", onMessage);
  await send("Page.startScreencast", {
    format: "jpeg",
    quality: 75,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
  await send("Page.stopScreencast");
  contents.debugger.off("message", onMessage);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  const recordingResult = await window.webContents.executeJavaScript("window.phase0.stopRecording()");
  const videoPath = join(outputDirectory, "recording-endurance.mp4");
  writeFileSync(videoPath, Buffer.from(recordingResult.bytes));
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_name,width,height,avg_frame_rate", "-of", "json", videoPath],
    { encoding: "utf8" },
  );
  emitResult({
    mode,
    width,
    height,
    fps,
    durationMs,
    frameCount,
    achievedFps: frameCount / (durationMs / 1_000),
    recordingInfo,
    bytes: recordingResult.bytes.length,
    mainProcessCpu: process.getCPUUsage(cpuStart),
    metrics: app.getAppMetrics().map((metric) => ({
      type: metric.type,
      cpuPercent: metric.cpu.percentCPUUsage,
      memoryKb: metric.memory.workingSetSize,
    })),
    probe: probe.status === 0 ? JSON.parse(probe.stdout) : { error: probe.stderr.trim() },
  });
  app.quit();
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

async function runLatencySpike(window, contents) {
  const send = attachDebugger(contents);
  await send("Runtime.enable");
  const evaluateNoop = () => send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  for (let index = 0; index < 10; index += 1) await evaluateNoop();
  const direct = [];
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    await evaluateNoop();
    direct.push(performance.now() - startedAt);
  }
  ipcMain.removeHandler("phase0:cdp-evaluate");
  ipcMain.handle("phase0:cdp-evaluate", evaluateNoop);
  const rendererRelay = await window.webContents.executeJavaScript(`(async () => {
    const durations = [];
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      await window.phase0.invokeCdp();
      durations.push(performance.now() - startedAt);
    }
    return durations;
  })()`);
  emitResult({
    mode,
    direct: summarizeDurations(direct),
    rendererRelay: summarizeDurations(rendererRelay),
  });
  app.quit();
}

async function runDetachedViewSpike(window, view, detach) {
  const contents = view.webContents;
  const send = attachDebugger(contents);
  await send("Runtime.enable");
  contents.setBackgroundThrottling(false);
  const before = await evaluate(
    send,
    `({ ticks: Number(document.querySelector('#timer').textContent), count: Number(document.querySelector('#count').textContent) })`,
  );
  if (detach) window.contentView.removeChildView(view);
  else view.setVisible(false);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const semanticProbe = await runSemanticProbe(contents);
  const after = await evaluate(
    send,
    `({ ticks: Number(document.querySelector('#timer').textContent), count: Number(document.querySelector('#count').textContent), hidden: document.hidden })`,
  );
  let capture;
  try {
    const image = await contents.capturePage();
    if (outputDirectory) writeFileSync(join(outputDirectory, "detached-view-capture.png"), image.toPNG());
    capture = { success: true, size: image.getSize() };
  } catch (error) {
    capture = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  let cdpScreenshot;
  try {
    await send("Page.enable");
    const screenshot = await Promise.race([
      send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: false,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("CDP screenshot timed out")), 3_000)),
    ]);
    const bytes = Buffer.from(screenshot.data, "base64");
    if (outputDirectory) writeFileSync(join(outputDirectory, "hidden-cdp-screenshot.png"), bytes);
    cdpScreenshot = { success: true, bytes: bytes.length };
  } catch (error) {
    cdpScreenshot = { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  emitResult({
    mode,
    detach,
    before,
    after,
    semanticProbe,
    capture,
    cdpScreenshot,
    destroyed: contents.isDestroyed(),
  });
  contents.close();
  app.quit();
}

await app.whenReady();
debug("app-ready");

const window = new BrowserWindow({
  width: 900,
  height: 700,
  show: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: join(here, "host-preload.cjs"),
    webviewTag: true,
  },
});

app.on("web-contents-created", (_event, contents) => {
  debug(`web-contents-created type=${contents.getType()} id=${contents.id}`);
  if (contents.getType() !== "webview") return;
  contents.once("dom-ready", () => {
    if (mode === "renderer-reload" && rendererReloadStarted) {
      rendererReloadNextGuestResolve?.(contents);
      rendererReloadNextGuestResolve = undefined;
      return;
    }
    if (mode === "automation") {
      runSemanticProbe(contents)
        .then((semanticProbe) =>
          emitResult({ mode, debugPort, webContentsId: contents.id, guestUrl, semanticProbe }),
        )
        .catch((error) => {
          emitResult({ mode, error: error instanceof Error ? error.stack : String(error) });
          app.exit(1);
        });
      return;
    }
    const operation =
      mode === "hidden"
        ? runHiddenSpike(window, contents)
        : mode === "injected-runtime"
          ? runInjectedRuntimeSpike(contents)
          : mode === "renderer-reload"
            ? runRendererReloadSpike(window, contents)
            : mode === "input-origin"
              ? runInputOriginSpike(contents)
              : mode === "recording-endurance"
                ? runRecordingEnduranceSpike(window, contents)
        : mode === "recording"
          ? runRecordingSpike(window, contents)
          : mode === "offscreen-recording"
            ? window.webContents
                .executeJavaScript(`(() => {
                  const guest = document.querySelector('webview');
                  guest.style.position = 'fixed';
                  guest.style.left = '-10000px';
                  guest.style.top = '0';
                  guest.style.width = '800px';
                  guest.style.height = '600px';
                })()`)
                .then(() => runRecordingSpike(window, contents, false))
            : mode === "covered-recording"
              ? window.webContents
                  .executeJavaScript(`(() => {
                    const guest = document.querySelector('webview');
                    guest.style.position = 'fixed';
                    guest.style.left = '0';
                    guest.style.top = '0';
                    guest.style.width = '800px';
                    guest.style.height = '600px';
                    guest.style.zIndex = '1';
                    const cover = document.createElement('div');
                    cover.style.position = 'fixed';
                    cover.style.inset = '0';
                    cover.style.background = '#111827';
                    cover.style.zIndex = '2';
                    document.body.appendChild(cover);
                  })()`)
                  .then(() => runRecordingSpike(window, contents, false))
              : mode === "media-recorder"
                ? runMediaRecorderSpike(window, contents)
          : runLatencySpike(window, contents);
    operation.catch((error) => {
      emitResult({ mode, error: error instanceof Error ? error.stack : String(error) });
      app.exit(1);
    });
  });
});

if (mode.startsWith("view-")) {
  await window.loadURL("data:text/html,<title>Phase0 View Host</title>");
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:t3-phase0-view",
    },
  });
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  window.contentView.addChildView(view);
  await view.webContents.loadFile(join(here, "guest.html"));
  if (mode === "view-hidden" || mode === "view-detached") {
    await runDetachedViewSpike(window, view, mode === "view-detached");
  } else if (mode === "view-recording") {
    await runRecordingSpike(window, view.webContents);
  } else {
    const semanticProbe = await runSemanticProbe(view.webContents);
    emitResult({
      mode,
      debugPort,
      webContentsId: view.webContents.id,
      guestUrl,
      semanticProbe,
    });
  }
} else {
  await window.loadFile(join(here, "host.html"));
  debug(`host-loaded url=${window.webContents.getURL()}`);
}
