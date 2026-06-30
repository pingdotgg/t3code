// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
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
import * as Stream from "effect/Stream";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

/** Hard cap on entries returned by listFilesRecursive, so a pathological tree
 *  cannot force an unbounded walk over this read path. */
const MAX_RECURSIVE_LIST_ENTRIES = 500;

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

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
      "read-file-string",
      "read-file-string-capped",
      "list-files",
      "list-files-recursive",
      "create-file-exclusive",
      "delete-file",
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
     * Read a file relative to the workspace root.
     *
     * Rejects paths that escape the workspace root.
     */
    readonly readFileString: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Effect.Effect<
      string,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;

    /**
     * Read AT MOST `maxBytes` bytes of a file (UTF-8 decoded), without loading
     * the whole file into memory. Use this when only a bounded preview is needed
     * (e.g. truncated ticket-artifact display) so an arbitrarily large file
     * cannot force a full-memory read over an RPC. Optional: callers MUST fall
     * back to `readFileString` when this is absent (some lightweight mocks omit
     * it).
     */
    readonly readFileStringCapped?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly maxBytes: number;
    }) => Effect.Effect<
      string,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;

    /**
     * List the regular files directly inside a directory relative to the
     * workspace root (sorted by name). A missing directory lists as empty.
     */
    readonly listFiles: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Effect.Effect<
      ReadonlyArray<string>,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;

    /**
     * Recursively list the regular files under a directory relative to the
     * workspace root, returning paths relative to that directory (e.g.
     * `design/SPEC.md`), sorted. Symlinked entries that resolve outside the
     * workspace are skipped. Optional — callers should fall back to the flat
     * {@link listFiles} when a lightweight implementation omits it.
     */
    readonly listFilesRecursive?: (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly maxEntries?: number;
    }) => Effect.Effect<
      ReadonlyArray<string>,
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

    /**
     * Create a file relative to the workspace root, failing if it already
     * exists.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly createFileExclusive: (input: {
      readonly projectRoot: string;
      readonly relativePath: string;
      readonly contents: string;
    }) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;

    /**
     * Delete a file relative to the workspace root.
     *
     * Rejects paths that escape the workspace root. Missing files are treated
     * as already deleted so callers can retry safely.
     */
    readonly deleteFile: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Effect.Effect<void, WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError>;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  const containsRealPath = (realRoot: string, realTarget: string) => {
    const relative = path.relative(realRoot, realTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const isNotFoundError = (cause: unknown): boolean => {
    if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
      return false;
    }
    const reason = (cause as { readonly reason?: unknown }).reason;
    return (
      typeof reason === "object" &&
      reason !== null &&
      "_tag" in reason &&
      (reason as { readonly _tag?: unknown })._tag === "NotFound"
    );
  };

  const makeOperationError = (
    input: { readonly cwd: string; readonly relativePath: string },
    operation: WorkspaceFileSystemOperationError["operation"],
    resolvedPath: string,
    operationPath: string,
    cause: unknown,
  ) =>
    new WorkspaceFileSystemOperationError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath,
      operationPath,
      operation,
      cause,
    });

  const makeEscapeError = (
    input: { readonly cwd: string; readonly relativePath: string },
    resolvedWorkspaceRoot: string,
    resolvedPath: string,
  ) =>
    new WorkspaceFilePathEscapeError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedWorkspaceRoot,
      resolvedPath,
    });

  /**
   * Get the real (symlink-resolved) workspace root path. Fails with
   * WorkspaceFileSystemOperationError if it cannot be resolved.
   */
  const resolveRealWorkspaceRoot = (
    input: { readonly cwd: string; readonly relativePath: string },
    operation: WorkspaceFileSystemOperationError["operation"],
  ) =>
    fileSystem.realPath(input.cwd).pipe(
      Effect.mapError((cause) =>
        makeOperationError(input, operation, input.cwd, input.cwd, cause),
      ),
    );

  /**
   * Resolve a real path for an existing target and verify it is contained
   * within the workspace root. Returns the real target path.
   */
  const existingRealTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: WorkspaceFileSystemOperationError["operation"],
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* resolveRealWorkspaceRoot(input, operation);
      const realTarget = yield* fileSystem.realPath(absolutePath).pipe(
        Effect.mapError((cause) =>
          makeOperationError(input, operation, absolutePath, absolutePath, cause),
        ),
      );
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realRoot,
          resolvedPath: realTarget,
        });
      }
      return realTarget;
    });

  /**
   * Resolve a real path for a writable target (which may not exist yet) and
   * verify it is contained within the workspace root. Returns the real target
   * path.
   */
  const writableRealTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: WorkspaceFileSystemOperationError["operation"],
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* resolveRealWorkspaceRoot(input, operation);
      const targetDirectory = path.dirname(absolutePath);
      const realParent = yield* fileSystem.realPath(targetDirectory).pipe(
        Effect.mapError((cause) =>
          makeOperationError(input, operation, absolutePath, targetDirectory, cause),
        ),
      );
      if (!containsRealPath(realRoot, realParent)) {
        return yield* makeEscapeError(input, realRoot, realParent);
      }

      const realTarget = yield* fileSystem
        .realPath(absolutePath)
        .pipe(Effect.orElseSucceed(() => path.resolve(realParent, path.basename(absolutePath))));
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* makeEscapeError(input, realRoot, realTarget);
      }
      return realTarget;
    });

  /**
   * Check whether a target is safe to delete — it exists within the workspace,
   * or it doesn't exist at all. Returns true if deletion should proceed, false
   * if the file does not exist (skip the unlink).
   */
  const deletableTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: WorkspaceFileSystemOperationError["operation"],
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* resolveRealWorkspaceRoot(input, operation);
      const symlinkTarget = yield* fileSystem
        .readLink(absolutePath)
        .pipe(Effect.orElseSucceed(() => null));

      if (symlinkTarget !== null) {
        const targetDirectory = path.dirname(absolutePath);
        const realParent = yield* fileSystem.realPath(targetDirectory).pipe(
          Effect.mapError((cause) =>
            makeOperationError(input, operation, absolutePath, targetDirectory, cause),
          ),
        );
        if (!containsRealPath(realRoot, realParent)) {
          return yield* makeEscapeError(input, realRoot, realParent);
        }

        const absoluteLinkTarget = path.isAbsolute(symlinkTarget)
          ? symlinkTarget
          : path.resolve(targetDirectory, symlinkTarget);
        const logicalRoot = path.resolve(input.cwd);
        const logicalTarget = path.resolve(absoluteLinkTarget);
        if (
          !containsRealPath(logicalRoot, logicalTarget) &&
          !containsRealPath(realRoot, logicalTarget)
        ) {
          return yield* makeEscapeError(input, realRoot, logicalTarget);
        }

        const realTarget = yield* fileSystem
          .realPath(absoluteLinkTarget)
          .pipe(Effect.orElseSucceed(() => null));
        if (realTarget !== null && !containsRealPath(realRoot, realTarget)) {
          return yield* makeEscapeError(input, realRoot, realTarget);
        }
        return true;
      }

      const targetExists = yield* fileSystem.stat(absolutePath).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          isNotFoundError(cause)
            ? Effect.succeed(false)
            : Effect.fail(
                makeOperationError(input, operation, absolutePath, absolutePath, cause),
              ),
        ),
      );
      if (!targetExists) {
        return false;
      }

      const realTarget = yield* fileSystem.realPath(absolutePath).pipe(
        Effect.mapError((cause) =>
          makeOperationError(input, operation, absolutePath, absolutePath, cause),
        ),
      );
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* makeEscapeError(input, realRoot, realTarget);
      }
      return true;
    });

  // ---------------------------------------------------------------------------
  // Service methods
  // ---------------------------------------------------------------------------

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

  const readFileString: WorkspaceFileSystem["Service"]["readFileString"] = Effect.fn(
    "WorkspaceFileSystem.readFileString",
  )(function* (input) {
    const operation = "read-file-string" as const;
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realTarget = yield* existingRealTargetWithinWorkspace(
      input,
      target.absolutePath,
      operation,
    );

    return yield* fileSystem.readFileString(realTarget).pipe(
      Effect.mapError((cause) =>
        makeOperationError(input, operation, realTarget, realTarget, cause),
      ),
    );
  });

  const readFileStringCapped: NonNullable<WorkspaceFileSystem["Service"]["readFileStringCapped"]> =
    Effect.fn("WorkspaceFileSystem.readFileStringCapped")(function* (input) {
      const operation = "read-file-string-capped" as const;
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const realTarget = yield* existingRealTargetWithinWorkspace(
        input,
        target.absolutePath,
        operation,
      );
      // Stream at most maxBytes off disk and decode — never materialise the whole
      // file in memory just to truncate it.
      return yield* fileSystem
        .stream(realTarget, { bytesToRead: input.maxBytes })
        .pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.mapError((cause) =>
            makeOperationError(input, operation, realTarget, realTarget, cause),
          ),
        );
    });

  const listFiles: WorkspaceFileSystem["Service"]["listFiles"] = Effect.fn(
    "WorkspaceFileSystem.listFiles",
  )(function* (input) {
    const operation = "list-files" as const;
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const exists = yield* fileSystem.exists(target.absolutePath).pipe(
      Effect.mapError((cause) =>
        makeOperationError(input, operation, target.absolutePath, target.absolutePath, cause),
      ),
    );
    if (!exists) {
      return [];
    }
    const realTarget = yield* existingRealTargetWithinWorkspace(
      input,
      target.absolutePath,
      operation,
    );
    const entries = yield* fileSystem.readDirectory(realTarget).pipe(
      Effect.mapError((cause) =>
        makeOperationError(input, operation, realTarget, realTarget, cause),
      ),
    );
    const files: string[] = [];
    for (const entry of entries) {
      const info = yield* fileSystem
        .stat(path.join(realTarget, entry))
        .pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "File") {
        files.push(entry);
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  });

  const listFilesRecursive: NonNullable<WorkspaceFileSystem["Service"]["listFilesRecursive"]> =
    Effect.fn("WorkspaceFileSystem.listFilesRecursive")(function* (input) {
      const operation = "list-files-recursive" as const;
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const exists = yield* fileSystem.exists(target.absolutePath).pipe(
        Effect.mapError((cause) =>
          makeOperationError(input, operation, target.absolutePath, target.absolutePath, cause),
        ),
      );
      if (!exists) {
        return [];
      }
      const realRoot = yield* resolveRealWorkspaceRoot(input, operation);
      const realTarget = yield* existingRealTargetWithinWorkspace(
        input,
        target.absolutePath,
        operation,
      );
      const limit = input.maxEntries ?? MAX_RECURSIVE_LIST_ENTRIES;
      const results: string[] = [];
      const walk = (
        relDir: string,
        absDir: string,
      ): Effect.Effect<void, WorkspaceFileSystemOperationError | WorkspaceFilePathEscapeError> =>
        Effect.gen(function* () {
          const entries = yield* fileSystem.readDirectory(absDir).pipe(
            Effect.mapError((cause) =>
              makeOperationError(input, operation, absDir, absDir, cause),
            ),
          );
          for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
            if (results.length >= limit) {
              return;
            }
            const absEntry = path.join(absDir, entry);
            // Resolve symlinks and skip anything that escapes the workspace, so a
            // symlinked scratch entry can't leak file names from outside the worktree.
            const realEntry = yield* fileSystem
              .realPath(absEntry)
              .pipe(Effect.orElseSucceed(() => null));
            if (realEntry === null || !containsRealPath(realRoot, realEntry)) {
              continue;
            }
            const info = yield* fileSystem.stat(absEntry).pipe(Effect.orElseSucceed(() => null));
            const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
            if (info?.type === "File") {
              results.push(relPath);
            } else if (info?.type === "Directory") {
              yield* walk(relPath, absEntry);
            }
          }
        });
      yield* walk("", realTarget);
      return results.sort((left, right) => left.localeCompare(right));
    });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* writableRealTargetWithinWorkspace(input, target.absolutePath, "write-file");
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createFileExclusive: WorkspaceFileSystem["Service"]["createFileExclusive"] = Effect.fn(
    "WorkspaceFileSystem.createFileExclusive",
  )(function* (input) {
    const operation = "create-file-exclusive" as const;
    const fileInput = { cwd: input.projectRoot, relativePath: input.relativePath };
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.projectRoot,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.projectRoot,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* writableRealTargetWithinWorkspace(fileInput, target.absolutePath, operation);
    yield* fileSystem.writeFileString(target.absolutePath, input.contents, { flag: "wx" }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.projectRoot,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "create-file-exclusive",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.projectRoot);
    return { relativePath: target.relativePath };
  });

  const deleteFile: WorkspaceFileSystem["Service"]["deleteFile"] = Effect.fn(
    "WorkspaceFileSystem.deleteFile",
  )(function* (input) {
    const operation = "delete-file" as const;
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const exists = yield* deletableTargetWithinWorkspace(input, target.absolutePath, operation);
    if (!exists) {
      return;
    }

    yield* fileSystem.remove(target.absolutePath, { force: true }).pipe(
      Effect.mapError((cause) =>
        makeOperationError(input, operation, target.absolutePath, target.absolutePath, cause),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
  });

  return WorkspaceFileSystem.of({
    readFile,
    readFileString,
    readFileStringCapped,
    listFiles,
    listFilesRecursive,
    writeFile,
    createFileExclusive,
    deleteFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
