import { spawn } from "node:child_process";

import waitOn from "wait-on";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 5173);
const devServerUrl = `http://localhost:${port}`;

await waitOn({
  resources: [
    `tcp:${port}`,
    "file:dist-electron/main.js",
    "file:dist-electron/preload.js",
    "file:../server/dist/index.js",
  ],
});

const command = process.platform === "win32" ? "electronmon.cmd" : "electronmon";
const child = spawn(command, ["dist-electron/main.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
