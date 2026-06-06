import { spawn } from "node:child_process";

import { desktopDir, resolveElectronLaunch } from "./electron-launcher.mjs";

const electronLaunch = resolveElectronLaunch(["dist-electron/main.cjs"]);

const child = spawn(electronLaunch.electronPath, electronLaunch.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: electronLaunch.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
