import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const entry = NodePath.join(__dirname, "native-preview-smoke-entry.cjs");
const electronCommand = resolveElectronLaunchCommand([entry]);
const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: NodePath.resolve(__dirname, ".."),
  env: childEnv,
  stdio: "inherit",
});

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill();
  console.error("Native preview smoke test timed out.");
}, 25_000);

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  process.exitCode = timedOut || signal ? 1 : (code ?? 1);
});
