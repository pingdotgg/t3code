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
import { WorkspacePathOutsideRootError, WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_PREVIEW_MAX_BYTES = 1024 * 1024;
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

  const ensureReadTargetWithinRealRoot = Effect.fn(
    "WorkspaceFileSystem.ensureReadTargetWithinRealRoot",
  )(function* (input: { cwd: string; relativePath: string; absolutePath: string }) {
    const realWorkspaceRoot = yield* fileSystem
      .realPath(input.cwd)
      .pipe(
        Effect.mapError(toWorkspaceFileSystemError(input, "workspaceFileSystem.readFile.realRoot")),
      );
    const realTargetPath = yield* fileSystem
      .realPath(input.absolutePath)
      .pipe(
        Effect.mapError(
          toWorkspaceFileSystemError(input, "workspaceFileSystem.readFile.realTarget"),
        ),
      );
    const relativeToRealRoot = path
      .relative(realWorkspaceRoot, realTargetPath)
      .replaceAll("\\", "/");
    if (
      relativeToRealRoot.length === 0 ||
      relativeToRealRoot === "." ||
      relativeToRealRoot.startsWith("../") ||
      relativeToRealRoot === ".." ||
      path.isAbsolute(relativeToRealRoot)
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
      yield* ensureReadTargetWithinRealRoot({ ...input, absolutePath: target.absolutePath });

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
  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
