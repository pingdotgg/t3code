// @effect-diagnostics nodeBuiltinImport:off
import fsPromises from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 512 * 1024;

function hasBinaryNullByte(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function formatSymlinkTarget(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
}

function isPathOutsideRoot(path: Path.Path, workspaceRoot: string, absolutePath: string): boolean {
  const relativeToRoot = path.relative(path.resolve(workspaceRoot), absolutePath);
  return (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  );
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const initialStat = yield* Effect.tryPromise({
        try: () => fsPromises.lstat(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.lstat",
            detail: `Workspace file does not exist: ${input.relativePath}`,
            cause,
          }),
      });

      let readAbsolutePath = target.absolutePath;
      let stat = initialStat;

      if (initialStat.isSymbolicLink()) {
        const linkTarget = yield* Effect.tryPromise({
          try: () => fsPromises.readlink(target.absolutePath),
          catch: (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readlink",
              detail: `Unable to read workspace symlink: ${input.relativePath}`,
              cause,
            }),
        });
        const resolvedLinkTarget = path.resolve(path.dirname(target.absolutePath), linkTarget);
        if (isPathOutsideRoot(path, input.cwd, resolvedLinkTarget)) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.stat",
            detail: `Workspace symlink target must stay within the project root: ${input.relativePath} -> ${formatSymlinkTarget(linkTarget)}`,
          });
        }

        stat = yield* Effect.tryPromise({
          try: () => fsPromises.stat(resolvedLinkTarget),
          catch: (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.stat",
              detail: `Workspace file is a broken symlink: ${input.relativePath} -> ${formatSymlinkTarget(linkTarget)}`,
              cause,
            }),
        });

        if (!stat.isFile()) {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: `Workspace symlink target is not a file: ${input.relativePath} -> ${formatSymlinkTarget(linkTarget)}`,
          });
        }

        readAbsolutePath = resolvedLinkTarget;
      }

      if (!stat.isFile()) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Workspace path is not a file.",
        });
      }

      const sizeBytes = Number(stat.size);
      const readBytes = Math.min(sizeBytes, PROJECT_READ_FILE_MAX_BYTES);
      const bytes = yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(readAbsolutePath, "r");
          try {
            const buffer = Buffer.alloc(readBytes);
            const { bytesRead } = await handle.read(buffer, 0, readBytes, 0);
            return buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: cause instanceof Error ? cause.message : "Failed to read workspace file.",
            cause,
          }),
      });

      if (hasBinaryNullByte(bytes)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Workspace file appears to be binary.",
        });
      }

      return {
        relativePath: target.relativePath,
        contents: new TextDecoder("utf-8").decode(bytes),
        truncated: sizeBytes > PROJECT_READ_FILE_MAX_BYTES,
        sizeBytes,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const deleteEntry: WorkspaceFileSystemShape["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const stat = yield* Effect.tryPromise({
      try: () => fsPromises.lstat(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.lstat",
          detail: `Workspace file does not exist: ${input.relativePath}`,
          cause,
        }),
    });

    if (stat.isDirectory()) {
      yield* Effect.tryPromise({
        try: () => fsPromises.rmdir(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.rmdir",
            detail:
              cause instanceof Error ? cause.message : "Failed to delete workspace directory.",
            cause,
          }),
      });
      yield* workspaceEntries.invalidate(input.cwd);
      return { relativePath: target.relativePath };
    }

    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.deleteEntry",
        detail: "Workspace path is not a file or directory.",
      });
    }

    yield* Effect.tryPromise({
      try: () => fsPromises.unlink(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.unlink",
          detail: cause instanceof Error ? cause.message : "Failed to delete workspace file.",
          cause,
        }),
    });

    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  return { readFile, writeFile, deleteEntry } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
