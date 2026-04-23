import { createHash } from "node:crypto";

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
import { PROJECT_TEXT_FILE_MAX_BYTES } from "@harness/contracts";

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
      prefix: "harness-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "harness-workspace-files-",
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

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads text files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/editor.ts", "export const editor = true;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/editor.ts",
        });

        expect(result).toEqual({
          relativePath: "src/editor.ts",
          contents: "export const editor = true;\n",
          version: sha256("export const editor = true;\n"),
        });
      }),
    );

    it.effect("rejects missing files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "src/missing.ts",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProjectFileNotFoundError");
      }),
    );

    it.effect("rejects binary files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem
          .makeDirectory(path.join(cwd, "assets"), { recursive: true })
          .pipe(Effect.orDie);
        yield* fileSystem
          .writeFile(path.join(cwd, "assets", "logo.bin"), Uint8Array.from([0, 1, 2, 3]))
          .pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "assets/logo.bin",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProjectFileBinaryError");
      }),
    );

    it.effect("rejects oversized files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const oversized = "a".repeat(PROJECT_TEXT_FILE_MAX_BYTES + 1);
        yield* writeTextFile(cwd, "src/huge.ts", oversized);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "src/huge.ts",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProjectFileTooLargeError");
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

        expect(result).toEqual({
          relativePath: "plans/effect-rpc.md",
          version: sha256("# Plan\n"),
        });
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

    it.effect("guards writes with a matching version token", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/editor.ts", "export const v = 1;\n");

        const existing = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/editor.ts",
        });
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "src/editor.ts",
          contents: "export const v = 2;\n",
          expectedVersion: existing.version,
        });

        expect(result).toEqual({
          relativePath: "src/editor.ts",
          version: sha256("export const v = 2;\n"),
        });
      }),
    );

    it.effect("rejects stale version-token writes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/editor.ts", "export const v = 1;\n");

        const existing = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/editor.ts",
        });
        yield* writeTextFile(cwd, "src/editor.ts", "export const v = 3;\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "src/editor.ts",
            contents: "export const v = 2;\n",
            expectedVersion: existing.version,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProjectFileVersionConflictError");
        if (error._tag !== "ProjectFileVersionConflictError") {
          throw new Error(`Unexpected error tag: ${error._tag}`);
        }
        expect(error.actualVersion).toBe(sha256("export const v = 3;\n"));
      }),
    );

    it.effect("rejects create-only writes when the file already exists", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/new-file.ts", "export const v = 1;\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "src/new-file.ts",
            contents: "export const v = 2;\n",
            expectedVersion: null,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProjectFileVersionConflictError");
        if (error._tag !== "ProjectFileVersionConflictError") {
          throw new Error(`Unexpected error tag: ${error._tag}`);
        }
        expect(error.expectedVersion).toBeNull();
      }),
    );
  });
});
