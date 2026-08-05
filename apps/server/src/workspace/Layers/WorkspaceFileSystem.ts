import { open, stat } from "node:fs/promises";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

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
  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.normalizeWorkspaceRoot",
              detail: cause.message,
              cause,
            }),
        ),
      );
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot,
        relativePath: input.relativePath,
      });
      let currentPath = workspaceRoot;
      for (const segment of target.relativePath.split("/")) {
        currentPath = path.join(currentPath, segment);
        const isSymbolicLink = yield* fileSystem.readLink(currentPath).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (isSymbolicLink) {
          return yield* new WorkspaceFileSystemError({
            cwd: workspaceRoot,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: "Workspace file path cannot traverse symbolic links",
          });
        }
      }
      const fileBytes = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => open(target.absolutePath, "r"),
          catch: (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.readFile",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }),
        (file) =>
          Effect.tryPromise({
            try: async () => {
              const buffer = Buffer.allocUnsafe(WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1);
              const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
              return buffer.subarray(0, bytesRead);
            },
            catch: (cause) =>
              new WorkspaceFileSystemError({
                cwd: input.cwd,
                relativePath: input.relativePath,
                operation: "workspaceFileSystem.readFile",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        (file) => Effect.promise(() => file.close()),
      );
      const truncated = fileBytes.byteLength > WORKSPACE_FILE_PREVIEW_MAX_BYTES;
      const byteLength = yield* Effect.tryPromise({
        try: async () => (await stat(target.absolutePath)).size,
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.stat",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const contents = new TextDecoder().decode(
        truncated ? fileBytes.subarray(0, WORKSPACE_FILE_PREVIEW_MAX_BYTES) : fileBytes,
      );
      return { relativePath: target.relativePath, contents, byteLength, truncated };
    },
  );
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
