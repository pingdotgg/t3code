import { normalizeDotenvSyncPaths } from "@t3tools/shared/dotenvSync";
import { Effect, FileSystem, Layer, Path } from "effect";

import { WorktreeDotenvSyncError } from "../Errors.ts";
import { WorktreeDotenvSync, type WorktreeDotenvSyncShape } from "../Services/WorktreeDotenvSync.ts";

function toWorktreeDotenvSyncError(operation: string, detail: string, cause?: unknown) {
  return new WorktreeDotenvSyncError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const makeWorktreeDotenvSync = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const syncFiles: WorktreeDotenvSyncShape["syncFiles"] = (input) =>
    Effect.gen(function* () {
      const normalizedPathsResult = normalizeDotenvSyncPaths(input.paths);
      if (normalizedPathsResult.error) {
        return yield* toWorktreeDotenvSyncError(
          "WorktreeDotenvSync.syncFiles",
          normalizedPathsResult.error,
        );
      }

      const sourceRoot = path.resolve(input.cwd);
      const worktreeRoot = path.resolve(input.worktreePath);
      const plans = yield* Effect.forEach(
        normalizedPathsResult.normalizedPaths,
        (relativePath) =>
          Effect.gen(function* () {
            const sourcePath = path.resolve(sourceRoot, relativePath);
            const targetPath = path.resolve(worktreeRoot, relativePath);
            const sourceRelative = path.relative(sourceRoot, sourcePath).replaceAll("\\", "/");
            const targetRelative = path.relative(worktreeRoot, targetPath).replaceAll("\\", "/");
            if (
              sourceRelative.startsWith("../") ||
              sourceRelative === ".." ||
              targetRelative.startsWith("../") ||
              targetRelative === ".."
            ) {
              return yield* toWorktreeDotenvSyncError(
                "WorktreeDotenvSync.syncFiles",
                `Resolved dotenv path escapes the workspace: ${relativePath}`,
              );
            }

            const sourceInfo = yield* fileSystem.stat(sourcePath).pipe(
              Effect.mapError((cause) =>
                toWorktreeDotenvSyncError(
                  "WorktreeDotenvSync.syncFiles",
                  `Dotenv source file does not exist: ${relativePath}`,
                  cause,
                ),
              ),
            );
            if (sourceInfo.type !== "File") {
              return yield* toWorktreeDotenvSyncError(
                "WorktreeDotenvSync.syncFiles",
                `Dotenv source is not a file: ${relativePath}`,
              );
            }

            return {
              relativePath,
              sourcePath,
              targetPath,
            };
          }),
        { concurrency: 1 },
      );

      yield* Effect.forEach(
        plans,
        (plan) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(path.dirname(plan.targetPath), { recursive: true }).pipe(
              Effect.mapError((cause) =>
                toWorktreeDotenvSyncError(
                  "WorktreeDotenvSync.syncFiles",
                  `Failed to prepare worktree path for ${plan.relativePath}`,
                  cause,
                ),
              ),
            );
            const contents = yield* fileSystem.readFile(plan.sourcePath).pipe(
              Effect.mapError((cause) =>
                toWorktreeDotenvSyncError(
                  "WorktreeDotenvSync.syncFiles",
                  `Failed to read dotenv source file: ${plan.relativePath}`,
                  cause,
                ),
              ),
            );
            yield* fileSystem.writeFile(plan.targetPath, contents).pipe(
              Effect.mapError((cause) =>
                toWorktreeDotenvSyncError(
                  "WorktreeDotenvSync.syncFiles",
                  `Failed to copy dotenv file into worktree: ${plan.relativePath}`,
                  cause,
                ),
              ),
            );
          }),
        { concurrency: 1 },
      );

      return {
        copiedPaths: normalizedPathsResult.normalizedPaths,
      };
    });

  return {
    syncFiles,
  } satisfies WorktreeDotenvSyncShape;
});

export const WorktreeDotenvSyncLive = Layer.effect(WorktreeDotenvSync, makeWorktreeDotenvSync);
