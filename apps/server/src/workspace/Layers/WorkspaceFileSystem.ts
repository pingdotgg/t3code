import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";

import { Effect, Layer, Path } from "effect";
import {
  PROJECT_TEXT_FILE_MAX_BYTES,
  ProjectFileBinaryError,
  ProjectFileNotFoundError,
  ProjectFileTooLargeError,
  ProjectFileVersionConflictError,
  ProjectReadFileError,
  ProjectWriteFileError,
} from "@forma/contracts";

import {
  WorkspaceFileSystem,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isBinaryFile(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return true;
  }

  try {
    textDecoder.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function formatCauseMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
}

function hasNodeErrorCode(cause: unknown, code: string): cause is { code: string } {
  return cause !== null && typeof cause === "object" && "code" in cause && cause.code === code;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      const stat = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) => {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
            return new ProjectFileNotFoundError({
              message: `Workspace file not found: ${target.relativePath}`,
              relativePath: target.relativePath,
              cause,
            });
          }
          return new ProjectReadFileError({
            message: `Failed to read workspace file: ${formatCauseMessage(cause)}`,
            cause,
          });
        },
      });

      if (!stat.isFile()) {
        return yield* new ProjectReadFileError({
          message: `Workspace path is not a file: ${target.relativePath}`,
        });
      }

      if (stat.size > PROJECT_TEXT_FILE_MAX_BYTES) {
        return yield* new ProjectFileTooLargeError({
          message: `Workspace file exceeds ${PROJECT_TEXT_FILE_MAX_BYTES} bytes: ${target.relativePath}`,
          relativePath: target.relativePath,
          sizeBytes: stat.size,
          maxBytes: PROJECT_TEXT_FILE_MAX_BYTES,
        });
      }

      const bytes = yield* Effect.tryPromise({
        try: () => fsPromises.readFile(target.absolutePath),
        catch: (cause) =>
          new ProjectReadFileError({
            message: `Failed to read workspace file: ${formatCauseMessage(cause)}`,
            cause,
          }),
      });
      if (bytes.length > PROJECT_TEXT_FILE_MAX_BYTES) {
        return yield* new ProjectFileTooLargeError({
          message: `Workspace file exceeds ${PROJECT_TEXT_FILE_MAX_BYTES} bytes: ${target.relativePath}`,
          relativePath: target.relativePath,
          sizeBytes: bytes.length,
          maxBytes: PROJECT_TEXT_FILE_MAX_BYTES,
        });
      }
      if (isBinaryFile(bytes)) {
        return yield* new ProjectFileBinaryError({
          message: `Workspace file is not a UTF-8 text file: ${target.relativePath}`,
          relativePath: target.relativePath,
        });
      }

      return {
        relativePath: target.relativePath,
        contents: textDecoder.decode(bytes),
        version: hashBytes(bytes),
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

    const readExistingStat = () =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await fsPromises.stat(target.absolutePath);
          } catch (cause) {
            if (hasNodeErrorCode(cause, "ENOENT")) {
              return null;
            }
            throw cause;
          }
        },
        catch: (cause) =>
          new ProjectWriteFileError({
            message: `Failed to validate workspace file before write: ${formatCauseMessage(cause)}`,
            cause,
          }),
      });

    const readCurrentBytesForWrite = () =>
      Effect.tryPromise({
        try: () => fsPromises.readFile(target.absolutePath),
        catch: (cause) =>
          new ProjectWriteFileError({
            message: `Failed to validate workspace file before write: ${formatCauseMessage(cause)}`,
            cause,
          }),
      });

    if ("expectedVersion" in input) {
      const existingStat = yield* readExistingStat();

      if (input.expectedVersion === null) {
        if (existingStat !== null) {
          const actualVersion = existingStat.isFile()
            ? yield* Effect.promise(async () => {
                try {
                  const currentBytes = await fsPromises.readFile(target.absolutePath);
                  return hashBytes(currentBytes);
                } catch {
                  return null;
                }
              })
            : null;

          return yield* new ProjectFileVersionConflictError({
            message: `Workspace file already exists: ${target.relativePath}`,
            relativePath: target.relativePath,
            expectedVersion: null,
            actualVersion,
          });
        }
      } else if (typeof input.expectedVersion === "string") {
        if (existingStat === null || !existingStat.isFile()) {
          return yield* new ProjectFileVersionConflictError({
            message: `Workspace file changed on disk: ${target.relativePath}`,
            relativePath: target.relativePath,
            expectedVersion: input.expectedVersion,
            actualVersion: null,
          });
        }

        const currentBytes = yield* readCurrentBytesForWrite();
        const actualVersion = hashBytes(currentBytes);
        if (actualVersion !== input.expectedVersion) {
          return yield* new ProjectFileVersionConflictError({
            message: `Workspace file changed on disk: ${target.relativePath}`,
            relativePath: target.relativePath,
            expectedVersion: input.expectedVersion,
            actualVersion,
          });
        }
      }
    }

    yield* Effect.tryPromise({
      try: () => fsPromises.mkdir(path.dirname(target.absolutePath), { recursive: true }),
      catch: (cause) =>
        new ProjectWriteFileError({
          message: `Failed to create parent directories for workspace file: ${formatCauseMessage(cause)}`,
          cause,
        }),
    });
    yield* Effect.tryPromise({
      try: () => fsPromises.writeFile(target.absolutePath, input.contents, "utf8"),
      catch: (cause) =>
        new ProjectWriteFileError({
          message: `Failed to write workspace file: ${formatCauseMessage(cause)}`,
          cause,
        }),
    });
    yield* workspaceEntries.invalidate(input.cwd);

    return {
      relativePath: target.relativePath,
      version: hashBytes(textEncoder.encode(input.contents)),
    };
  });

  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
