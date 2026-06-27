import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const supervisorLockPath = NodePath.join(desktopDir, ".dev-electron-supervisor.pid");
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function readSupervisorPid() {
  try {
    const value = Number.parseInt(NodeFS.readFileSync(supervisorLockPath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function retireSupervisorLock() {
  if (readSupervisorPid() === process.pid) {
    NodeFS.rmSync(supervisorLockPath, { force: true });
  }
}

function listOtherDevElectronSupervisorPids() {
  if (hostPlatform === "win32") {
    return [];
  }

  const result = NodeChildProcess.spawnSync(
    "pgrep",
    ["-f", `${desktopDir}/scripts/dev-electron.mjs`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function terminateSupervisorPid(pid) {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await NodeTimersPromises.setTimeout(100);
  }

  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

async function acquireSupervisorLock() {
  const stalePid = readSupervisorPid();
  if (stalePid !== undefined && stalePid !== process.pid) {
    await terminateSupervisorPid(stalePid);
  }

  for (const orphanPid of listOtherDevElectronSupervisorPids()) {
    await terminateSupervisorPid(orphanPid);
  }

  NodeFS.writeFileSync(supervisorLockPath, `${process.pid}\n`);
}

function waitForDevServer() {
  return waitForResources({
    baseDir: desktopDir,
    files: requiredFiles,
    tcpHost: devServer.hostname,
    tcpPort: port,
  });
}

await acquireSupervisorLock();
await waitForDevServer();

const devProtocolClient = resolveDevProtocolClient();

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function buildChildEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (devProtocolClient) {
    env.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
    env.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
  }
  return env;
}

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function cleanupStaleDevApps() {
  if (hostPlatform === "win32") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", ["-f", "--", `--t3code-dev-root=${desktopDir}`], {
    stdio: "ignore",
  });
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: buildChildEnv(),
    stdio: "inherit",
  });

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");
    cleanupStaleDevApps();

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      cleanupStaleDevApps();
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          await waitForDevServer();
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");
  retireSupervisorLock();

  process.exit(exitCode);
}

startWatchers();
cleanupStaleDevApps();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
