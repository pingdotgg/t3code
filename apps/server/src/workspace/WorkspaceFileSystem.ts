// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

const nextAncestorPath = Effect.fn("WorkspaceFileSystem.nextAncestorPath")(function* (input: {
  readonly path: Path.Path;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly resolvedPath: string;
  readonly currentAncestor: string;
}) {
  const parentAncestor = input.path.dirname(input.currentAncestor);
  if (parentAncestor === input.currentAncestor) {
    return yield* new WorkspaceFileSystemOperationError({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      resolvedPath: input.resolvedPath,
      operationPath: input.currentAncestor,
      operation: "realpath-target",
    });
  }
  return parentAncestor;
});

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

class WorkspaceRealPathProbeError extends Schema.TaggedErrorClass<WorkspaceRealPathProbeError>()(
  "WorkspaceRealPathProbeError",
  {
    operation: Schema.Literals(["realpath-target", "stat"]),
    cause: Schema.Defect(),
  },
) {}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const assertRealPathWithinWorkspace = Effect.fn(
    "WorkspaceFileSystem.assertRealPathWithinWorkspace",
  )(function* (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly resolvedWorkspaceRoot: string;
    readonly resolvedPath: string;
  }) {
    const relativeRealPath = path.relative(input.resolvedWorkspaceRoot, input.resolvedPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError(input);
    }
  });

  const realPathOrNull = Effect.fn("WorkspaceFileSystem.realPathOrNull")(function* (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly resolvedPath: string;
    readonly operationPath: string;
  }) {
    const realPathResult = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.operationPath),
      catch: (cause) => new WorkspaceRealPathProbeError({ operation: "realpath-target", cause }),
    }).pipe(Effect.result);
    if (realPathResult._tag === "Success") {
      return realPathResult.success;
    }
    if ((realPathResult.failure.cause as NodeJS.ErrnoException).code !== "ENOENT") {
      return yield* new WorkspaceFileSystemOperationError({
        ...input,
        operation: realPathResult.failure.operation,
        cause: realPathResult.failure.cause,
      });
    }

    const lstatResult = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(input.operationPath),
      catch: (cause) => new WorkspaceRealPathProbeError({ operation: "stat", cause }),
    }).pipe(Effect.result);
    if (lstatResult._tag === "Failure") {
      if ((lstatResult.failure.cause as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      return yield* new WorkspaceFileSystemOperationError({
        ...input,
        operation: lstatResult.failure.operation,
        cause: lstatResult.failure.cause,
      });
    }

    // The directory entry exists but cannot be canonicalized, such as a
    // dangling symlink. It must not be treated as a creatable path.
    return yield* new WorkspaceFileSystemOperationError({
      ...input,
      operation: "realpath-target",
      cause: realPathResult.failure.cause,
    });
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    yield* assertRealPathWithinWorkspace({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedWorkspaceRoot: realWorkspaceRoot,
      resolvedPath: realTargetPath,
    });

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const targetParent = path.dirname(target.absolutePath);
    let existingAncestor = targetParent;
    while (true) {
      const realExistingAncestor = yield* realPathOrNull({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        operationPath: existingAncestor,
      });
      if (realExistingAncestor !== null) {
        yield* assertRealPathWithinWorkspace({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: realExistingAncestor,
        });
        break;
      }
      existingAncestor = yield* nextAncestorPath({
        path,
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        currentAncestor: existingAncestor,
      });
    }

    yield* fileSystem.makeDirectory(targetParent, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: targetParent,
            operation: "make-directory",
            cause,
          }),
      ),
    );
    const realTargetParent = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(targetParent),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: targetParent,
          operation: "realpath-target",
          cause,
        }),
    });
    yield* assertRealPathWithinWorkspace({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedWorkspaceRoot: realWorkspaceRoot,
      resolvedPath: realTargetParent,
    });

    const existingRealTarget = yield* realPathOrNull({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: target.absolutePath,
      operationPath: target.absolutePath,
    });
    const initialRealTargetPath =
      existingRealTarget ?? path.join(realTargetParent, path.basename(target.absolutePath));
    yield* assertRealPathWithinWorkspace({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedWorkspaceRoot: realWorkspaceRoot,
      resolvedPath: initialRealTargetPath,
    });

    const openTarget = Effect.fn("WorkspaceFileSystem.openWriteTarget")(function* (
      resolvedPath: string,
      flags: number,
    ) {
      return yield* Effect.tryPromise({
        try: () => NodeFSP.open(resolvedPath, flags),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath,
            operationPath: resolvedPath,
            operation: "open",
            cause,
          }),
      });
    });
    const noFollowFlag = NodeFS.constants.O_NOFOLLOW ?? 0;
    const openExistingFlags = NodeFS.constants.O_WRONLY | noFollowFlag;
    const openNewFlags =
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | noFollowFlag;
    const acquireWriteTarget = Effect.gen(function* () {
      if (existingRealTarget !== null) {
        const handle = yield* openTarget(initialRealTargetPath, openExistingFlags);
        return { handle, realTargetPath: initialRealTargetPath, truncate: true };
      }

      const createResult = yield* openTarget(initialRealTargetPath, openNewFlags).pipe(
        Effect.result,
      );
      if (createResult._tag === "Success") {
        return {
          handle: createResult.success,
          realTargetPath: initialRealTargetPath,
          truncate: false,
        };
      }
      if ((createResult.failure.cause as NodeJS.ErrnoException).code !== "EEXIST") {
        return yield* createResult.failure;
      }

      const appearedRealTarget = yield* realPathOrNull({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        operationPath: initialRealTargetPath,
      });
      if (appearedRealTarget === null) {
        return yield* createResult.failure;
      }
      yield* assertRealPathWithinWorkspace({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: appearedRealTarget,
      });
      const handle = yield* openTarget(appearedRealTarget, openExistingFlags);
      return { handle, realTargetPath: appearedRealTarget, truncate: true };
    });

    yield* Effect.acquireUseRelease(
      acquireWriteTarget,
      ({ handle, realTargetPath, truncate }) =>
        Effect.gen(function* () {
          if (truncate) {
            yield* Effect.tryPromise({
              try: () => handle.truncate(0),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "write-file",
                  cause,
                }),
            });
          }
          yield* Effect.tryPromise({
            try: () => handle.writeFile(input.contents, "utf8"),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "write-file",
                cause,
              }),
          });
        }),
      ({ handle, realTargetPath }) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);

export const __testing = { nextAncestorPath };
