import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspaceContext from "./WorkspaceContext.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceContext.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-context-",
  });
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceContext", (it) => {
  describe("initialize", () => {
    it.effect("creates the workspace context directory and standard markdown files", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceContext.initialize({ workspaceRoot: cwd });

        expect(result.relativePath).toBe(".context");
        const directoryStat = yield* fileSystem.stat(path.join(cwd, ".context"));
        expect(directoryStat.type).toBe("Directory");
        for (const fileName of WorkspaceContext.STANDARD_CONTEXT_MARKDOWN_FILES) {
          const contents = yield* fileSystem.readFileString(path.join(cwd, ".context", fileName));
          expect(contents).toBe("");
        }
      }),
    );

    it.effect("adds .context/ to .gitignore once without overwriting existing entries", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const gitignorePath = path.join(cwd, ".gitignore");
        yield* fileSystem.writeFileString(gitignorePath, "node_modules/\n");

        yield* workspaceContext.initialize({ workspaceRoot: cwd });
        yield* workspaceContext.initialize({ workspaceRoot: cwd });

        const gitignore = yield* fileSystem.readFileString(gitignorePath);
        expect(gitignore).toBe("node_modules/\n.context/\n");
      }),
    );

    it.effect("preserves existing context markdown contents", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(cwd, ".context"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(cwd, ".context", "brief.md"), "Existing\n");

        yield* workspaceContext.initialize({ workspaceRoot: cwd });

        const contents = yield* fileSystem.readFileString(path.join(cwd, ".context", "brief.md"));
        expect(contents).toBe("Existing\n");
      }),
    );
  });

  describe("readMarkdownFile and writeMarkdownFile", () => {
    it.effect("writes context markdown files atomically and reads them back", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const cwd = yield* makeTempDir;

        const written = yield* workspaceContext.writeMarkdownFile({
          workspaceRoot: cwd,
          relativePath: "plan.md",
          contents: "# Plan\n",
        });
        const read = yield* workspaceContext.readMarkdownFile({
          workspaceRoot: cwd,
          relativePath: "plan.md",
        });

        expect(written.relativePath).toBe(".context/plan.md");
        expect(read).toEqual({
          relativePath: ".context/plan.md",
          contents: "# Plan\n",
        });
      }),
    );

    it.effect("rejects context paths that escape the .context directory", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceContext
          .writeMarkdownFile({
            workspaceRoot: cwd,
            relativePath: "../README.md",
            contents: "nope\n",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceContext.WorkspaceContextPathError);
        expect(error.message).toContain("Workspace context path must stay inside .context/");
      }),
    );

    it.effect("rejects non-markdown context files", () =>
      Effect.gen(function* () {
        const workspaceContext = yield* WorkspaceContext.WorkspaceContext;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceContext
          .writeMarkdownFile({
            workspaceRoot: cwd,
            relativePath: "artifact.json",
            contents: "{}\n",
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspaceContext.WorkspaceContextPathError);
        expect(error.message).toContain("Workspace context path must target a markdown file");
      }),
    );
  });
});
