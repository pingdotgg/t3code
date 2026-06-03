import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Recursively copy `sourceDir` into a fresh `fs.makeTempDirectory`
 * (with `prefix`), preserving file modes. Returns the absolute path of
 * the new temp directory.
 *
 * Used by tests that want to mutate a fixture's `src/` files without
 * polluting the source-controlled fixture or racing with other tests
 * sharing the same fixture path.
 *
 * - `tempRoot`, when provided, places the temp dir under a specific
 *   parent directory instead of the OS temp root. This matters for
 *   Vite tests because Vite's `vite:build-html` plugin can't express
 *   project roots that sit outside the current working directory; an
 *   under-workspace temp dir keeps the relative path representable.
 * - `entries`, when provided, restricts the copy to a specific subset
 *   of top-level entries. Defaults to copying everything in
 *   `sourceDir`.
 */
export const cloneFixture = Effect.fnUntraced(function* (
  sourceDir: string,
  options: {
    prefix: string;
    tempRoot?: string;
    entries?: string[];
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (options.tempRoot) {
    yield* fs.makeDirectory(options.tempRoot, { recursive: true });
  }
  const dir = yield* fs.makeTempDirectory({
    prefix: options.prefix,
    directory: options.tempRoot,
  });

  const entries = options.entries ?? (yield* fs.readDirectory(sourceDir));

  const copyTree = (relativePath: string): Effect.Effect<void, any, any> =>
    Effect.gen(function* () {
      const from = path.join(sourceDir, relativePath);
      const to = path.join(dir, relativePath);
      const stat = yield* fs.stat(from);
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(to, { recursive: true });
        const children = yield* fs.readDirectory(from);
        for (const child of children) {
          yield* copyTree(path.join(relativePath, child));
        }
      } else {
        const contents = yield* fs.readFile(from);
        yield* fs.writeFile(to, contents);
        // Preserve executable bit so copied build scripts still run.
        const mode = Number(stat.mode);
        if (mode & 0o111) {
          yield* fs.chmod(to, mode);
        }
      }
    });

  for (const entry of entries) {
    yield* copyTree(entry);
  }

  return dir;
});
