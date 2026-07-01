/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const PROJECT_READ_FILE_MAX_SIZE = FileSystem.Size(PROJECT_READ_FILE_MAX_BYTES);

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
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

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

  const operationError =
    (
      input: ProjectReadFileInput | ProjectWriteFileInput,
      resolvedPath: string,
      operationPath: string,
      operation: WorkspaceFileSystemOperationError["operation"],
    ) =>
    (cause: unknown) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath,
        operationPath,
        operation,
        cause,
      });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* fileSystem
      .realPath(input.cwd)
      .pipe(
        Effect.mapError(
          operationError(input, target.absolutePath, input.cwd, "realpath-workspace-root"),
        ),
      );
    const realTargetPath = yield* fileSystem
      .realPath(target.absolutePath)
      .pipe(
        Effect.mapError(
          operationError(input, target.absolutePath, target.absolutePath, "realpath-target"),
        ),
      );
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem
          .open(realTargetPath, { flag: "r" })
          .pipe(Effect.mapError(operationError(input, realTargetPath, realTargetPath, "open")));
        const stat = yield* file.stat.pipe(
          Effect.mapError(operationError(input, realTargetPath, realTargetPath, "stat")),
        );
        if (stat.type !== "File") {
          return yield* new WorkspacePathNotFileError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
          });
        }

        const bytesToRead =
          stat.size > PROJECT_READ_FILE_MAX_SIZE ? PROJECT_READ_FILE_MAX_BYTES : Number(stat.size);
        const fileBytes =
          bytesToRead === 0
            ? new Uint8Array()
            : yield* file
                .readAlloc(bytesToRead)
                .pipe(
                  Effect.map(Option.getOrElse(() => new Uint8Array())),
                  Effect.mapError(operationError(input, realTargetPath, realTargetPath, "read")),
                );
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
          byteLength: Number(stat.size),
          truncated: stat.size > PROJECT_READ_FILE_MAX_SIZE,
        };
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

    yield* fileSystem
      .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
      .pipe(
        Effect.mapError(
          operationError(
            input,
            target.absolutePath,
            path.dirname(target.absolutePath),
            "make-directory",
          ),
        ),
      );
    yield* fileSystem
      .writeFileString(target.absolutePath, input.contents)
      .pipe(
        Effect.mapError(
          operationError(input, target.absolutePath, target.absolutePath, "write-file"),
        ),
      );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
