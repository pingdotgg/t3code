import { spawnSync } from "node:child_process";

export interface KillableProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Terminate a child process together with its entire descendant tree.
 *
 * On Windows, `child.kill()` only signals the immediate child. When a command
 * is launched through a shell (`shell: true`, required for `.cmd`/`.bat`), the
 * immediate child is the `cmd.exe` wrapper, so any grandchildren keep running
 * and leak. `taskkill /T /F` terminates the whole tree by PID.
 *
 * On POSIX, or when the Windows PID is unknown or `taskkill` is unavailable, it
 * falls back to the standard signal-based `child.kill()`.
 */
export function killProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    if (!result.error) {
      return;
    }
  }
  child.kill(signal);
}
