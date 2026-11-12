import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Resolves a Vite Worker's `main` against the Vite root when it is a path
 * or names a file there. Any other specifier (a package export, a virtual
 * module) is handed to Vite unchanged, as `@cloudflare/vite-plugin` does.
 */
export const resolveViteMain = Effect.fn(function* (root: string, main: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(root, main);
  if (path.isAbsolute(main) || /^\.\.?[\\/]/.test(main)) {
    return resolved;
  }
  return (yield* fs.exists(resolved).pipe(Effect.orElseSucceed(() => false))) ? resolved : main;
});
