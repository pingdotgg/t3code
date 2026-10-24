import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

/**
 * Whether a process group still has members.
 *
 * - `alive`: the group has members, so a member could outlive the leader.
 * - `gone`: the group is empty. Only ESRCH proves this.
 * - `unknown`: the platform has no process groups, or the probe failed in a
 *   way that proves nothing.
 */
type ProcessGroupState = "alive" | "gone" | "unknown";

const processGroupState = (pid: number): ProcessGroupState => {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) {
      return "unknown";
    }
    if (error.code === "ESRCH") {
      // The group is empty.
      return "gone";
    }
    if (error.code === "EPERM") {
      // The group exists but belongs to another user, so it is not ours to
      // signal. Treating it as gone would report a tree as stopped while a
      // member of it is still running.
      return "alive";
    }
    // EINVAL and friends mean the platform has no process groups, which is
    // the case on Windows. The leader's own liveness decides there.
    return "unknown";
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours to signal.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const processTreeIsAlive = (pid: number): boolean =>
  isProcessAlive(pid) || processGroupState(pid) === "alive";

/**
 * Whether the backend, or anything in the process group it leads, is still
 * running.
 */
export const isProcessTreeAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => processTreeIsAlive(pid));

/**
 * Signal a backend's whole process group, falling back to the leader where
 * the platform has no process groups.
 *
 * The desktop starts the backend detached on POSIX, so the backend leads its
 * own process group, and the group is what has to go: a managed descendant
 * that survived the graceful signal would otherwise keep running after the
 * desktop quit.
 */
export const signalProcessTree = (pid: number, signal: NodeJS.Signals): Effect.Effect<boolean> =>
  Effect.sync(() => {
    // A group id of 1 is never a desktop-started server, and signalling -1
    // reaches every process the user can signal. A pid of 0 would reach the
    // caller's own group. Neither is a backend this desktop started.
    if (pid <= 1) {
      return false;
    }
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        // The process is gone, which is the outcome we wanted.
        return false;
      }
    }
  });

/**
 * Wait for the backend and its process group to disappear, bounded by a
 * timeout. Returns true when the whole tree is gone.
 */
export const waitForProcessTreeExit = (
  pid: number,
  timeout: Duration.Duration,
  pollInterval: Duration.Duration,
): Effect.Effect<boolean> =>
  Effect.sync(() => processTreeIsAlive(pid)).pipe(
    Effect.repeat({
      while: (alive) => alive,
      schedule: Schedule.spaced(pollInterval),
    }),
    // The last value is the tree's liveness at the moment the wait ended:
    // false means it exited, and a timeout means it is still running.
    Effect.timeoutOption(timeout),
    Effect.map((result) => Option.isSome(result) && !result.value),
  );
