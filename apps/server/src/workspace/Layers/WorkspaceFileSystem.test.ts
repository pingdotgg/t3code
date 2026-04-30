import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
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

const writeBinaryFile = Effect.fn("writeBinaryFile")(function* (
  cwd: string,
  relativePath: string,
  contents: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFile(absolutePath, contents).pipe(Effect.orDie);
});

const writeDirectorySymlink = Effect.fn("writeDirectorySymlink")(function* (
  cwd: string,
  relativePath: string,
  targetPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* Effect.promise(() =>
    fsPromises.symlink(targetPath, absolutePath, process.platform === "win32" ? "junction" : "dir"),
  ).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plans/effect-rpc.md", "# Plan\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects files that exceed the preview size limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "logs/huge.log", "x".repeat(512 * 1024 + 1));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "logs/huge.log",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for oversized preview.");
        }
        expect(error.detail).toContain("File is too large to preview");
      }),
    );

    it.effect("rejects binary files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "assets/logo.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "assets/logo.bin",
          })
          .pipe(Effect.flip);

        if (!("detail" in error)) {
          throw new Error("Expected WorkspaceFileSystemError detail for binary preview.");
        }
        expect(error.detail).toBe("Binary files cannot be previewed.");
      }),
    );

    it.effect("rejects symlinked paths that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(externalDir, "secret.txt"), "secret\n"),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/secret.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/secret.txt",
        );
      }),
    );

    it.effect("rejects escaped symlink reads without leaking missing-target metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/missing.txt",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/missing.txt",
        );
        expect(String(error)).not.toContain("ENOENT");
      }),
    );

    it.effect("rejects escaped symlink reads without leaking directory metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() =>
          fsPromises.mkdir(path.join(externalDir, "nested"), { recursive: true }),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/nested",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/nested",
        );
        if ("detail" in error) {
          expect(error.detail).not.toBe("Only regular files can be previewed.");
        }
      }),
    );

    it.effect("rejects escaped symlink reads without leaking file size metadata", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(externalDir, "huge.log"), "x".repeat(512 * 1024 + 1)),
        ).pipe(Effect.orDie);
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "linked/huge.log",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/huge.log",
        );
        if ("detail" in error) {
          expect(error.detail).not.toContain("File is too large to preview");
        }
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
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
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
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
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects symlinked write targets that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const externalDir = `${cwd}-outside`;
        yield* Effect.promise(() => fsPromises.mkdir(externalDir, { recursive: true })).pipe(
          Effect.orDie,
        );
        yield* writeDirectorySymlink(cwd, "linked", externalDir);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "linked/malicious.txt",
            contents: "escaped\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: linked/malicious.txt",
        );

        const escapedStat = yield* fileSystem
          .stat(path.join(externalDir, "malicious.txt"))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
