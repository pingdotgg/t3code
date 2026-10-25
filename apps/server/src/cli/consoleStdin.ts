// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime starts, on raw file descriptors.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Electron's Windows executable is a GUI program, so `t3.cmd` under
 * `ELECTRON_RUN_AS_NODE` gets the console for stdout and stderr but no stdin.
 * Piped or redirected input and runs whose output is not a console are left alone.
 */
function needsConsoleStdin(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinOpen: boolean;
  readonly stdoutIsConsole: boolean;
}): boolean {
  return (
    input.platform === "win32" &&
    // Set only by the launcher (DesktopCliShim), never for the desktop backend.
    input.env.T3CODE_DESKTOP_CLI_LAUNCHER === "1" &&
    !input.stdinOpen &&
    input.stdoutIsConsole
  );
}

const isOpen = (fd: number) => {
  try {
    NodeFS.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

/** Call before reading process.stdin. Returns the reopened fd for children, or undefined without changing stdin. */
export function attachConsoleStdin(): number | undefined {
  const needed = needsConsoleStdin({
    platform: HostProcess.Platform.defaultValue(),
    env: process.env,
    stdinOpen: isOpen(0),
    stdoutIsConsole: NodeTty.isatty(1),
  });
  // The launcher marker must not propagate to child shells or t3 processes.
  delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
  if (!needed) return undefined;
  let fd: number;
  try {
    fd = NodeFS.openSync("\\\\.\\CONIN$", "r+");
  } catch {
    return undefined;
  }
  if (!NodeTty.isatty(fd)) {
    NodeFS.closeSync(fd);
    return undefined;
  }
  const stdin = new NodeTty.ReadStream(fd);
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true });
  consoleStdinFd = fd;
  return fd;
}

let consoleStdinFd: number | undefined;

export const interactiveStdin = (): number | "inherit" => consoleStdinFd ?? "inherit";
