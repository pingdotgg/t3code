/**
 * `kill(0)` signals this server's own group and `kill(-1)` every process the
 * user owns, and a fake spawner in tests reports pid 1.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw Object.assign(new Error(`kill ESRCH: not a spawned process group (${pid})`), {
      code: "ESRCH",
    });
  }
  process.kill(-pid, signal);
}
