// @effect-diagnostics nodeBuiltinImport:off - Node's native realpath expands Windows 8.3 aliases.
import * as NodeFS from "node:fs";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

class NativeRealPathError extends Data.TaggedError("NativeRealPathError")<{
  readonly path: string;
}> {}

/**
 * Return the native canonical form of an existing path when possible.
 *
 * Node's native realpath is important on Windows because it expands 8.3 path aliases. The Effect
 * filesystem remains the portable fallback, and callers still receive their original path when the
 * target does not exist or neither filesystem implementation can resolve it.
 */
export const canonicalizeExistingPath = Effect.fn("CanonicalPath.canonicalizeExistingPath")(
  function* (fileSystem: FileSystem.FileSystem, path: string) {
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          NodeFS.realpath.native(path, (error, resolvedPath) => {
            if (error) {
              reject(error);
            } else {
              resolve(resolvedPath);
            }
          });
        }),
      catch: () => new NativeRealPathError({ path }),
    }).pipe(
      Effect.catch(() => fileSystem.realPath(path)),
      Effect.orElseSucceed(() => path),
    );
  },
);
