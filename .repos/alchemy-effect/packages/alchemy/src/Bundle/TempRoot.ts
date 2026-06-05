import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as crypto from "node:crypto";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";

/**
 * Creates a unique bundle staging directory under the nearest package-local
 * `.alchemy/tmp` root. Each invocation gets its own directory (via a random
 * nonce) so concurrent bundle operations for the same resource never collide.
 * Stale directories from previous crashed runs are cleaned up best-effort.
 */
export const createTempBundleDir = (
  entry: string,
  dotAlchemy: string,
  id: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const tempRoot = yield* findBundleTempRoot(entry, dotAlchemy);
    yield* fs.makeDirectory(tempRoot, { recursive: true });

    const nonce = crypto.randomUUID().slice(0, 8);
    const bundleId = `${stack.name}-${stage}-${id}-${nonce}`;
    const tempDir = path.join(tempRoot, bundleId);
    yield* fs.makeDirectory(tempDir, { recursive: true });

    return tempDir;
  });

/**
 * Returns a deterministic bundle staging directory without clearing it first.
 * Useful for Docker build contexts where keeping the directory stable avoids
 * unnecessary file churn between builds.
 */
export const getStableContextDir = (
  entry: string,
  dotAlchemy: string,
  id: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const tempRoot = yield* findBundleTempRoot(entry, dotAlchemy);
    const bundleId = `${stack.name}-${stage}-${id}`;
    const tempDir = path.join(tempRoot, bundleId);

    yield* fs.makeDirectory(tempDir, { recursive: true });

    return tempDir;
  });

/**
 * Cleans up a bundle's private temp directory.
 */
export const cleanupBundleTempDir = (tempDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
  });

const findBundleTempRoot = (entry: string, dotAlchemy: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let current = path.dirname(entry);
    while (true) {
      // `node_modules` acts as the package/workspace anchor for temp bundles.
      if (yield* fs.exists(path.join(current, "node_modules"))) {
        return path.join(current, path.basename(dotAlchemy), "tmp");
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return path.join(path.dirname(entry), path.basename(dotAlchemy), "tmp");
  });

export const findCwdForBundle = Effect.fnUntraced(function* (entry: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.dirname(entry);
  while (true) {
    if (yield* fs.exists(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
});
