import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { WorkspaceFile, WorkspaceFileLive } from "./WorkspaceFile.ts";

const TestLayer = WorkspaceFileLive.pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.fn(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // NOTE: unscoped on purpose — see WorkspaceGitScan.test.ts for the rationale.
  return yield* fileSystem.makeTempDirectory({ prefix });
});

const mkdir = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(...segments);
  yield* fileSystem.makeDirectory(absolutePath, { recursive: true });
  return absolutePath;
});

/** Create a directory and mark it as a git repo (`.git` directory). */
const gitRepo = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const absolutePath = yield* mkdir(...segments);
  yield* mkdir(path.join(absolutePath, ".git"));
  return absolutePath;
});

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

const readFile = Effect.fn(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(filePath);
});

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it.layer(TestLayer)("WorkspaceFileLive", (it) => {
  it.effect(
    "parses JSONC, resolves relative + absolute folders, and classifies git vs non-git",
    () =>
      Effect.gen(function* () {
        const workspaceFile = yield* WorkspaceFile;
        const path = yield* Path.Path;
        const base = yield* Effect.scoped(makeTempDir("t3code-workspace-file-"));

        const backend = yield* gitRepo(base, "backend");
        const frontend = yield* gitRepo(base, "frontend");
        yield* mkdir(base, "docs"); // non-git folder

        const wsPath = path.join(base, "my-feature.code-workspace");
        yield* writeFile(
          wsPath,
          `{
  // a feature spanning two repos plus a docs folder
  "folders": [
    { "path": "backend" },                       // relative to the file's dir
    { "path": "${frontend}", "name": "Web UI" }, // absolute
    { "path": "docs" },                          // non-git, trailing comma below
  ],
  "settings": { "editor.tabSize": 2 }
}`,
        );

        const resolved = yield* workspaceFile.read(wsPath);

        expect(resolved.anchorDir).toBe(base);
        expect(resolved.workspaceFilePath).toBe(wsPath);
        expect(resolved.folders.map((folder) => folder.name)).toEqual([
          "backend",
          "Web UI",
          "docs",
        ]);

        const backendFolder = resolved.folders[0];
        expect(backendFolder?.absolutePath).toBe(backend);
        expect(backendFolder?.exists).toBe(true);
        expect(backendFolder?.isGit).toBe(true);

        const docsFolder = resolved.folders[2];
        expect(docsFolder?.exists).toBe(true);
        expect(docsFolder?.isGit).toBe(false);

        // repoRoots = only the existing git folders, in file order.
        expect([...resolved.repoRoots]).toEqual([backend, frontend]);
      }),
  );

  it.effect("resolves cousin repos in unrelated directory trees", () =>
    Effect.gen(function* () {
      const workspaceFile = yield* WorkspaceFile;
      const path = yield* Path.Path;
      const anchorBase = yield* Effect.scoped(makeTempDir("t3code-workspace-file-anchor-"));
      const cousinBase = yield* Effect.scoped(makeTempDir("t3code-workspace-file-cousin-"));

      const local = yield* gitRepo(anchorBase, "service-a");
      const cousin = yield* gitRepo(cousinBase, "service-b");

      const wsPath = path.join(anchorBase, "cousins.code-workspace");
      yield* writeFile(
        wsPath,
        `{ "folders": [ { "path": "service-a" }, { "path": "${cousin}" } ] }`,
      );

      const resolved = yield* workspaceFile.read(wsPath);

      expect([...resolved.repoRoots]).toEqual([local, cousin]);
    }),
  );

  it.effect("surfaces missing/renamed folders without dropping or crashing", () =>
    Effect.gen(function* () {
      const workspaceFile = yield* WorkspaceFile;
      const path = yield* Path.Path;
      const base = yield* Effect.scoped(makeTempDir("t3code-workspace-file-missing-"));
      const present = yield* gitRepo(base, "present");

      const wsPath = path.join(base, "ws.code-workspace");
      yield* writeFile(wsPath, `{ "folders": [ { "path": "present" }, { "path": "ghost" } ] }`);

      const resolved = yield* workspaceFile.read(wsPath);

      expect(resolved.folders).toHaveLength(2);
      const ghost = resolved.folders[1];
      expect(ghost?.absolutePath).toBe(path.join(base, "ghost"));
      expect(ghost?.exists).toBe(false);
      expect(ghost?.isGit).toBe(false);
      // Missing folders never count toward repoRoots.
      expect([...resolved.repoRoots]).toEqual([present]);
    }),
  );

  it.effect("treats a missing folders[] key as an empty workspace", () =>
    Effect.gen(function* () {
      const workspaceFile = yield* WorkspaceFile;
      const path = yield* Path.Path;
      const base = yield* Effect.scoped(makeTempDir("t3code-workspace-file-empty-"));
      const wsPath = path.join(base, "empty.code-workspace");
      yield* writeFile(wsPath, `{ "settings": {} }`);

      const resolved = yield* workspaceFile.read(wsPath);

      expect(resolved.folders).toHaveLength(0);
      expect([...resolved.repoRoots]).toEqual([]);
    }),
  );

  it.effect("round-trips edits via withFolders + write, preserving unknown keys", () =>
    Effect.gen(function* () {
      const workspaceFile = yield* WorkspaceFile;
      const path = yield* Path.Path;
      const base = yield* Effect.scoped(makeTempDir("t3code-workspace-file-roundtrip-"));
      yield* gitRepo(base, "backend");
      yield* gitRepo(base, "added");

      const wsPath = path.join(base, "rt.code-workspace");
      yield* writeFile(
        wsPath,
        `{
  // keep me
  "folders": [ { "path": "backend" } ],
  "settings": { "editor.tabSize": 4 },
  "extensions": { "recommendations": ["dbaeumer.vscode-eslint"] }
}`,
      );

      const original = yield* workspaceFile.read(wsPath);
      const nextDocument = workspaceFile.withFolders(original.document, [
        { path: "backend" },
        { path: "added", name: "New Repo" },
      ]);
      yield* workspaceFile.write({ workspaceFilePath: wsPath, document: nextDocument });

      // Unknown top-level keys survive the round-trip.
      const rawAfter = parseJson(yield* readFile(wsPath)) as Record<string, unknown>;
      expect(rawAfter.settings).toEqual({ "editor.tabSize": 4 });
      expect(rawAfter.extensions).toEqual({ recommendations: ["dbaeumer.vscode-eslint"] });

      // Re-reading reflects the new folder set.
      const reread = yield* workspaceFile.read(wsPath);
      expect(reread.folders.map((folder) => folder.name)).toEqual(["backend", "New Repo"]);
      expect(reread.repoRoots).toHaveLength(2);
    }),
  );

  it.effect("fails with a WorkspaceFileError when the file does not exist", () =>
    Effect.gen(function* () {
      const workspaceFile = yield* WorkspaceFile;
      const path = yield* Path.Path;
      const base = yield* Effect.scoped(makeTempDir("t3code-workspace-file-notfound-"));

      const error = yield* workspaceFile
        .read(path.join(base, "nope.code-workspace"))
        .pipe(Effect.flip);

      expect(error._tag).toBe("WorkspaceFileError");
      expect(error.operation).toBe("WorkspaceFile.read:readFile");
    }),
  );
});
