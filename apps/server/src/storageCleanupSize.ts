// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect FileSystem lacks opendir and lstat; bound enumeration and do not follow symlinks.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Estimate allocated bytes without following symlinks or counting externally shared hardlinks. */
export const measureWorktreeBytes = Effect.fn("measureWorktreeBytes")(function* (root: string) {
  const path = yield* Path.Path;
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const directories = [root];
      const linkedFiles = new Map<string, { seen: number; links: number; bytes: number }>();
      let entries = 0;
      let bytes = 0;
      while (directories.length > 0) {
        const directory = directories.pop()!;
        const directoryStat = await NodeFSP.lstat(directory);
        if (!directoryStat.isDirectory()) return null;
        // Directory links include children and parents, not externally shared file data.
        bytes += directoryStat.blocks * 512;
        for await (const entry of await NodeFSP.opendir(directory)) {
          signal.throwIfAborted();
          if (++entries > 20_000) return null;
          const target = path.join(directory, entry.name);
          const stat = await NodeFSP.lstat(target);
          if (stat.isDirectory()) directories.push(target);
          else if (stat.nlink === 1) bytes += stat.blocks * 512;
          else {
            const key = `${stat.dev}:${stat.ino}`;
            const previous = linkedFiles.get(key);
            linkedFiles.set(key, {
              seen: (previous?.seen ?? 0) + 1,
              links: stat.nlink,
              bytes: stat.blocks * 512,
            });
          }
        }
      }
      for (const file of linkedFiles.values()) {
        if (file.seen === file.links) bytes += file.bytes;
      }
      return bytes;
    },
    catch: () => null,
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.timeoutOption("1 second"),
    Effect.map(Option.getOrNull),
  );
});
