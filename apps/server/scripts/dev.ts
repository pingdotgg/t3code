// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node watch launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
// Windows reports dependency-directory accesses as changes. Other systems keep the
// directory watcher, which continues watching manifests after an editor replaces them.
const workspacePaths =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone watch launcher runs outside the server runtime.
  process.platform === "win32"
    ? [
        ...NodeFS.globSync("../../packages/*/src", { cwd: serverDir }),
        ...NodeFS.globSync("../../packages/*/package.json", { cwd: serverDir }),
      ]
    : ["../../packages"];
const paths = ["src", "package.json", ...workspacePaths];
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
