import { Effect, FileSystem, Layer, Path } from "effect";
import { runWslShell } from "../../wsl/WslCli.ts";
import { isWslTarget } from "../../wsl/WslTarget.ts";
import { resolvePosixChild } from "../../wsl/WslPath.ts";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    if (isWslTarget(input.executionTarget)) {
      const absolutePath = resolvePosixChild(input.cwd, input.relativePath);
      if (!absolutePath) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.resolveWslPath",
          detail: "Path escapes workspace root.",
        });
      }
      const encodedContents = Buffer.from(input.contents, "utf8").toString("base64");
      const script = `node -e ${JSON.stringify(
        [
          "const fs=require('fs');const path=require('path');",
          "const target=process.argv[1];const encoded=process.argv[2];",
          "fs.mkdirSync(path.posix.dirname(target),{recursive:true});",
          "fs.writeFileSync(target,Buffer.from(encoded,'base64').toString('utf8'));",
        ].join(""),
      )} ${JSON.stringify(absolutePath)} ${JSON.stringify(encodedContents)}`;
      const result = yield* runWslShell(input.executionTarget, input.cwd, script, {
        timeoutMs: 10_000,
        operation: "workspaceFileSystem.writeFile",
      }).pipe(
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
      if (result.code !== 0) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFile",
          detail: result.stderr || "WSL write failed.",
        });
      }
      yield* workspaceEntries.invalidate(input.cwd);
      return { relativePath: input.relativePath.replaceAll("\\", "/") };
    }

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
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
