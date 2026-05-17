// @effect-diagnostics nodeBuiltinImport:off
/**
 * Layer-2 defense against orphaned ACP child processes.
 *
 * Effect's `Scope.close` finalizers run asynchronously. When Node receives SIGKILL (e.g. the
 * dev runner force-kills our process), finalizers don't get a chance to run — children with
 * detached process groups stay alive.
 *
 * This module:
 *  - Tracks every ACP child PID we spawn in a process-wide Set
 *  - On SIGINT / SIGTERM / 'exit', synchronously sends SIGTERM then SIGKILL to each tracked
 *    process group, so children can't outlive us regardless of how we're shut down.
 *
 * Layer 1 (`detached: true` + group-kill on scope close) handles graceful shutdown.
 * Layer 3 (boot reaper) cleans up what survived. This is the middle layer.
 */
const trackedPids = new Set<number>();
let installed = false;

function killGroupSafely(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    // Negative pid → signal the whole process group, including any forks the child created.
    process.kill(-pid, signal);
  } catch {
    // Group may already be gone, or pid wasn't a group leader. Fall back to single-pid kill.
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead — ignore.
    }
  }
}

function reapAll(): void {
  if (trackedPids.size === 0) return;
  for (const pid of trackedPids) {
    killGroupSafely(pid, "SIGTERM");
  }
  // No async sleep available in synchronous exit handlers — best-effort SIGKILL immediately.
  for (const pid of trackedPids) {
    killGroupSafely(pid, "SIGKILL");
  }
  trackedPids.clear();
}

function ensureShutdownHandlers(platform: NodeJS.Platform): void {
  if (installed || platform === "win32") return;
  installed = true;
  // Order matters: register BEFORE other handlers so we run early in the shutdown sequence.
  process.on("exit", reapAll);
  process.on("SIGINT", () => {
    reapAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reapAll();
    process.exit(143);
  });
  process.on("SIGHUP", () => {
    reapAll();
    process.exit(129);
  });
}

export function trackChildProcess(pid: number | undefined, platform: NodeJS.Platform): void {
  if (pid === undefined || pid <= 0 || platform === "win32") return;
  ensureShutdownHandlers(platform);
  trackedPids.add(pid);
}

export function untrackChildProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  trackedPids.delete(pid);
}

/** For diagnostics — current count of tracked children. */
export function trackedChildProcessCount(): number {
  return trackedPids.size;
}
