/**
 * WorkspacePaths - Effect service contract for workspace path handling.
 *
 * Owns normalization and validation of workspace roots plus safe resolution of
 * workspace-root-relative paths.
 *
 * @module WorkspacePaths
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseGitDirPointer } from "@t3tools/shared/git";

import { expandHomePathWith } from "../pathExpansion.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootStatFailedError extends Schema.TaggedErrorClass<WorkspaceRootStatFailedError>()(
  "WorkspaceRootStatFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    phase: Schema.Literals(["validate-existing", "verify-created"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat workspace root '${this.normalizedWorkspaceRoot}' during '${this.phase}'.`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export class WorkspaceRootBareRepositoryLayoutError extends Schema.TaggedErrorClass<WorkspaceRootBareRepositoryLayoutError>()(
  "WorkspaceRootBareRepositoryLayoutError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `'${this.normalizedWorkspaceRoot}' points at a bare Git repository instead of a working tree. Add an individual worktree directory instead.`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootStatFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootBareRepositoryLayoutError,
  WorkspacePathOutsideRootError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

/** Service tag for workspace path normalization and resolution. */
export class WorkspacePaths extends Context.Service<
  WorkspacePaths,
  {
    /** Normalize a user-provided workspace root and verify it exists as a directory. */
    readonly normalizeWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly createIfMissing?: boolean },
    ) => Effect.Effect<
      string,
      | WorkspaceRootNotExistsError
      | WorkspaceRootCreateFailedError
      | WorkspaceRootStatFailedError
      | WorkspaceRootNotDirectoryError
    >;
    /**
     * Reject a normalized root whose in-root gitdir is still a bare repository.
     * Only the paths that add a project
     * call this; every other caller keeps working with such a root.
     */
    readonly ensureNotBareRepositoryLayout: (
      normalizedWorkspaceRoot: string,
    ) => Effect.Effect<string, WorkspaceRootBareRepositoryLayoutError>;
    /**
     * Resolve a relative path within a validated workspace root.
     *
     * Rejects absolute paths and traversal attempts outside the workspace root.
     */
    readonly resolveRelativePathWithinRoot: (input: {
      workspaceRoot: string;
      relativePath: string;
    }) => Effect.Effect<
      { absolutePath: string; relativePath: string },
      WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspacePaths") {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;

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

  // An in-root gitdir can also belong to a valid separate-git-dir checkout.
  // Trust Git's current bare status, not index presence or historical intent:
  // a previously bare root converted to a working tree remains accepted.
  const isBareRepositoryLayout = Effect.fn("WorkspacePaths.isBareRepositoryLayout")(function* (
    normalizedWorkspaceRoot: string,
  ) {
    const gitPath = path.join(normalizedWorkspaceRoot, ".git");
    const gitStat = yield* fileSystem.stat(gitPath).pipe(Effect.option);
    if (gitStat._tag === "None" || gitStat.value.type !== "File") return false;

    const gitFile = yield* fileSystem.readFileString(gitPath).pipe(Effect.orElseSucceed(() => ""));
    const gitDirTarget = parseGitDirPointer(gitFile);
    if (gitDirTarget === undefined) return false;

    const gitDir = path.resolve(normalizedWorkspaceRoot, gitDirTarget);
    const gitDirFromRoot = path.relative(normalizedWorkspaceRoot, gitDir);
    if (
      gitDirFromRoot.length === 0 ||
      gitDirFromRoot === ".." ||
      gitDirFromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(gitDirFromRoot)
    ) {
      return false;
    }

    return yield* vcsProcess
      .run({
        operation: "WorkspacePaths.isBareRepositoryLayout",
        command: "git",
        args: ["--git-dir", gitDir, "rev-parse", "--is-bare-repository"],
        cwd: normalizedWorkspaceRoot,
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
        Effect.orElseSucceed(() => false),
      );
  });

  const normalizeWorkspaceRoot: WorkspacePaths["Service"]["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePathWith(workspaceRoot.trim(), path));
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

  const ensureNotBareRepositoryLayout: WorkspacePaths["Service"]["ensureNotBareRepositoryLayout"] =
    Effect.fn("WorkspacePaths.ensureNotBareRepositoryLayout")(function* (normalizedWorkspaceRoot) {
      if (yield* isBareRepositoryLayout(normalizedWorkspaceRoot)) {
        return yield* new WorkspaceRootBareRepositoryLayoutError({
          workspaceRoot: normalizedWorkspaceRoot,
          normalizedWorkspaceRoot,
        });
      }
      return normalizedWorkspaceRoot;
    });

  const resolveRelativePathWithinRoot: WorkspacePaths["Service"]["resolveRelativePathWithinRoot"] =
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

  return WorkspacePaths.of({
    normalizeWorkspaceRoot,
    ensureNotBareRepositoryLayout,
    resolveRelativePathWithinRoot,
  });
});

export const layer = Layer.effect(WorkspacePaths, make).pipe(Layer.provide(VcsProcess.layer));
