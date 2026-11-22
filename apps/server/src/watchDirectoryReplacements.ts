// @effect-diagnostics nodeBuiltinImport:off - parent watches need native filename filtering and path resolution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Buffer parent events before opening the child watch so a replacement cannot strand it. */
export const watchDirectoryReplacements = <R>(
  watchParent: (ready: Deferred.Deferred<void>) => Stream.Stream<unknown, unknown>,
  watchChild: Stream.Stream<void, never, R>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const replacements = yield* watchParent(ready).pipe(
        Stream.ignoreCause({ log: true }),
        Stream.ensuring(Deferred.succeed(ready, undefined)),
        Stream.toQueue({ capacity: 1, strategy: "sliding" }),
      );
      yield* Deferred.await(ready);

      return Stream.make(watchChild).pipe(
        Stream.concat(Stream.fromQueue(replacements).pipe(Stream.as(watchChild))),
        Stream.switchMap((events) => events),
      );
    }),
  );

const watchDirectoryEntry = (path: string, ready: Deferred.Deferred<void>) => {
  const directory = NodePath.dirname(path);
  const name = NodePath.basename(path);
  const watchError = (cause: unknown) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "watch",
      pathOrDescriptor: directory,
      cause,
    });
  // Filter in the native callback to avoid queueing and statting unrelated entries.
  return Stream.callback<void, PlatformError.PlatformError>(
    (events) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const watcher = NodeFS.watch(directory, (_, filename) => {
              if (filename === name || filename === null) Queue.offerUnsafe(events, undefined);
            });
            watcher.on("error", (error) =>
              Queue.failCauseUnsafe(events, Cause.fail(watchError(error))),
            );
            watcher.on("close", () => Queue.endUnsafe(events));
            return watcher;
          },
          catch: watchError,
        }),
        (watcher) => Effect.sync(() => watcher.close()),
      ).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
    { bufferSize: 1, strategy: "sliding" },
  );
};

// Node's JS realpath can collapse `..` before resolving a symlink in the preceding segment.
const realPath = (entry: string) =>
  Effect.callback<string, NodeJS.ErrnoException>((resume) => {
    NodeFS.realpath.native(entry, (error, resolved) => {
      resume(error ? Effect.fail(error) : Effect.succeed(resolved));
    });
  });

const resolveWatchTarget = Effect.fn("watchDirectoryReplacements.resolveWatchTarget")(function* (
  entry: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* fs.readLink(entry).pipe(Effect.option);
  if (Option.isNone(link)) return entry;

  const resolved = yield* realPath(entry).pipe(Effect.option);
  if (Option.isSome(resolved)) return resolved.value;

  // A dangling link needs a watch on the directory where its target should appear.
  const rawTarget = path.isAbsolute(link.value)
    ? link.value
    : `${path.dirname(entry)}${path.sep}${link.value}`;
  const parent = yield* realPath(path.dirname(rawTarget)).pipe(Effect.option);
  const unresolved = Option.isSome(parent)
    ? path.join(parent.value, path.basename(rawTarget))
    : entry;
  return yield* resolveSymlinkTarget(unresolved).pipe(Effect.orElseSucceed(() => unresolved));
});

/** Watch replacements of a configured directory, its symlink target, and the target's parent. */
export const watchDirectoryPath = (directory: string, watchChild: Stream.Stream<void>) => {
  const entry = NodePath.resolve(directory);
  return watchDirectoryReplacements(
    (ready) => watchDirectoryEntry(entry, ready),
    Stream.unwrap(
      resolveWatchTarget(entry).pipe(
        Effect.map((target) => {
          if (target === entry) return watchChild;
          return watchDirectoryReplacements(
            (ready) => watchDirectoryEntry(NodePath.dirname(target), ready),
            watchDirectoryReplacements((ready) => watchDirectoryEntry(target, ready), watchChild),
          );
        }),
      ),
    ),
  );
};
