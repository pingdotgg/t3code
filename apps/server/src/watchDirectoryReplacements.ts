// @effect-diagnostics nodeBuiltinImport:off - parent watches need native filename filtering and path resolution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { MAX_SYMLINK_HOPS } from "@t3tools/shared/symlink";
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
  let candidate = entry;
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    // Keep the raw prefix through native realpath so symlinks before `..` still take effect.
    const suffix: Array<string> = [];
    let prefix = candidate;
    let resolved = yield* realPath(prefix).pipe(Effect.option);
    while (Option.isNone(resolved)) {
      const parent = path.dirname(prefix);
      if (parent === prefix) return entry;
      suffix.unshift(path.basename(prefix));
      prefix = parent;
      resolved = yield* realPath(prefix).pipe(Effect.option);
    }

    const [first, ...rest] = suffix;
    if (first === undefined) return resolved.value;
    // The first unresolved component can itself be a dangling symlink.
    const link = yield* fs.readLink(path.join(resolved.value, first)).pipe(Effect.option);
    if (Option.isNone(link)) return path.join(resolved.value, ...suffix);
    const destination = path.isAbsolute(link.value)
      ? link.value
      : `${resolved.value}${path.sep}${link.value}`;
    candidate = [destination, ...rest].join(path.sep);
  }
  return entry;
});

/** Watch replacements of a configured directory and nearby ancestors of its symlink target. */
export const watchDirectoryPath = (directory: string, watchChild: Stream.Stream<void>) => {
  const entry = NodePath.resolve(directory);
  return watchDirectoryReplacements(
    (ready) => watchDirectoryEntry(entry, ready),
    Stream.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (Option.isNone(yield* fs.readLink(entry).pipe(Effect.option))) return watchChild;

        // An intermediate symlink can move resolution away from a still-intact canonical tree.
        const identity = fs.stat(entry).pipe(
          Effect.map(
            (info) =>
              `${info.dev}:${info.ino.valueOrUndefined}:${info.birthtime.valueOrUndefined?.getTime()}`,
          ),
          Effect.orElseSucceed(() => null),
        );
        return watchDirectoryReplacements(
          (ready) =>
            Stream.tick("1 second").pipe(
              Stream.mapEffect(() => identity),
              Stream.changes,
              Stream.tap(() => Deferred.succeed(ready, undefined)),
              Stream.drop(1),
            ),
          Stream.unwrap(
            resolveWatchTarget(entry).pipe(
              Effect.map((target) => {
                if (target === entry) return watchChild;
                let watch = watchChild;
                for (const current of [target, NodePath.dirname(target)]) {
                  if (current === NodePath.dirname(current)) break;
                  watch = watchDirectoryReplacements(
                    (ready) => watchDirectoryEntry(current, ready),
                    watch,
                  );
                }
                return watch;
              }),
            ),
          ),
        );
      }),
    ),
  );
};
