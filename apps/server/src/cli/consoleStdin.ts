// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime starts, on raw file descriptors.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Electron's Windows launcher has no stdin; Node substitutes a non-console NUL device.
 * Preserve pipes, files, console input, and runs without console output.
 * Explicit `< NUL` is indistinguishable from missing launcher stdin and also reattaches.
 */
function needsConsoleStdin(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinMissing: boolean;
  readonly stdoutIsConsole: boolean;
}): boolean {
  return (
    input.platform === "win32" &&
    // Set only by the launcher (DesktopCliShim), never for the desktop backend.
    input.env.T3CODE_DESKTOP_CLI_LAUNCHER === "1" &&
    input.stdinMissing &&
    input.stdoutIsConsole
  );
}

const isMissingInput = (fd: number) => {
  try {
    return NodeFS.fstatSync(fd).isCharacterDevice() && !NodeTty.isatty(fd);
  } catch {
    return true;
  }
};

/** Call before reading process.stdin. Returns the reopened fd for children, or undefined without changing stdin. */
export function attachConsoleStdin(): number | undefined {
  const needed = needsConsoleStdin({
    platform: HostProcess.Platform.defaultValue(),
    env: process.env,
    stdinMissing: isMissingInput(0),
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
  // Like Node's built-in stdin, release pending console reads before a child takes over.
  stdin.on("pause", () => {
    const internal = stdin as unknown as {
      _handle?: { reading: boolean; readStop(): void };
      _readableState: { reading: boolean };
    };
    const handle = internal._handle;
    if (!handle) return;
    internal._readableState.reading = false;
    handle.reading = false;
    handle.readStop();
  });
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true });
  consoleStdinFd = fd;
  return fd;
}

let consoleStdinFd: number | undefined;

export const interactiveStdin = (): number | "inherit" => consoleStdinFd ?? "inherit";
