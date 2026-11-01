// @effect-diagnostics nodeBuiltinImport:off -- closing an inherited pipe fd has no Effect API.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import { recordShutdownIntent } from "./shutdownIntent.ts";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);
const LAUNCHER_KILL_GRACE = Duration.seconds(5);

// Capture before config and bootstrap reads to detect launcher loss during startup.
const startupParentPid = process.ppid;

/**
 * Any parent change signals launcher loss, including adoption by a Linux subreaper;
 * otherwise an orphan backend keeps its ownership lock and blocks replacement launches.
 * Skip init-launched backends and Windows, which retains the exited parent's id.
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

/**
 * Windows has no stop signal, so the desktop ends the stop notice before it kills the backend
 * tree. Intent must be recorded before the ack releases that kill. Completes, so the backend
 * exits, only if the launcher stopped without killing it.
 */
export const awaitLauncherStop = Effect.fn("launcherWatch.awaitLauncherStop")(function* (input: {
  readonly stopNotice: Stream.Stream<unknown, Error>;
  readonly acknowledge: Effect.Effect<void>;
}): Effect.fn.Return<void> {
  const notice = yield* Stream.runDrain(input.stopNotice).pipe(Effect.exit);
  if (Exit.isFailure(notice)) {
    yield* Effect.logWarning("desktop stop notice failed; only signals can stop the backend", {
      cause: notice.cause,
    });
    return yield* Effect.never;
  }
  recordShutdownIntent();
  yield* input.acknowledge;
  yield* Effect.sleep(LAUNCHER_KILL_GRACE);
  yield* Effect.logWarning("desktop launcher stopped without ending the backend; shutting down");
});

export const awaitLauncherStopOnFds = (fds: { readonly stopFd: number; readonly ackFd: number }) =>
  Effect.acquireRelease(
    // Socket reads stay cancellable; filesystem pipe reads keep Node alive after scope shutdown.
    Effect.try(() => new NodeNet.Socket({ fd: fds.stopFd, readable: true, writable: false })),
    (socket) => Effect.sync(() => socket.destroy()),
  ).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.logWarning("desktop stop notice is unavailable", { cause }).pipe(
          Effect.andThen(Effect.never),
        ),
      onSuccess: (socket) =>
        awaitLauncherStop({
          stopNotice: NodeStream.fromReadable<Uint8Array, Error>({
            evaluate: () => socket,
            closeOnDone: true,
            onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
          acknowledge: Effect.try(() => NodeFS.closeSync(fds.ackFd)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("could not acknowledge the desktop stop notice", { cause }),
            ),
          ),
        }),
    }),
    Effect.scoped,
  );
