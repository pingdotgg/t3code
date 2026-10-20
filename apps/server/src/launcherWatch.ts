import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Sampled when this module loads, before config resolution and the bootstrap
// read, so a launcher that dies during startup is still noticed.
const startupParentPid = process.ppid;

/**
 * Completes when the process that launched this backend is gone.
 *
 * A desktop-launched backend reads its bootstrap envelope once and never looks
 * at its launcher again. When the launcher dies without a graceful stop (a WSL
 * relay killed during an app update, for instance), the backend would keep
 * serving and holding its ownership lock while no desktop can reach it, and
 * every replacement launch is refused. An orphan is adopted by init or, on
 * Linux, by a subreaper, so any change of parent counts rather than only a
 * move to pid 1. A backend that already starts under init has no launcher to
 * lose, and Windows keeps the original parent id after the parent exits, so
 * neither is watched.
 */
export const awaitLauncherLoss = Effect.fn("launcherWatch.awaitLauncherLoss")(function* (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly interval?: Duration.Input;
}): Effect.fn.Return<void> {
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
