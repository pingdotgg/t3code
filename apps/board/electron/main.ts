import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { app, BrowserWindow, Menu, nativeTheme, net, protocol, shell } from "electron";

import { registerBrowserViews } from "./browserView";
import { registerEngineIpc } from "./ipc";

const SCHEME = "agentboard";
// oxlint-disable-next-line t3code/no-global-process-runtime -- The board has no Effect runtime.
const platform = NodeOS.platform();
const rendererDir = NodePath.join(__dirname, "..", "..", "dist");
const devServerUrl = process.env["VITE_DEV_SERVER_URL"];
const cdpPort = process.env["AGENT_BOARD_CDP_PORT"];

// Matches the frame in apps/desktop/src/window/DesktopWindow.ts, dark variant only.
const BACKGROUND_COLOR = "#151618";
const TITLEBAR_HEIGHT = 40;
const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_SYMBOL_COLOR = "#f8fafc";
const MACOS_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

app.setName("Agent Board");
nativeTheme.themeSource = "dark";
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
    backgroundColor: BACKGROUND_COLOR,
    autoHideMenuBar: true,
    ...(platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: MACOS_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS },
        }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: TITLEBAR_COLOR,
            height: TITLEBAR_HEIGHT,
            symbolColor: TITLEBAR_SYMBOL_COLOR,
          },
        }),
    webPreferences: {
      preload: NodePath.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // A sign-in page or a link in a reply opens in the system browser, never in a window of the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(devServerUrl ?? `${SCHEME}://app/index.html`);
}

const engine = registerEngineIpc({ env: process.env, platform });

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => engine.release());

void app.whenReady().then(() => {
  // macOS keeps its menu for the standard Cmd shortcuts.
  if (platform !== "darwin") Menu.setApplicationMenu(null);
  protocol.handle(SCHEME, serveRenderer);
  registerBrowserViews();
  engine.start();
  openWindow();
});
