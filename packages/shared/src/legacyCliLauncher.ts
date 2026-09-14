/** Node entry point for service launchers installed before executable releases. */
export function legacyCliLauncherScript(distribution: "npm" | "archive"): string {
  const executable =
    distribution === "npm"
      ? 'join(dirname(require.resolve("@t3code/t3-" + process.platform + "-" + process.arch + "/package.json")), executableName)'
      : 'resolve(dirname(fileURLToPath(import.meta.url)), "../../..", executableName)';
  return `import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const executableName = process.platform === "win32" ? "t3.exe" : "t3";
const executable = ${executable};
const ipc = process.send !== undefined;
const child = spawn(executable, process.argv.slice(2), {
  stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
});
const fail = (error) => {
  if (!error) return;
  process.stderr.write("t3: " + error.message + "\\n");
  child.kill("SIGTERM");
  process.exitCode = 1;
};
if (ipc) {
  process.on("message", (message) => { if (child.connected) child.send(message, fail); });
  child.on("message", (message) => { if (process.connected) process.send(message, fail); });
  process.on("disconnect", () => { if (child.connected) child.disconnect(); });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => { fail(error); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] || 1)));
`;
}
