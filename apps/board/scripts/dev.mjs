import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const port = Number(process.env.PORT ?? 5190);
const url = `http://127.0.0.1:${port}`;
const scriptsDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

NodeChildProcess.execFileSync("vp", ["pack"], { stdio: "inherit" });

const vite = NodeChildProcess.spawn("vp", ["dev"], { stdio: "inherit" });
const stopVite = () => vite.kill();
process.on("exit", stopVite);
vite.on("exit", (code) => process.exit(code ?? 1));

function portOpen() {
  return new Promise((resolve) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}
while (!(await portOpen())) {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const electron = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(scriptsDir, "launch-electron.mjs")],
  { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } },
);
electron.on("exit", (code) => process.exit(code ?? 0));
