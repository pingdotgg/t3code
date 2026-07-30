// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import {
  ProjectCreateDirectoryError,
  ProjectDeleteEntryError,
  ProjectFileVersionConflictError,
  ProjectRenameEntryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceProtectedPaths from "./WorkspaceProtectedPaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const FILE_HASH_CHUNK_BYTES = 64 * 1024;

async function hashOpenFile(handle: NodeFSP.FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function hashString(contents: string): string {
  return createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex");
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === code
  );
}

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

/**
 * Raised when a file operation targets a path under a protected filesystem
 * location while the Forma "Protected paths" safety setting is enabled.
 */
export class WorkspaceProtectedPathError extends Schema.TaggedErrorClass<WorkspaceProtectedPathError>()(
  "WorkspaceProtectedPathError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is protected by Forma safety settings.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceProtectedPathError,
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
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | ProjectFileVersionConflictError
    >;
    readonly createDirectory: (
      input: ProjectCreateDirectoryInput,
    ) => Effect.Effect<
      ProjectCreateDirectoryResult,
      ProjectCreateDirectoryError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<
      ProjectRenameEntryResult,
      ProjectRenameEntryError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      ProjectDeleteEntryError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const protectedPaths = yield* WorkspaceProtectedPaths.makeProtectedPathsGuard;

  const failIfTargetBlocked = Effect.fn("WorkspaceFileSystem.failIfTargetBlocked")(function* (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
  ) {
    if (yield* protectedPaths.isPathBlocked(absolutePath)) {
      return yield* new WorkspaceProtectedPathError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: absolutePath,
      });
    }
  });

  /**
   * Resolve the real (symlink-free) path of a target, verify it stays inside
   * the workspace root, and re-check protected-path blocking on the resolved
   * location. Mirrors the readFile containment checks for destructive
   * operations (rename/delete) where a symlink escape has a large blast radius.
   */
  const resolveRealTargetWithinRoot = Effect.fn("WorkspaceFileSystem.resolveRealTargetWithinRoot")(
    function* (
      input: { readonly cwd: string; readonly relativePath: string },
      absolutePath: string,
    ) {
      const realWorkspaceRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.cwd),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: input.cwd,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
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
      yield* failIfTargetBlocked(input, realTargetPath);
      return realTargetPath;
    },
  );

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    yield* failIfTargetBlocked(input, target.absolutePath);

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
    // Re-check after symlink resolution so links inside the workspace cannot
    // escape into protected locations.
    yield* failIfTargetBlocked(input, realTargetPath);

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
            version: yield* Effect.tryPromise({
              try: () => hashOpenFile(handle),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "read",
                  cause,
                }),
            }),
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
    yield* failIfTargetBlocked(input, target.absolutePath);

    if ("expectedVersion" in input) {
      const currentBytes = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.readFile(target.absolutePath);
          } catch (cause) {
            if (hasNodeErrorCode(cause, "ENOENT")) return null;
            throw cause;
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "read",
            cause,
          }),
      });
      const actualVersion =
        currentBytes === null ? null : createHash("sha256").update(currentBytes).digest("hex");
      if (input.expectedVersion !== actualVersion) {
        return yield* new ProjectFileVersionConflictError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          expectedVersion: input.expectedVersion ?? null,
          actualVersion,
          message:
            input.expectedVersion === null
              ? `Workspace file already exists: ${target.relativePath}`
              : `Workspace file changed on disk: ${target.relativePath}`,
        });
      }
    }

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
    return {
      relativePath: target.relativePath,
      version: hashString(input.contents),
    };
  });

  const createDirectory: WorkspaceFileSystem["Service"]["createDirectory"] = Effect.fn(
    "WorkspaceFileSystem.createDirectory",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    yield* failIfTargetBlocked(input, target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectCreateDirectoryError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            message: cause.message,
            cause,
          }),
      ),
    );
    if (target.relativePath === "." || target.relativePath.length === 0) {
      return yield* new ProjectCreateDirectoryError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        message: "The workspace root cannot be created as a child entry.",
      });
    }

    yield* Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.stat(target.absolutePath);
          throw new Error("entry-exists");
        } catch (cause) {
          if (hasNodeErrorCode(cause, "ENOENT")) return;
          throw cause;
        }
      },
      catch: (cause) =>
        new ProjectCreateDirectoryError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          message:
            cause instanceof Error && cause.message === "entry-exists"
              ? `Workspace path already exists: ${target.relativePath}`
              : `Failed to create workspace directory: ${String(cause)}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(target.absolutePath, { recursive: true }),
      catch: (cause) =>
        new ProjectCreateDirectoryError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          message: `Failed to create workspace directory: ${String(cause)}`,
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.fromRelativePath,
    });
    const destination = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.toRelativePath,
    });
    yield* failIfTargetBlocked(
      { cwd: input.cwd, relativePath: input.fromRelativePath },
      source.absolutePath,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectRenameEntryError({
            cwd: input.cwd,
            fromRelativePath: source.relativePath,
            toRelativePath: destination.relativePath,
            message: cause.message,
            cause,
          }),
      ),
    );
    yield* failIfTargetBlocked(
      { cwd: input.cwd, relativePath: input.toRelativePath },
      destination.absolutePath,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectRenameEntryError({
            cwd: input.cwd,
            fromRelativePath: source.relativePath,
            toRelativePath: destination.relativePath,
            message: cause.message,
            cause,
          }),
      ),
    );
    if (
      source.relativePath === destination.relativePath ||
      source.relativePath === "." ||
      destination.relativePath === "."
    ) {
      return yield* new ProjectRenameEntryError({
        cwd: input.cwd,
        fromRelativePath: source.relativePath,
        toRelativePath: destination.relativePath,
        message: "The workspace root cannot be renamed.",
      });
    }

    const sourceStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(source.absolutePath),
      catch: (cause) =>
        new ProjectRenameEntryError({
          cwd: input.cwd,
          fromRelativePath: source.relativePath,
          toRelativePath: destination.relativePath,
          message: `Failed to inspect workspace path before rename: ${String(cause)}`,
          cause,
        }),
    });
    const mapRenameGuardError = (cause: { readonly message: string }) =>
      new ProjectRenameEntryError({
        cwd: input.cwd,
        fromRelativePath: source.relativePath,
        toRelativePath: destination.relativePath,
        message: cause.message,
        cause,
      });
    // Symlink-escape re-check + protected re-check on the resolved source.
    const realSourcePath = yield* resolveRealTargetWithinRoot(
      { cwd: input.cwd, relativePath: input.fromRelativePath },
      source.absolutePath,
    ).pipe(Effect.mapError(mapRenameGuardError));
    // Renaming an unprotected ancestor must not relocate protected locations
    // nested underneath it.
    if (sourceStat.isDirectory() && (yield* protectedPaths.hasBlockedDescendants(realSourcePath))) {
      return yield* new ProjectRenameEntryError({
        cwd: input.cwd,
        fromRelativePath: source.relativePath,
        toRelativePath: destination.relativePath,
        message: `Workspace path contains protected locations and cannot be renamed: ${source.relativePath}`,
      });
    }
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.stat(destination.absolutePath);
          throw new Error("entry-exists");
        } catch (cause) {
          if (hasNodeErrorCode(cause, "ENOENT")) return;
          throw cause;
        }
      },
      catch: (cause) =>
        new ProjectRenameEntryError({
          cwd: input.cwd,
          fromRelativePath: source.relativePath,
          toRelativePath: destination.relativePath,
          message:
            cause instanceof Error && cause.message === "entry-exists"
              ? `Workspace path already exists: ${destination.relativePath}`
              : `Failed to validate workspace rename target: ${String(cause)}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(path.dirname(destination.absolutePath), { recursive: true }),
      catch: (cause) =>
        new ProjectRenameEntryError({
          cwd: input.cwd,
          fromRelativePath: source.relativePath,
          toRelativePath: destination.relativePath,
          message: `Failed to create rename target parent: ${String(cause)}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(source.absolutePath, destination.absolutePath),
      catch: (cause) =>
        new ProjectRenameEntryError({
          cwd: input.cwd,
          fromRelativePath: source.relativePath,
          toRelativePath: destination.relativePath,
          message: `Failed to rename workspace path: ${String(cause)}`,
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return {
      fromRelativePath: source.relativePath,
      toRelativePath: destination.relativePath,
      kind: sourceStat.isDirectory() ? "directory" : "file",
    };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    if (target.relativePath === "." || target.relativePath.length === 0) {
      return yield* new ProjectDeleteEntryError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        message: "The workspace root cannot be deleted.",
      });
    }
    yield* failIfTargetBlocked(input, target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectDeleteEntryError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            message: cause.message,
            cause,
          }),
      ),
    );
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(target.absolutePath),
      catch: (cause) =>
        new ProjectDeleteEntryError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          message: `Failed to inspect workspace path before delete: ${String(cause)}`,
          cause,
        }),
    });
    if (stat.isDirectory() && !input.recursive) {
      return yield* new ProjectDeleteEntryError({
        cwd: input.cwd,
        relativePath: target.relativePath,
        message: `Workspace directory delete requires recursive=true: ${target.relativePath}`,
      });
    }
    // Symlink-escape re-check + protected re-check on the resolved location.
    const realTargetPath = yield* resolveRealTargetWithinRoot(input, target.absolutePath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectDeleteEntryError({
            cwd: input.cwd,
            relativePath: target.relativePath,
            message: cause.message,
            cause,
          }),
      ),
    );
    // Recursive delete of an unprotected ancestor must not wipe protected
    // locations nested underneath it (e.g. a workspace above the home dir).
    if (stat.isDirectory() && (yield* protectedPaths.hasBlockedDescendants(realTargetPath))) {
      return yield* new ProjectDeleteEntryError({
        cwd: input.cwd,
        relativePath: target.relativePath,
        message: `Workspace path contains protected locations and cannot be deleted: ${target.relativePath}`,
      });
    }
    yield* Effect.tryPromise({
      try: () =>
        NodeFSP.rm(target.absolutePath, {
          recursive: stat.isDirectory(),
          force: false,
        }),
      catch: (cause) =>
        new ProjectDeleteEntryError({
          cwd: input.cwd,
          relativePath: target.relativePath,
          message: `Failed to delete workspace path: ${String(cause)}`,
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: target.relativePath,
      kind: stat.isDirectory() ? "directory" : "file",
    };
  });

  return WorkspaceFileSystem.of({
    readFile,
    writeFile,
    createDirectory,
    renameEntry,
    deleteEntry,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
