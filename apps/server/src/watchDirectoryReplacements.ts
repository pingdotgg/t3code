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

const resolveLinkedPath = Effect.fn("watchDirectoryReplacements.resolveLinkedPath")(function* (
  entry: string,
  link: string,
) {
  const path = yield* Path.Path;
  const resolved = yield* realPath(entry).pipe(Effect.option);
  if (Option.isSome(resolved)) return resolved.value;

  // A dangling link needs a watch on the directory where its target should appear.
  const rawTarget = path.isAbsolute(link) ? link : `${path.dirname(entry)}${path.sep}${link}`;
  const parent = yield* realPath(path.dirname(rawTarget)).pipe(Effect.option);
  if (Option.isNone(parent)) return entry;

  const unresolved = path.join(parent.value, path.basename(rawTarget));
  return yield* resolveSymlinkTarget(unresolved).pipe(Effect.orElseSucceed(() => unresolved));
});

/** Watch replacements of a configured directory and nearby ancestors of its symlink target. */
export const watchDirectoryPath = (
  directory: string,
  watchChild: Stream.Stream<void>,
  consumeMissingObservation: Effect.Effect<boolean>,
) => {
  const entry = NodePath.resolve(directory);
  return watchDirectoryReplacements(
    (ready) => watchDirectoryEntry(entry, ready),
    Stream.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let childEnded = false;
        const watchContents = Stream.suspend(() => {
          childEnded = false;
          return watchChild.pipe(
            Stream.onEnd(
              Effect.sync(() => {
                childEnded = true;
              }),
            ),
          );
        });

        const statIdentity = fs
          .stat(entry)
          .pipe(
            Effect.map(
              (info) =>
                `${info.dev}:${info.ino.valueOrUndefined}:${info.birthtime.valueOrUndefined?.getTime()}`,
            ),
          );
        // One probe per second catches replacements the watches cannot see: a link target's
        // ancestors, or the entry becoming a link before macOS has armed the parent watch.
        // A missing entry probes as null and a link whose target is missing as "".
        const identity = fs.readLink(entry).pipe(
          Effect.matchEffect({
            onSuccess: (link) =>
              statIdentity.pipe(
                Effect.map((id) => `link:${id}:${link}`),
                Effect.orElseSucceed(() => ""),
              ),
            onFailure: () =>
              statIdentity.pipe(
                Effect.map((id) => `plain:${id}`),
                Effect.orElseSucceed(() => null),
              ),
          }),
        );
        // The identity of the tree the current watches were acquired on.
        let previous: string | null | undefined;
        return watchDirectoryReplacements(
          (ready) => {
            let retryDelay = 1;
            let nextRetry = 0;
            return Stream.tick("1 second").pipe(
              Stream.mapEffect(() => identity),
              Stream.zipWithIndex,
              Stream.mapEffect(([current, tick]) =>
                Effect.gen(function* () {
                  // A catalog read can see the path missing even if both probes see the same inode.
                  const sawMissing = Boolean(current) && (yield* consumeMissingObservation);
                  const replaced = previous !== undefined && current !== previous;
                  const firstProbe = previous === undefined;
                  previous = current;

                  if (replaced || sawMissing || !childEnded) {
                    retryDelay = 1;
                    nextRetry = tick + 1;
                  }
                  if (firstProbe) return false;
                  if (replaced || sawMissing) return true;
                  if (!childEnded || !current || tick < nextRetry) return false;

                  // A stable inode can stay unwatchable due to permissions or OS watch limits.
                  retryDelay = Math.min(60, retryDelay * 2);
                  nextRetry = tick + retryDelay;
                  return true;
                }),
              ),
              Stream.tap(() => Deferred.succeed(ready, undefined)),
              Stream.filter((rebuild) => rebuild),
            );
          },
          Stream.unwrap(
            // Probe before resolving so a tree swapped in between reads as a replacement.
            identity.pipe(
              Effect.tap((acquired) =>
                Effect.sync(() => {
                  previous = acquired;
                }),
              ),
              Effect.andThen(fs.readLink(entry).pipe(Effect.option)),
              Effect.flatMap((link) =>
                Option.isSome(link) ? resolveLinkedPath(entry, link.value) : Effect.succeed(entry),
              ),
              Effect.map((target) => {
                if (target === entry || target === NodePath.dirname(target)) return watchContents;
                return watchDirectoryReplacements(
                  (ready) => watchDirectoryEntry(NodePath.dirname(target), ready),
                  watchDirectoryReplacements(
                    (ready) => watchDirectoryEntry(target, ready),
                    watchContents,
                  ),
                );
              }),
            ),
          ),
        );
      }),
    ),
  );
};
