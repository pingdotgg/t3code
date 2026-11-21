// @effect-diagnostics nodeBuiltinImport:off - parent watches need native filename filtering and path resolution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
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

  // Keep the raw prefix through native realpath so symlinks before `..` still take effect.
  const rawTarget = path.isAbsolute(link.value)
    ? link.value
    : `${path.dirname(entry)}${path.sep}${link.value}`;
  const suffix = [path.basename(rawTarget)];
  let unresolved = entry;
  for (let prefix = path.dirname(rawTarget); ; prefix = path.dirname(prefix)) {
    const resolvedPrefix = yield* realPath(prefix).pipe(Effect.option);
    if (Option.isSome(resolvedPrefix)) {
      unresolved = path.join(resolvedPrefix.value, ...suffix);
      break;
    }
    if (prefix === path.dirname(prefix)) break;
    suffix.unshift(path.basename(prefix));
  }
  return yield* resolveSymlinkTarget(unresolved).pipe(Effect.orElseSucceed(() => unresolved));
});

const containsPath = (directory: string, child: string) => {
  const relative = NodePath.relative(directory, child);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

/** Watch replacements of a configured directory and nearby ancestors of its symlink target. */
export const watchDirectoryPath = (directory: string, watchChild: Stream.Stream<void>) => {
  const entry = NodePath.resolve(directory);
  return watchDirectoryReplacements(
    (ready) => watchDirectoryEntry(entry, ready),
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* resolveWatchTarget(entry);
        if (target === entry) return watchChild;

        const parent = NodePath.dirname(target);
        const grandparent = NodePath.dirname(parent);
        const watchRoot = NodePath.dirname(grandparent);
        const home = yield* HostProcess.HomeDirectory;
        const boundaries = yield* Effect.forEach([home, NodePath.dirname(entry)], (directory) =>
          realPath(directory).pipe(Effect.orElseSucceed(() => directory)),
        );
        const entries = [target, parent];
        // On macOS a broad directory watch receives events from its entire subtree.
        if (
          watchRoot !== NodePath.dirname(watchRoot) &&
          boundaries.every((boundary) => !containsPath(watchRoot, boundary))
        ) {
          entries.push(grandparent);
        }

        let watch = watchChild;
        for (const current of entries) {
          if (current === NodePath.dirname(current)) break;
          watch = watchDirectoryReplacements((ready) => watchDirectoryEntry(current, ready), watch);
        }
        return watch;
      }),
    ),
  );
};
