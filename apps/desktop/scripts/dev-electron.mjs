import { spawn } from "node:child_process";

import waitOn from "wait-on";

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

const command = process.platform === "win32" ? "electronmon.cmd" : "electronmon";
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(command, ["dist-electron/main.js"], {
  stdio: "inherit",
  env: {
    ...childEnv,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
