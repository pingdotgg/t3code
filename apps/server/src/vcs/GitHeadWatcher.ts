// @effect-diagnostics nodeBuiltinImport:off - FileSystem.watch does not expose native registration readiness.
import * as NodeFS from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class GitHeadWatcher extends Context.Service<
  GitHeadWatcher,
  {
    /** Returns only after the native listener is registered; events buffer until consumed. */
    readonly acquire: (
      directory: string,
    ) => Effect.Effect<
      Stream.Stream<string | null, PlatformError.PlatformError>,
      PlatformError.PlatformError,
      Scope.Scope
    >;
  }
>()("t3/vcs/GitHeadWatcher") {}

export const make = (
  watch: (
    directory: string,
    options: NodeFS.WatchOptionsWithStringEncoding,
    listener: NodeFS.WatchListener<string>,
  ) => NodeFS.FSWatcher,
) =>
  GitHeadWatcher.of({
    acquire: Effect.fn("GitHeadWatcher.acquire")(function* (directory) {
      const events = yield* Effect.acquireRelease(
        Queue.unbounded<string | null, PlatformError.PlatformError | Cause.Done>(),
        Queue.shutdown,
      );
      const watchError = (cause: unknown) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "watch",
          pathOrDescriptor: directory,
          cause,
        });
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const watcher = watch(directory, { recursive: false }, (_event, filename) => {
              Queue.offerUnsafe(events, filename);
            });
            watcher.on("error", (cause) =>
              Queue.failCauseUnsafe(events, Cause.fail(watchError(cause))),
            );
            watcher.on("close", () => Queue.endUnsafe(events));
            return watcher;
          },
          catch: watchError,
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      );
      return Stream.fromQueue(events);
    }),
  });

export const layer = Layer.succeed(GitHeadWatcher, make(NodeFS.watch));
