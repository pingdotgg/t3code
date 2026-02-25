import { spawnSync } from "node:child_process";

import electronmon from "electronmon";
import waitOn from "wait-on";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5173);
const devServerUrl = `http://localhost:${port}`;

await waitOn({
  resources: [
    `tcp:${port}`,
    "file:dist-electron/main.js",
    "file:dist-electron/preload.js",
    "file:../server/dist/index.mjs",
  ],
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const monitor = await electronmon({
  cwd: desktopDir,
  args: ["dist-electron/main.js"],
  env: {
    ...childEnv,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
  electronPath: resolveElectronPath(),
});

let shuttingDown = false;

function killChildTree(signal) {
  if (process.platform === "win32") {
    return;
  }

  // electronmon may leave Electron orphaned when parent shutdown races; kill direct children as fallback.
  spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], { stdio: "ignore" });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await Promise.race([monitor.destroy(), new Promise((resolve) => setTimeout(resolve, 1_500))]);
  } catch {
    // Best effort only; fallback process kill below handles stubborn children.
  }

  killChildTree("TERM");
  setTimeout(() => {
    killChildTree("KILL");
  }, 1_200).unref();

  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
