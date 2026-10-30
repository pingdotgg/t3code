import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspacePaths from "./WorkspacePaths.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
  });
});

it.layer(layerTest)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
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
