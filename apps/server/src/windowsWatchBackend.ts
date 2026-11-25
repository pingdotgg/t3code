// @effect-diagnostics nodeBuiltinImport:off -- Windows directory watches need native close-on-delete before libuv/fiber flooding.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const watchError = (pathOrDescriptor: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "watch",
    pathOrDescriptor,
    cause,
  });

const watchWindows = (
  watchedPath: string,
  info: FileSystem.File.Info,
  options?: FileSystem.WatchOptions,
): Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError> =>
  Stream.callback<FileSystem.WatchEvent, PlatformError.PlatformError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const directory = info.type === "Directory" ? watchedPath : NodePath.dirname(watchedPath);
          let closed = false;
          let watcher: NodeFS.FSWatcher | undefined;

          const closeWatcher = () => {
            if (closed) return;
            closed = true;
            watcher?.close();
            Queue.endUnsafe(queue);
          };

          const isWatchedDirectoryGone = () =>
            info.type === "Directory" && !NodeFS.existsSync(watchedPath);

          watcher = NodeFS.watch(
            watchedPath,
            { recursive: options?.recursive ?? false },
            (event, filename) => {
              if (closed || !filename) return;
              if (event === "change") {
                Queue.offerUnsafe(queue, { _tag: "Update", path: filename });
                return;
              }
              if (event === "rename") {
                // On Windows, ReadDirectoryChangesW fires ~150k rename events/sec on a deleted
                // directory until closed. Close synchronously before queueing async stats.
                if (isWatchedDirectoryGone()) {
                  Queue.offerUnsafe(queue, { _tag: "Remove", path: filename });
                  closeWatcher();
                  return;
                }
                NodeFS.stat(NodePath.resolve(directory, filename), (error) => {
                  if (closed) return;
                  if (error) {
                    Queue.offerUnsafe(queue, { _tag: "Remove", path: filename });
                    if (isWatchedDirectoryGone()) {
                      closeWatcher();
                    }
                    return;
                  }
                  Queue.offerUnsafe(queue, { _tag: "Create", path: filename });
                });
              }
            },
          );
          watcher.on("error", (error) => {
            if (closed) return;
            closed = true;
            watcher?.close();
            Queue.failCauseUnsafe(queue, Cause.fail(watchError(watchedPath, error)));
          });
          watcher.on("close", () => {
            if (closed) return;
            closed = true;
            Queue.endUnsafe(queue);
          });
          return closeWatcher;
        },
        catch: (cause) => watchError(watchedPath, cause),
      }),
      (closeWatcher) => Effect.sync(closeWatcher),
    ).pipe(Effect.tap(() => Effect.sync(() => options?.onReady?.()))),
  );

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  return FileSystem.WatchBackend.of({
    register: (path, info, options) =>
      platform === "win32" ? Option.some(watchWindows(path, info, options)) : Option.none(),
  });
});

export const layer = Layer.effect(FileSystem.WatchBackend, make);
