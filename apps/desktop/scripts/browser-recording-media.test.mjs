import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  const directory = process.env.T3CODE_RECORDING_TEST_DIR;
  NodeAssert.ok(directory);
  app.setPath("userData", NodePath.join(directory, "profile"));
  ipcMain.handle("recording-result", async (_event, bytes) => {
    await NodeFSP.writeFile(NodePath.join(directory, "recording.mp4"), Buffer.from(bytes));
    app.quit();
  });
  ipcMain.on("recording-error", (_event, message) => {
    console.error(message);
    app.exit(1);
  });
  app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 900,
      height: 700,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.on("console-message", (event) => console.error(event.message));
    window.setFullScreen(true);
    await window.loadFile(NodePath.join(directory, "recording.html"));
  });
} else {
  const { test } = await import("node:test");
  const require = NodeModule.createRequire(import.meta.url);

  const run = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", (cause) => reject(new Error(`${command} failed\n${stderr}`, { cause })));
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited with ${code}\n${stderr}`));
      });
    });

  test("exported recording decodes through desktop, mobile, and desktop frames", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-recording-media-"));
    try {
      const source = await NodeFSP.readFile(
        new URL("../../web/src/browser/browserMediaRecorder.ts", import.meta.url),
        "utf8",
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "recorder.mjs"),
        NodeModule.stripTypeScriptTypes(source),
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "recording.html"),
        `<!doctype html><title>Recording regression</title><canvas></canvas>
<script type="module">
import { createBrowserMediaRecorder } from './recorder.mjs';
const { ipcRenderer } = window.require('electron');
try {
  const canvas = document.querySelector('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const recorder = createBrowserMediaRecorder(stream);
  const chunks = [];
  recorder.addEventListener('dataavailable', event => chunks.push(event.data));
  recorder.addEventListener('stop', async () => {
    stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    await ipcRenderer.invoke('recording-result', new Uint8Array(await blob.arrayBuffer()));
  });
  recorder.start(1000);
  const start = performance.now();
  let phase = -1;
  function draw(now) {
    const elapsed = now - start;
    const nextPhase = Math.min(2, Math.floor(elapsed / 1000));
    if (nextPhase !== phase) {
      phase = nextPhase;
      canvas.width = phase === 1 ? 488 : 1600;
      canvas.height = phase === 1 ? 1054 : 1000;
    }
    context.fillStyle = ['#ff0000', '#00ff00', '#0000ff'][phase];
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.font = '32px sans-serif';
    context.fillText(String(elapsed.toFixed(0)), 20, 50);
    if (elapsed < 3100) requestAnimationFrame(draw);
    else recorder.stop();
  }
  requestAnimationFrame(draw);
} catch (error) {
  ipcRenderer.send('recording-error', String(error));
}
</script>`,
      );
      const env = { ...process.env, T3CODE_RECORDING_TEST_DIR: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      await run(require("electron"), [NodeURL.fileURLToPath(import.meta.url)], {
        env,
        signal: AbortSignal.timeout(30_000),
      });
      const recording = NodePath.join(directory, "recording.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-xerror",
        "-i",
        recording,
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1:1000000",
        "-f",
        "null",
        "-",
      ]);
      const { frames, format } = JSON.parse(
        await run("ffprobe", [
          "-v",
          "error",
          "-show_frames",
          "-show_entries",
          "frame=width,height,best_effort_timestamp_time:format=duration",
          "-of",
          "json",
          recording,
        ]),
      );
      const phases = frames.filter(
        (frame, index) =>
          index === 0 ||
          frame.width !== frames[index - 1].width ||
          frame.height !== frames[index - 1].height,
      );
      NodeAssert.deepEqual(
        phases.map(({ width, height }) => [width, height]),
        [
          [1600, 1000],
          [488, 1054],
          [1600, 1000],
        ],
      );
      NodeAssert.ok(Number(format.duration) >= 3);
      NodeAssert.ok(Number(frames.at(-1).best_effort_timestamp_time) >= 3);
      for (let index = 1; index < frames.length; index += 1) {
        NodeAssert.ok(
          Number(frames[index].best_effort_timestamp_time) >
            Number(frames[index - 1].best_effort_timestamp_time),
        );
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
}
