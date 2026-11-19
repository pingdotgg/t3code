// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node watch launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
// Node watches directories recursively. Watch the workspace inputs individually so installed
// dependencies never trigger reloads, including Windows access-time notifications.
const paths = [
  "src",
  "package.json",
  ...NodeFS.globSync("../../packages/*/src", { cwd: serverDir }),
  ...NodeFS.globSync("../../packages/*/package.json", { cwd: serverDir }),
];
const watcher = NodeChildProcess.spawn(
  process.execPath,
  [
    ...paths.map((path) => `--watch-path=${path}`),
    "--watch",
    "src/bin.ts",
    ...process.argv.slice(2),
  ],
  { cwd: serverDir, stdio: "inherit" },
);
process.on("SIGINT", () => watcher.kill("SIGINT"));
process.on("SIGTERM", () => watcher.kill("SIGTERM"));
process.on("SIGHUP", () => watcher.kill("SIGTERM"));
watcher.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
watcher.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 128 + NodeOS.constants.signals[signal]);
});
