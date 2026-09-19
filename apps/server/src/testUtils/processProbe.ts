// @effect-diagnostics nodeBuiltinImport:off - test-only probes of the host process table.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";

const POLL_INTERVAL_MS = 10;

/**
 * Polls `read` on native time until it returns a value or `timeoutMs` passes.
 * A test clock does not move the host, so a process that is really starting
 * or exiting has to be observed against the wall clock.
 */
const pollNative = <A>(
  read: () => A | undefined,
  timeoutMs: number,
): Effect.Effect<A | undefined> =>
  Effect.callback<A | undefined>((resume) => {
    const deadline = Date.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const poll = () => {
      const value = read();
      if (value !== undefined || Date.now() >= deadline) {
        resume(Effect.succeed(value));
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
    return Effect.sync(() => clearTimeout(timer));
  });

/** Whether the host still has a process with this id. A reaped process is gone. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort SIGKILL so a failing assertion does not leave a helper behind. */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Resolves `true` once the process is gone, or `false` if it is still alive after `timeoutMs`. */
export const waitForProcessExit = (pid: number, timeoutMs = 5_000): Effect.Effect<boolean> =>
  pollNative(() => (isProcessAlive(pid) ? undefined : true), timeoutMs).pipe(
    Effect.map((gone) => gone === true),
  );

/** Reads the pid a stub wrote to `path`, waiting up to `timeoutMs` for the file to appear. */
export const readPidFile = (path: string, timeoutMs = 5_000): Effect.Effect<number | undefined> =>
  pollNative(() => {
    try {
      const pid = Number(NodeFS.readFileSync(path, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }, timeoutMs);
