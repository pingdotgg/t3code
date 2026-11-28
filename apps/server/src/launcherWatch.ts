import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);
// The desktop's SIGTERM grace before it escalates to SIGKILL; a lost launcher cannot escalate.
const DEFAULT_SHUTDOWN_GRACE = Duration.seconds(5);

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

interface LauncherWatchOptions {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly interval?: Duration.Input;
}

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Skip init-launched backends and Windows, which retains the exited parent's id.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (
  options?: LauncherWatchOptions,
): Effect.fn.Return<void> {
  const platform = yield* HostProcess.Platform;
  const launcherPid = options?.launcherPid ?? startupParentPid;
  const getParentPid = options?.getParentPid ?? (() => process.ppid);
  const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
  if (platform === "win32" || launcherPid <= 1) return yield* Effect.never;
  const poll: Effect.Effect<void> = Effect.suspend(() => {
    const parentPid = getParentPid();
    return parentPid === launcherPid
      ? Effect.flatMap(Effect.sleep(interval), () => poll)
      : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
          launcherPid,
          parentPid,
        });
  });
  return yield* poll;
});

/**
 * Interrupts `run` when the launcher is lost, and exits the process if shutdown outlasts the
 * grace period: a stuck cleanup step would otherwise keep holding the T3 home's ownership lock.
 */
export const stopOnLauncherLoss = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  options?: LauncherWatchOptions & {
    readonly shutdownGrace?: Duration.Input;
    readonly exit?: () => void;
  },
) =>
  Effect.raceFirst(
    run,
    awaitLauncherLoss(options).pipe(
      Effect.andThen(
        Effect.forkDetach(
          Effect.sleep(options?.shutdownGrace ?? DEFAULT_SHUTDOWN_GRACE).pipe(
            Effect.andThen(Effect.logWarning("backend shutdown timed out after launcher loss")),
            Effect.andThen(Effect.sync(options?.exit ?? (() => process.exit(1)))),
          ),
        ),
      ),
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
