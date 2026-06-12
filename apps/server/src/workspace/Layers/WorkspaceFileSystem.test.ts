// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as fsPromises from "node:fs/promises";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
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
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
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

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads text files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const value = 1;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const value = 1;\n",
          truncated: false,
          sizeBytes: "export const value = 1;\n".length,
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

    it.effect("rejects binary files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFile(path.join(cwd, "image.bin"), Uint8Array.from([1, 0, 2]));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "image.bin",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileSystemError");
        if (error._tag === "WorkspaceFileSystemError") {
          expect(error.detail).toContain("Workspace file appears to be binary.");
        }
      }),
    );

    it.effect("reads valid symlinks inside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "target.md", "linked file\n");
        yield* Effect.promise(() => fsPromises.symlink("target.md", path.join(cwd, "LINK.md")));

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "LINK.md",
        });

        expect(result).toEqual({
          relativePath: "LINK.md",
          contents: "linked file\n",
          truncated: false,
          sizeBytes: "linked file\n".length,
        });
      }),
    );

    it.effect("reports broken symlinks with a workspace-specific error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* Effect.promise(() => fsPromises.symlink("missing.md", path.join(cwd, "BROKEN.md")));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "BROKEN.md",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: expect.stringContaining(
            'Workspace file is a broken symlink: BROKEN.md -> "missing.md"',
          ),
        });
      }),
    );

    it.effect("preserves broken symlink target whitespace in the error message", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "AGENTS.md", "agent instructions\n");
        yield* Effect.promise(() =>
          fsPromises.symlink("AGENTS.md\n\n", path.join(cwd, "CLAUDE.md")),
        );

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "CLAUDE.md",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: expect.stringContaining(
            'Workspace file is a broken symlink: CLAUDE.md -> "AGENTS.md\\n\\n"',
          ),
        });
      }),
    );

    it.effect("rejects symlinks that resolve outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const outsideCwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* writeTextFile(outsideCwd, "outside.md", "outside\n");
        const outsidePath = path.join(outsideCwd, "outside.md");
        yield* Effect.promise(() => fsPromises.symlink(outsidePath, path.join(cwd, "OUTSIDE.md")));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "OUTSIDE.md",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: expect.stringContaining(
            "Workspace symlink target must stay within the project root",
          ),
        });
      }),
    );

    it.effect("rejects symlinks that point to directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(cwd, "docs"), { recursive: true });
        yield* Effect.promise(() => fsPromises.symlink("docs", path.join(cwd, "DOCS.md")));

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "DOCS.md",
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          detail: expect.stringContaining(
            'Workspace symlink target is not a file: DOCS.md -> "docs"',
          ),
        });
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
  });

  describe("deleteEntry", () => {
    it.effect("deletes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "notes/remove-me.md", "delete me\n");

        const result = yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "notes/remove-me.md",
        });
        const deletedStat = yield* fileSystem
          .stat(path.join(cwd, "notes", "remove-me.md"))
          .pipe(Effect.catch(() => Effect.succeed(null)));

        expect(result).toEqual({ relativePath: "notes/remove-me.md" });
        expect(deletedStat).toBeNull();
      }),
    );

    it.effect("deletes empty directories relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(cwd, "empty-folder"), { recursive: true });

        const result = yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "empty-folder",
        });
        const deletedStat = yield* fileSystem
          .stat(path.join(cwd, "empty-folder"))
          .pipe(Effect.catch(() => Effect.succeed(null)));

        expect(result).toEqual({ relativePath: "empty-folder" });
        expect(deletedStat).toBeNull();
      }),
    );

    it.effect("invalidates workspace entry search cache after deletes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "plans/delete-rpc.md", "# Delete\n");

        const beforeDelete = yield* workspaceEntries.search({
          cwd,
          query: "delete-rpc",
          limit: 10,
        });
        expect(beforeDelete.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/delete-rpc.md" })]),
        );

        yield* workspaceFileSystem.deleteEntry({
          cwd,
          relativePath: "plans/delete-rpc.md",
        });

        const afterDelete = yield* workspaceEntries.search({
          cwd,
          query: "delete-rpc",
          limit: 10,
        });
        expect(afterDelete).toEqual({
          entries: [],
          truncated: false,
        });
      }),
    );

    it.effect("rejects non-empty directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(cwd, "src"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(cwd, "src", "index.ts"), "export {};\n");

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "src",
          })
          .pipe(Effect.flip);
        const childStat = yield* fileSystem.stat(path.join(cwd, "src", "index.ts"));

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemError",
          operation: "workspaceFileSystem.rmdir",
        });
        expect(childStat.type).toBe("File");
      }),
    );

    it.effect("rejects deletes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .deleteEntry({
            cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});
