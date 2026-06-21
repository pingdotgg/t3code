import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  WorkspaceRootStatFailedError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const statWorkspaceRoot = Effect.fn("WorkspacePaths.statWorkspaceRoot")(function* (
    workspaceRoot: string,
    normalizedWorkspaceRoot: string,
    phase: WorkspaceRootStatFailedError["phase"],
  ) {
    return yield* fileSystem.stat(normalizedWorkspaceRoot).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new WorkspaceRootStatFailedError({
                  workspaceRoot,
                  normalizedWorkspaceRoot,
                  phase,
                  cause,
                }),
              ),
        onSuccess: Effect.succeed,
      }),
    );
  });

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* statWorkspaceRoot(
      workspaceRoot,
      normalizedWorkspaceRoot,
      "validate-existing",
    );
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
              cause,
            }),
        ),
      );
      workspaceStat = yield* statWorkspaceRoot(
        workspaceRoot,
        normalizedWorkspaceRoot,
        "verify-created",
      );
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);
