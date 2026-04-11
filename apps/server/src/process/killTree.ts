import { spawnSync, type ChildProcess as NodeChildProcess } from "node:child_process";

type KillableChildProcess = Pick<NodeChildProcess, "kill" | "pid">;
type TaskkillResult = {
  readonly status: number | null;
  readonly error?: Error;
};
type TaskkillRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio: "ignore" },
) => TaskkillResult;

interface KillChildProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnSyncImpl?: TaskkillRunner;
}

/**
 * On Windows with shell-backed processes, direct kill only terminates the
 * wrapper process. Use `taskkill /T` first so the spawned process tree exits.
 */
export function killChildProcessTree(
  child: KillableChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  options: KillChildProcessTreeOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && child.pid !== undefined) {
    try {
      const result = (options.spawnSyncImpl ?? spawnSync)(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      if (!result.error && result.status === 0) {
        return;
      }
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill(signal);
}
