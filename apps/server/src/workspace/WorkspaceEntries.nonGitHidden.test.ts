// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-non-git-hidden-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-non-git-hidden-",
  });
});

function writeTextFile(cwd: string, relativePath: string, contents = "") {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

it.layer(TestLayer, { excludeTestServices: true })("non-Git workspace dot entries", (it) => {
  describe("list", () => {
    it.effect("includes unignored dot entries", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".hidden-dir/inside.txt");
        yield* writeTextFile(cwd, ".hidden-file.txt");
        yield* writeTextFile(cwd, "visible-dir/inside.txt");
        yield* writeTextFile(cwd, "visible.txt");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: ".hidden-dir", kind: "directory" },
            { path: ".hidden-dir/inside.txt", kind: "file" },
            { path: ".hidden-file.txt", kind: "file" },
            { path: "visible-dir", kind: "directory" },
            { path: "visible-dir/inside.txt", kind: "file" },
            { path: "visible.txt", kind: "file" },
          ]),
        );
      }),
    );

    it.effect("does not bypass ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".gitignore", ".secret\n");
        yield* writeTextFile(cwd, ".secret");
        yield* writeTextFile(cwd, "visible.txt");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("visible.txt");
        expect(paths).not.toContain(".secret");
      }),
    );
  });
});
