// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no rmdir.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class RemoveEmptyDirectoryError extends Schema.TaggedError<RemoveEmptyDirectoryError>()(
  "RemoveEmptyDirectoryError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not remove the directory ${this.path}.`;
  }
}

/**
 * Removes `path` only while it is an empty directory. Succeeds with false when
 * anything else is there, including files written after the caller looked.
 * Other failures, such as a permission error, stay errors.
 */
export const removeEmptyDirectory = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.rmdir(path),
    catch: (cause) => new RemoveEmptyDirectoryError({ path, cause }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOTEMPTY",
      () => Effect.succeed(false),
    ),
  );
