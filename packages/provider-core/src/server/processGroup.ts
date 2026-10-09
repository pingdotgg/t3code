/**
 * Signals a POSIX process group this server spawned, as `process.kill(-pid)`.
 *
 * `kill(0)` signals this server's own group and `kill(-1)` every process the
 * user owns, and a fake spawner in tests reports pid 1. So a pid of 0 or 1, or
 * one that is not an integer, fails with ESRCH like a group that has already
 * exited, and callers keep their existing handling.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw Object.assign(new Error(`kill ESRCH: not a spawned process group (${pid})`), {
      code: "ESRCH",
    });
  }
  process.kill(-pid, signal);
}
