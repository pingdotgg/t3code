import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as CliError from "effect/cli/CliError";

import { queryWindowsTcpListeners } from "../process/windowsTcpListeners.ts";
import * as ProcessRunner from "../processRunner.ts";

const KERNEL_RELEASE_PATH = "/proc/sys/kernel/osrelease";
const WINDOWS_NETSTAT_PATH = String.raw`C:\Windows\System32\netstat.exe`;
const FALLBACK_ATTEMPTS = 8;

/**
 * Picks the startup port when none was configured. Under WSL's default NAT networking, Windows
 * reaches the server through localhost forwarding, which fails for a port a Windows process
 * already listens on even though WSL can bind it.
 */
export const make = Effect.gen(function* () {
  const net = yield* NetService.NetService;
  const fs = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  // Services started by systemd lack WSL_DISTRO_NAME and WSL_INTEROP; the kernel release does not.
  // Hosts without this file (macOS, Windows) are not WSL.
  const isWsl = fs.readFileString(KERNEL_RELEASE_PATH).pipe(
    Effect.map((release) => release.toLowerCase().includes("microsoft")),
    Effect.orElseSucceed(() => false),
  );

  const readWindowsHostListeners = Effect.gen(function* () {
    // The automount root is configurable, so `/mnt/c` is not guaranteed.
    const netstat = yield* processRunner.run({
      command: "wslpath",
      args: ["-u", WINDOWS_NETSTAT_PATH],
      timeout: Duration.seconds(5),
    });
    const netstatPath = netstat.stdout.trim();
    if ((netstat.code !== null && netstat.code !== 0) || netstatPath.length === 0) {
      return null;
    }
    const listeners = yield* queryWindowsTcpListeners(processRunner, netstatPath);
    if (listeners === null) return null;
    return new Set(listeners.map((listener) => listener.port));
  }).pipe(Effect.orElseSucceed(() => null));

  return Effect.fn("automaticPort.select")(function* (preferred: number) {
    if (!(yield* isWsl)) return yield* net.findAvailablePort(preferred);
    const windows = yield* readWindowsHostListeners;
    if (windows === null) {
      yield* Effect.logWarning(
        "Could not list Windows TCP listeners from WSL; Windows may be unable to reach the selected port. Pass --port to choose one.",
      );
      return yield* net.findAvailablePort(preferred);
    }
    if (!windows.has(preferred) && (yield* net.isPortAvailableOnLoopback(preferred))) {
      return preferred;
    }
    // Linux and Windows ephemeral ranges overlap, so fallback ports can collide too.
    for (let attempt = 0; attempt < FALLBACK_ATTEMPTS; attempt += 1) {
      const port = yield* net.reserveLoopbackPort();
      if (!windows.has(port)) return port;
    }
    return yield* new CliError.UserError({
      cause:
        "Windows is already using every port T3 Code tried. Pass --port or set T3CODE_PORT to a port Windows is not using.",
    });
  });
});
