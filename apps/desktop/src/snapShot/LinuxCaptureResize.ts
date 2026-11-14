// @effect-diagnostics globalTimers:off -- Bound the lifetime of a native image-processing renderer.
// @effect-diagnostics nodeBuiltinImport:off -- Resolve the bundled preload next to the desktop entry point.
import * as NodePath from "node:path";
import { WebContentsView } from "electron";

export async function resizeLinuxCaptureInRenderer(png: Buffer): Promise<Buffer> {
  // nativeImage is unavailable in Node workers and utility processes; use a blank, unattached renderer.
  const view = new WebContentsView({
    webPreferences: {
      preload: NodePath.join(__dirname, "snapShot", "LinuxCaptureResizePreload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = view.webContents;
  const result = Promise.withResolvers<Buffer>();
  const timer = setTimeout(
    () => result.reject(new Error("Window screenshot processing timed out.")),
    15_000,
  );
  timer.unref();
  contents.on("ipc-message", (_event, channel, response: Uint8Array | string) => {
    if (channel !== "t3:linux-capture") return;
    if (typeof response === "string") result.reject(new Error(response));
    else result.resolve(Buffer.from(response));
  });
  contents.once("render-process-gone", () =>
    result.reject(new Error("Window screenshot processing exited.")),
  );
  contents.once("preload-error", (_event, _path, error) => result.reject(error));
  contents.once("destroyed", () =>
    result.reject(new Error("Window screenshot processing exited.")),
  );
  void contents
    .loadURL("about:blank")
    .then(() => contents.send("t3:linux-capture", png))
    .catch((error: unknown) => result.reject(error));
  try {
    return await result.promise;
  } finally {
    clearTimeout(timer);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
