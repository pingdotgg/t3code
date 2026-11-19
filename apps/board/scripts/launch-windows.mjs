import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Runs from WSL and starts the Windows build of Electron, so the app gets Windows' own window
// frame. With VITE_DEV_SERVER_URL set it loads the dev server, otherwise the built dist/.
const require = NodeModule.createRequire(import.meta.url);
const boardDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const cdpPort = process.env.AGENT_BOARD_CDP_PORT;

// cmd.exe refuses a UNC working directory, which is what WSL paths look like to Windows.
const windowsRun = (command, args) =>
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8", cwd: "/mnt/c" }).trim();
const toWindowsPath = (wslPath) => windowsRun("wslpath", ["-w", wslPath]);
const localAppData = windowsRun("wslpath", [
  "-u",
  windowsRun("cmd.exe", ["/c", "echo %LOCALAPPDATA%"]),
]);
const installRoot = NodePath.join(localAppData, "agent-board");

async function ensureWindowsElectron() {
  const electronPackagePath = require.resolve("electron/package.json");
  const { version } = JSON.parse(NodeFS.readFileSync(electronPackagePath, "utf8"));
  const dir = NodePath.join(installRoot, `electron-${version}`);
  if (NodeFS.existsSync(NodePath.join(dir, "electron.exe"))) return dir;

  // @electron/get is electron's own dependency, so it is only resolvable from electron's folder.
  const getPath = NodeModule.createRequire(electronPackagePath).resolve("@electron/get");
  const { downloadArtifact } = await import(NodeURL.pathToFileURL(getPath).href);
  const zip = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: "win32",
    arch: "x64",
  });
  NodeFS.mkdirSync(dir, { recursive: true });
  // Expanding on the Windows side avoids thousands of small writes across the 9p mount.
  windowsRun("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${toWindowsPath(zip)}' -DestinationPath '${toWindowsPath(dir)}' -Force`,
  ]);
  return dir;
}

// Electron must not load from a \\wsl.localhost path, so the small bundle is copied to Windows.
function stageApp() {
  const appDir = NodePath.join(installRoot, devServerUrl ? "app-dev" : "app-prod");
  NodeFS.rmSync(appDir, { recursive: true, force: true });
  const bundleDir = NodePath.join(appDir, "dist-electron", "electron");
  NodeFS.mkdirSync(bundleDir, { recursive: true });
  for (const file of ["main.cjs", "preload.cjs"]) {
    NodeFS.copyFileSync(
      NodePath.join(boardDir, "dist-electron", "electron", file),
      NodePath.join(bundleDir, file),
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(appDir, "package.json"),
    JSON.stringify({ name: "agent-board", main: "dist-electron/electron/main.cjs" }),
  );
  if (!devServerUrl) {
    NodeFS.cpSync(NodePath.join(boardDir, "dist"), NodePath.join(appDir, "dist"), {
      recursive: true,
    });
  }
  return appDir;
}

const electronDir = await ensureWindowsElectron();
const appDir = stageApp();

// WSLENV is what carries these variables across to the Windows process.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const forwarded = [
  "VITE_DEV_SERVER_URL",
  "AGENT_BOARD_CDP_PORT",
  "AGENT_BOARD_ENGINE_URL",
  "AGENT_BOARD_TOKEN",
  "AGENT_BOARD_T3_HOME",
  "AGENT_BOARD_T3_CLI",
  "AGENT_BOARD_WSL_DISTRO",
];
env.WSLENV = [env.WSLENV, ...forwarded].filter(Boolean).join(":");

const child = NodeChildProcess.spawn(
  NodePath.join(electronDir, "electron.exe"),
  [toWindowsPath(appDir), ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [])],
  { stdio: "inherit", env, cwd: "/mnt/c" },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
