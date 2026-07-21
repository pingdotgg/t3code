// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { TestContext } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const createFileSymlinkOrSkip = Effect.fn("createFileSymlinkOrSkip")(function* (
  context: TestContext,
  targetPath: string,
  linkPath: string,
) {
  const cause = yield* Effect.promise(async () => {
    try {
      await NodeFSP.symlink(targetPath, linkPath, "file");
      return null;
    } catch (cause) {
      return cause;
    }
  });
  if (cause === null) {
    return true;
  }
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "ENOTSUP") {
    context.skip(`File symlinks are unavailable in this environment (${code})`);
    return false;
  }
  return yield* Effect.die(cause);
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", (context) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        if (
          !(yield* createFileSymlinkOrSkip(
            context,
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          ))
        ) {
          return;
        }

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "linked-secret.txt" })
          .pipe(Effect.flip);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-secret.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects directories without manufacturing an I/O cause", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "src" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(path.join(cwd, "src"));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "src",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );

    it.effect("preserves the real cause and path for I/O failures", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const resolvedPath = path.join(cwd, "missing.txt");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "missing.txt" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing.txt",
          resolvedPath,
          operationPath: resolvedPath,
          operation: "realpath-target",
        });
        expect(error.cause).toBeInstanceOf(Error);
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("terminates ancestor discovery at a filesystem root", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const currentAncestor = NodePath.parse(cwd).root;
        const resolvedPath = path.join(cwd, "missing", "file.txt");

        const error = yield* WorkspaceFileSystem.__testing
          .nextAncestorPath({
            path,
            workspaceRoot: cwd,
            relativePath: "missing/file.txt",
            resolvedPath,
            currentAncestor,
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "missing/file.txt",
          resolvedPath,
          operationPath: currentAncestor,
          operation: "realpath-target",
        });
        expect("cause" in error).toBe(false);
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("overwrites existing files within the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "plans/existing.md", "before\n");

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/existing.md",
          contents: "after\n",
        });
        const saved = yield* fileSystem.readFileString(path.join(cwd, "plans/existing.md"));

        expect(result).toEqual({ relativePath: "plans/existing.md" });
        expect(saved).toBe("after\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects writes through file symlinks outside the workspace root", (context) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const outsidePath = path.join(outsideDir, "outside.txt");
        yield* fileSystem.writeFileString(outsidePath, "outside\n");
        if (!(yield* createFileSymlinkOrSkip(context, outsidePath, path.join(cwd, "linked.txt")))) {
          return;
        }

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "linked.txt", contents: "overwritten\n" })
          .pipe(Effect.flip);
        const saved = yield* fileSystem.readFileString(outsidePath);
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(outsidePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect(saved).toBe("outside\n");
      }),
    );

    it.effect("rejects writes through dangling file symlinks", (context) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const outsidePath = path.join(outsideDir, "missing.txt");
        if (!(yield* createFileSymlinkOrSkip(context, outsidePath, path.join(cwd, "linked.txt")))) {
          return;
        }

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "linked.txt", contents: "outside\n" })
          .pipe(Effect.flip);
        const escapedStat = yield* fileSystem
          .stat(outsidePath)
          .pipe(Effect.orElseSucceed(() => null));

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked.txt",
          resolvedPath: path.join(cwd, "linked.txt"),
          operationPath: path.join(cwd, "linked.txt"),
          operation: "realpath-target",
        });
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("writes through file symlinks that stay within the workspace root", (context) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "actual.txt", "before\n");
        const linkPath = path.join(cwd, "linked.txt");
        if (!(yield* createFileSymlinkOrSkip(context, path.join(cwd, "actual.txt"), linkPath))) {
          return;
        }

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "linked.txt",
          contents: "after\n",
        });
        const saved = yield* fileSystem.readFileString(path.join(cwd, "actual.txt"));
        const linkStat = yield* Effect.tryPromise(() => NodeFSP.lstat(linkPath)).pipe(Effect.orDie);

        expect(saved).toBe("after\n");
        expect(linkStat.isSymbolicLink()).toBe(true);
      }),
    );

    it.effect("rejects writes through directory symlinks outside the workspace root", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const outsidePath = path.join(outsideDir, "nested", "created.txt");
        yield* Effect.tryPromise(() =>
          NodeFSP.symlink(
            outsideDir,
            path.join(cwd, "linked-dir"),
            platform === "win32" ? "junction" : "dir",
          ),
        ).pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked-dir/nested/created.txt",
            contents: "outside\n",
          })
          .pipe(Effect.flip);
        const escapedStat = yield* fileSystem
          .stat(outsidePath)
          .pipe(Effect.orElseSucceed(() => null));
        const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
        const resolvedPath = yield* fileSystem.realPath(outsideDir);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "linked-dir/nested/created.txt",
          resolvedWorkspaceRoot,
          resolvedPath,
        });
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("writes through directory symlinks that stay within the workspace root", () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const actualDir = path.join(cwd, "actual-dir");
        yield* fileSystem.makeDirectory(actualDir);
        yield* Effect.tryPromise(() =>
          NodeFSP.symlink(
            actualDir,
            path.join(cwd, "linked-dir"),
            platform === "win32" ? "junction" : "dir",
          ),
        ).pipe(Effect.orDie);

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "linked-dir/nested/created.txt",
          contents: "inside\n",
        });
        const saved = yield* fileSystem.readFileString(
          path.join(actualDir, "nested", "created.txt"),
        );

        expect(saved).toBe("inside\n");
      }),
    );
  });
});
