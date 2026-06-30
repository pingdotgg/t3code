import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
        yield* fileSystem.symlink(
          path.join(outsideDir, "secret.txt"),
          path.join(cwd, "linked-secret.txt"),
        );

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

    it.effect(
      "rejects board file writes when the board path is a symlink outside the workspace",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const outsidePath = path.join(outsideDir, "outside-board.json");
          const boardPath = path.join(cwd, ".t3/boards/foo.json");

          yield* fileSystem.makeDirectory(path.dirname(boardPath), { recursive: true });
          yield* fileSystem.writeFileString(outsidePath, '{"name":"outside-before"}\n');
          yield* fileSystem.symlink(outsidePath, boardPath);

          const error = yield* workspaceFileSystem
            .writeFile({
              cwd,
              relativePath: ".t3/boards/foo.json",
              contents: '{"name":"outside-after"}\n',
            })
            .pipe(Effect.flip);

          expect(error._tag).toBe("WorkspaceFilePathEscapeError");
          const outside = yield* fileSystem.readFileString(outsidePath);
          expect(outside).toBe('{"name":"outside-before"}\n');
        }),
    );

    it.effect("writes normal board files under the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: ".t3/boards/foo.json",
          contents: '{"name":"inside"}\n',
        });

        const saved = yield* fileSystem.readFileString(path.join(cwd, ".t3/boards/foo.json"));
        expect(saved).toBe('{"name":"inside"}\n');
      }),
    );

    it.effect("createFileExclusive creates once and rejects an existing file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const created = yield* workspaceFileSystem.createFileExclusive({
          projectRoot: cwd,
          relativePath: ".t3/boards/workflow-board.json",
          contents: "{}\n",
        });
        expect(created).toEqual({ relativePath: ".t3/boards/workflow-board.json" });

        const error = yield* workspaceFileSystem
          .createFileExclusive({
            projectRoot: cwd,
            relativePath: ".t3/boards/workflow-board.json",
            contents: '{"overwritten":true}\n',
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceFileSystemOperationError");
        if (error._tag === "WorkspaceFileSystemOperationError") {
          expect(error.operation).toBe("create-file-exclusive");
        }

        const saved = yield* fileSystem.readFileString(
          path.join(cwd, ".t3/boards/workflow-board.json"),
        );
        expect(saved).toBe("{}\n");
      }),
    );
  });

  describe("listFilesRecursive", () => {
    it.effect("lists nested files as paths relative to the directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".t3/ticket/t1/DESCRIPTION.md", "# desc\n");
        yield* writeTextFile(cwd, ".t3/ticket/t1/handoff/review.md", "review\n");
        yield* writeTextFile(cwd, ".t3/ticket/t1/design/SPEC.md", "spec\n");
        yield* writeTextFile(cwd, ".t3/ticket/t1/design/PLAN.md", "plan\n");

        const names = yield* workspaceFileSystem.listFilesRecursive!({
          cwd,
          relativePath: ".t3/ticket/t1",
        });

        expect([...names].sort()).toEqual([
          "DESCRIPTION.md",
          "design/PLAN.md",
          "design/SPEC.md",
          "handoff/review.md",
        ]);
      }),
    );

    it.effect("returns an empty list for a missing directory", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const names = yield* workspaceFileSystem.listFilesRecursive!({
          cwd,
          relativePath: ".t3/ticket/missing",
        });
        expect([...names]).toEqual([]);
      }),
    );
  });

  describe("deleteFile", () => {
    it.effect("deletes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const boardPath = path.join(cwd, ".t3/boards/delete-me.json");

        yield* writeTextFile(cwd, ".t3/boards/delete-me.json", "{}\n");
        yield* workspaceFileSystem.deleteFile({
          cwd,
          relativePath: ".t3/boards/delete-me.json",
        });

        const stat = yield* fileSystem.stat(boardPath).pipe(Effect.orElseSucceed(() => null));
        expect(stat).toBeNull();
      }),
    );

    it.effect("treats missing files as successful deletes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        yield* workspaceFileSystem.deleteFile({
          cwd,
          relativePath: ".t3/boards/already-gone.json",
        });
      }),
    );

    it.effect("rejects deletes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteFile({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect(
      "rejects board file deletes when the board path is a symlink outside the workspace",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const outsidePath = path.join(outsideDir, "outside-board.json");
          const boardPath = path.join(cwd, ".t3/boards/foo.json");

          yield* fileSystem.makeDirectory(path.dirname(boardPath), { recursive: true });
          yield* fileSystem.writeFileString(outsidePath, '{"name":"outside"}\n');
          yield* fileSystem.symlink(outsidePath, boardPath);

          const error = yield* workspaceFileSystem
            .deleteFile({
              cwd,
              relativePath: ".t3/boards/foo.json",
            })
            .pipe(Effect.flip);

          expect(error._tag).toBe("WorkspaceFilePathEscapeError");
          const outside = yield* fileSystem.readFileString(outsidePath);
          expect(outside).toBe('{"name":"outside"}\n');
          const symlinkTarget = yield* fileSystem.readFileString(boardPath);
          expect(symlinkTarget).toBe('{"name":"outside"}\n');
        }),
    );

    it.effect("deletes dangling symlinks whose entries are inside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const boardPath = path.join(cwd, ".t3/boards/dangling.json");
        const missingTarget = path.join(cwd, ".t3/boards/missing-target.json");

        yield* fileSystem.makeDirectory(path.dirname(boardPath), { recursive: true });
        yield* fileSystem.symlink(missingTarget, boardPath);

        yield* workspaceFileSystem.deleteFile({
          cwd,
          relativePath: ".t3/boards/dangling.json",
        });

        const linkTarget = yield* fileSystem
          .readLink(boardPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(linkTarget).toBeNull();
      }),
    );

    it.effect("deletes in-workspace symlink loops by unlinking the entry", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const boardPath = path.join(cwd, ".t3/boards/loop.json");

        yield* fileSystem.makeDirectory(path.dirname(boardPath), { recursive: true });
        yield* fileSystem.symlink(boardPath, boardPath);

        yield* workspaceFileSystem.deleteFile({
          cwd,
          relativePath: ".t3/boards/loop.json",
        });

        const symlinkTarget = yield* fileSystem
          .readLink(boardPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(symlinkTarget).toBeNull();
      }),
    );
  });
});
