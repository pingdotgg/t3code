import { realpath as realpathPromise } from "node:fs/promises";

import { Data, Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePathOutsideRootError, WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_PREVIEW_MAX_BYTES = 512 * 1024;
const WORKSPACE_PREVIEW_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function isLikelyBinaryPreview(bytes: Uint8Array): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0);
}

function decodePreviewContents(bytes: Uint8Array): string | null {
  try {
    return WORKSPACE_PREVIEW_TEXT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

class MissingRealPathError extends Data.TaggedError("MissingRealPathError") {}

function isEnoentError(cause: unknown): cause is NodeJS.ErrnoException {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const toWorkspaceFileSystemError = (
    input: { cwd: string; relativePath: string },
    operation: string,
  ) => {
    return (cause: unknown) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
  };

  const resolveRealWorkspaceTargetPath = Effect.fn(
    "WorkspaceFileSystem.resolveRealWorkspaceTargetPath",
  )(function* (input: { cwd: string; relativePath: string }, absolutePath: string) {
    const missingSegments: Array<string> = [];
    let candidatePath = absolutePath;

    while (true) {
      const realCandidatePath = yield* Effect.tryPromise({
        try: () => realpathPromise(candidatePath),
        catch: (cause) =>
          isEnoentError(cause)
            ? new MissingRealPathError()
            : toWorkspaceFileSystemError(input, "workspaceFileSystem.realpath.target")(cause),
      }).pipe(Effect.catchTag("MissingRealPathError", () => Effect.succeed(null)));

      if (realCandidatePath !== null) {
        return missingSegments.length === 0
          ? realCandidatePath
          : path.join(realCandidatePath, ...missingSegments);
      }

      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.realpath.target",
          detail: `Unable to resolve workspace target path: ${absolutePath}`,
        });
      }

      missingSegments.unshift(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  });

  const ensureResolvedPathStaysWithinWorkspace = Effect.fn(
    "WorkspaceFileSystem.ensureResolvedPathStaysWithinWorkspace",
  )(function* (input: { cwd: string; relativePath: string }, absolutePath: string) {
    const normalizedWorkspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(
        Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.workspaceRoot")),
      );
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => realpathPromise(normalizedWorkspaceRoot),
      catch: toWorkspaceFileSystemError(input, "workspaceFileSystem.realpath.root"),
    });
    const realTargetPath = yield* resolveRealWorkspaceTargetPath(input, absolutePath);
    const relativeToRoot = toPosixPath(path.relative(realWorkspaceRoot, realTargetPath));
    if (
      relativeToRoot.length === 0 ||
      relativeToRoot === "." ||
      relativeToRoot.startsWith("../") ||
      relativeToRoot === ".." ||
      path.isAbsolute(relativeToRoot)
    ) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });

      yield* ensureResolvedPathStaysWithinWorkspace(input, target.absolutePath);

      const fileInfo = yield* fileSystem
        .stat(target.absolutePath)
        .pipe(
          Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.readFile.stat")),
        );
      if (fileInfo.type !== "File") {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.stat",
          detail: "Only regular files can be previewed.",
        });
      }

      const fileSize =
        typeof fileInfo.size === "bigint"
          ? Number(fileInfo.size)
          : typeof fileInfo.size === "number"
            ? fileInfo.size
            : 0;
      if (fileSize > WORKSPACE_PREVIEW_MAX_BYTES) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.sizeLimit",
          detail: `File is too large to preview (${fileSize} bytes). Limit is ${WORKSPACE_PREVIEW_MAX_BYTES} bytes.`,
        });
      }

      const bytes = yield* fileSystem
        .readFile(target.absolutePath)
        .pipe(
          Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.readFile.read")),
        );
      if (isLikelyBinaryPreview(bytes)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.binaryCheck",
          detail: "Binary files cannot be previewed.",
        });
      }

      const contents = decodePreviewContents(bytes);
      if (contents === null) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.decode",
          detail: "Only UTF-8 text files can be previewed.",
        });
      }

      return {
        relativePath: target.relativePath,
        contents,
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

    yield* ensureResolvedPathStaysWithinWorkspace(input, target.absolutePath);

    yield* fileSystem
      .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
      .pipe(
        Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.makeDirectory")),
      );
    yield* fileSystem
      .writeFileString(target.absolutePath, input.contents)
      .pipe(Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.writeFile")));
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
