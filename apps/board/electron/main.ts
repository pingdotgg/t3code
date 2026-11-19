import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { app, BrowserWindow, ipcMain, net, protocol } from "electron";

const SCHEME = "agentboard";
const rendererDir = NodePath.join(__dirname, "..", "..", "dist");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const cdpPort = process.env.AGENT_BOARD_CDP_PORT;

app.setName("Agent Board");
if (cdpPort) {
  app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
}
// Must run before `ready` so the renderer treats the scheme like https.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveRenderer(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  const file = NodePath.join(
    rendererDir,
    pathname === "/" ? "index.html" : decodeURIComponent(pathname),
  );
  if (NodePath.relative(rendererDir, file).startsWith("..")) {
    return new Response("Forbidden", { status: 403 });
  }
  return net.fetch(NodeURL.pathToFileURL(file).toString());
}

function openWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Agent Board",
    backgroundColor: "#151618",
    autoHideMenuBar: true,
    webPreferences: {
      preload: NodePath.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  void window.loadURL(devServerUrl ?? `${SCHEME}://app/index.html`);
}

// The renderer reports wall-clock time because its performance clock starts at navigation.
// process.getCreationTime() is skewed under WSL (it once came out negative), so the clock
// starts at Node's init in the main process instead.
ipcMain.on("board:first-paint", (_event, epochMs: unknown) => {
  if (typeof epochMs !== "number") return;
  console.log(`board:first-paint ${Math.round(epochMs - performance.timeOrigin)} ms`);
});

app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  protocol.handle(SCHEME, serveRenderer);
  openWindow();
});
