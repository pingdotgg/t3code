// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

const ENV = "/usr/bin/env";

let chdirSupport: Promise<boolean> | undefined;

/** Whether `/usr/bin/env` takes `-C` (GNU coreutils 8.28 and later; BusyBox does not). */
export const supportsEnvChdir = (): Promise<boolean> =>
  (chdirSupport ??= new Promise((resolve) =>
    // Run against `/` and absolute paths, so the check itself cannot wait on a mount.
    NodeChildProcess.execFile(ENV, ["-C", "/", "--", "/bin/sh", "-c", ":"], (error) =>
      resolve(error === null),
    ),
  ));

/**
 * libuv's spawn blocks until the child has run chdir(cwd) and the PATH search, which a hung
 * mount stalls. Through `env` both run after exec, with argv and environment untouched.
 * Undefined when `env` would read the command as `NAME=value` or `-`, which `--` does not stop.
 */
export function envTrampoline<Arg>(
  command: string,
  args: ReadonlyArray<Arg>,
  cwd: string | undefined,
): { readonly command: string; readonly args: Array<Arg | string> } | undefined {
  if (command === "" || command === "-" || command.includes("=")) return undefined;
  return {
    command: ENV,
    args: [...(cwd === undefined ? [] : ["-C", cwd]), "--", command, ...args],
  };
}
