/**
 * Workspace root normalization and validation helpers.
 *
 * Ensures project/workspace paths are expanded, resolved, and verified as
 * existing directories before they enter orchestration state.
 *
 * @module workspaceRoot
 */
import { Effect, FileSystem, Path, Schema } from "effect";

import { expandHomePath } from "./os-jank";

export class WorkspaceRootError extends Schema.TaggedErrorClass<WorkspaceRootError>()(
  "WorkspaceRootError",
  {
    message: Schema.String,
  },
) {}

export const resolveWorkspaceRoot = Effect.fn(function* (
  rawWorkspaceRoot: string,
  options?: {
    readonly baseDir?: string;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trimmedWorkspaceRoot = rawWorkspaceRoot.trim();

  if (trimmedWorkspaceRoot.length === 0) {
    return yield* new WorkspaceRootError({
      message: "Project directory path cannot be empty.",
    });
  }

  const expandedWorkspaceRoot = yield* expandHomePath(trimmedWorkspaceRoot);
  const normalizedWorkspaceRoot = path.isAbsolute(expandedWorkspaceRoot)
    ? path.resolve(expandedWorkspaceRoot)
    : path.resolve(options?.baseDir ?? ".", expandedWorkspaceRoot);
  const workspaceStat = yield* fileSystem
    .stat(normalizedWorkspaceRoot)
    .pipe(Effect.catch(() => Effect.succeed(null)));

  if (!workspaceStat) {
    return yield* new WorkspaceRootError({
      message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
    });
  }

  if (workspaceStat.type !== "Directory") {
    return yield* new WorkspaceRootError({
      message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
    });
  }

  const canonicalWorkspaceRoot = yield* fileSystem
    .realPath(normalizedWorkspaceRoot)
    .pipe(Effect.catch(() => Effect.succeed(normalizedWorkspaceRoot)));

  return canonicalWorkspaceRoot;
});
