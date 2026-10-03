import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

const MAX_SYMLINK_HOPS = 40;

/**
 * Follows a chain of symlinks to the file it finally names, which may not exist
 * yet. Any path that is not a symlink resolves to itself. Atomic writers rename
 * onto this path so a linked file keeps its link. Fails on a cycle or an overly
 * long chain rather than handing back a link that a rename would replace.
 */
export const resolveSymlinkTarget = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(filePath);
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      const link = yield* fs.readLink(current).pipe(Effect.option);
      if (link._tag === "None") {
        return current;
      }
      current = path.resolve(path.dirname(current), link.value);
    }
    return yield* PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      description: "Too many levels of symbolic links",
      pathOrDescriptor: filePath,
    });
  });
