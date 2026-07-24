import * as NodeModule from "node:module";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export function watchConfigDirectory(fs: FileSystem.FileSystem, directory: string) {
  if (!process.env.PROOT_L2S_DIR) {
    return fs.watch(directory);
  }
  const nodeFS = NodeModule.createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

  return Stream.callback<FileSystem.WatchEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = nodeFS.watch(directory, { recursive: false }, (_event, fileName) => {
          if (fileName) {
            Queue.offerUnsafe(queue, { _tag: "Update", path: String(fileName) });
          }
        });
        watcher.on("error", (error) => Queue.failCauseUnsafe(queue, Cause.die(error)));
        watcher.on("close", () => Queue.endUnsafe(queue));
        return watcher;
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ),
  );
}
