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
      let entries = 0;
      let bytes = 0;
      while (directories.length > 0) {
        const directory = directories.pop()!;
        for await (const entry of await NodeFSP.opendir(directory)) {
          signal.throwIfAborted();
          if (++entries > 20_000) return null;
          const target = path.join(directory, entry.name);
          const stat = await NodeFSP.lstat(target);
          if (stat.isDirectory()) directories.push(target);
          else if (stat.nlink === 1) bytes += stat.blocks * 512;
        }
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
