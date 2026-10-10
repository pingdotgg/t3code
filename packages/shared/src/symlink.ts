import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

const MAX_SYMLINK_HOPS = 40;

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const isNotASymlink = (error: PlatformError.PlatformError) =>
  isNotFound(error) ||
  (error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL");

/**
 * Follows a chain of symlinks to the file it finally names, which may not exist
 * yet. Any path that is not a symlink resolves to itself. Atomic writers rename
 * onto this path so a linked file keeps its link. Fails on a cycle, an overly
 * long chain, or an unreadable link rather than handing back a link that a
 * rename would replace.
 */
export const resolveSymlinkTarget = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(filePath);
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
      const link = yield* fs.readLink(current).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isNotASymlink, () => Effect.succeedNone),
      );
      if (Option.isNone(link)) {
        return current;
      }
      // A relative target is relative to where the link really lives, which
      // differs from its lexical parent when that parent is itself a symlink.
      const linkDirectory = yield* fs
        .realPath(path.dirname(current))
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(path.dirname(current))));
      current = path.resolve(linkDirectory, link.value);
    }
    return yield* PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      description: "Too many levels of symbolic links",
      pathOrDescriptor: filePath,
    });
  });
