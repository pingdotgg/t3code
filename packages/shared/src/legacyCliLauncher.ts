/**
 * `dist/bin.mjs` of the `t3` npm package: the entry point boot-service
 * launchers installed before 0.0.41 run with Node to start a new version they
 * just npm-installed. It forwards everything (arguments, stdio, the IPC
 * channel the launcher talks over, signals, exit status) to the platform
 * executable in the sibling `@t3code/t3-<platform>-<arch>` package.
 *
 * The first server started this way rewrites the service unit to run the
 * executable directly, so nothing depends on this file after one update.
 * Remove it once no supported release predates the executable (after the
 * first stable release that ships it).
 */

/**
 * UEK8's `load_elf_binary()` returns ENOEXEC when a PT_NOTE exceeds 4 MB
 * (`MAX_FILE_NOTE_SIZE`). The CLI is a Node SEA, so `NODE_SEA_BLOB` is large
 * by design. The kernel only checks the PT_NOTE program header `p_filesz`,
 * not the note payload: capping that field at 4 MB on the installed binary
 * lets `execve` succeed, and must be reapplied after every update. Node spawn
 * uses execvp, which retries ENOEXEC via /bin/sh, so the failure often
 * arrives as status 126 with no error object. ENOEXEC can also mean a corrupt
 * or wrong-architecture file; this is the likely cause on Linux when the file
 * exists.
 */
export const linuxCliExecFormatErrorHint =
  "t3: Oracle Linux UEK8 kernels reject Node SEA PT_NOTE segments larger than 4 MB (ENOEXEC). Boot Oracle RHCK or a mainline-based kernel; patch the installed binary's PT_NOTE p_filesz down to 4 MB (reapply after every update); or build from source and run node apps/server/dist/bin.mjs. ENOEXEC can also mean a corrupt or wrong-architecture file.";

/** Return `dist/bin.mjs` source that forwards the process to the sibling platform `t3` executable. */
export function legacyCliLauncherScript(): string {
  // Linux pipe/socket stderr writes are async; process.exit() would drop the UEK8 hint.
  return `import { spawn } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const executableName = process.platform === "win32" ? "t3.exe" : "t3";
const executable = join(dirname(require.resolve("@t3code/t3-" + process.platform + "-" + process.arch + "/package.json")), executableName);
const ipc = process.send !== undefined;
const child = spawn(executable, process.argv.slice(2), {
  stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
});
const linuxHint = ${JSON.stringify(linuxCliExecFormatErrorHint + "\n")};
let exiting = false;
const exitAfterWrite = (code, extra) => {
  if (exiting) return;
  exiting = true;
  if (extra) process.stderr.write(extra, () => process.exit(code));
  else process.exit(code);
};
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
child.on("error", (error) => {
  fail(error);
  exitAfterWrite(1, error.code === "ENOEXEC" && process.platform === "linux" ? linuxHint : undefined);
});
child.on("exit", (code, signal) => {
  exitAfterWrite(
    code ?? 128 + (constants.signals[signal] || 1),
    code === 126 && process.platform === "linux" ? linuxHint : undefined,
  );
});
`;
}
