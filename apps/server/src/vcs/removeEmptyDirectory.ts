// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no rmdir.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";

/**
 * Removes `path` only while it is an empty directory. Succeeds with false when
 * anything else is there, including files written after the caller looked.
 * Other failures, such as a permission error, stay errors.
 */
export const removeEmptyDirectory = (path: string) =>
  Effect.tryPromise(() => NodeFSP.rmdir(path)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY",
      () => Effect.succeed(false),
    ),
  );
