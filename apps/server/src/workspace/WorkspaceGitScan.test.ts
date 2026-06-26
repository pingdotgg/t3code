import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { WorkspaceGitScan, WorkspaceGitScanLive } from "./WorkspaceGitScan.ts";

const TestLayer = WorkspaceGitScanLive.pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // NOTE: unscoped on purpose. The previous `makeTempDirectoryScoped` was wrapped
  // in `Effect.scoped(makeTempDir())` at each call site, which closed the scope —
  // and deleted the directory — before the test body ran. Tests only passed when
  // their first op was a recursive mkdir that happened to recreate the dir.
  return yield* fileSystem.makeTempDirectory({
    prefix: "t3code-workspace-git-scan-",
  });
});

const mkdir = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(...segments);
  yield* fileSystem.makeDirectory(absolutePath, { recursive: true });
  return absolutePath;
});

const touch = Effect.fn(function* (...segments: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(...segments);
  yield* fileSystem.writeFileString(absolutePath, "");
  return absolutePath;
});

it.layer(TestLayer)("WorkspaceGitScanLive", (it) => {
  it.effect("detects sibling git repos and parent without .git", () =>
    Effect.gen(function* () {
      const scan = yield* WorkspaceGitScan;
      const parent = yield* Effect.scoped(makeTempDir());
      yield* mkdir(parent, "backend");
      yield* mkdir(parent, "backend", ".git");
      yield* mkdir(parent, "frontend");
      yield* mkdir(parent, "frontend", ".git");
      yield* mkdir(parent, "docs");

      const result = yield* scan.scan({ parentPath: parent });

      expect(result.parentHasGit).toBe(false);
      const names = result.children.map((child) => child.name).toSorted();
      expect(names).toEqual(["backend", "docs", "frontend"]);
      const withGit = result.children
        .filter((child) => child.hasGit)
        .map((c) => c.name)
        .toSorted();
      expect(withGit).toEqual(["backend", "frontend"]);
    }),
  );

  it.effect("reports parentHasGit when parent itself is a git repo", () =>
    Effect.gen(function* () {
      const scan = yield* WorkspaceGitScan;
      const parent = yield* Effect.scoped(makeTempDir());
      yield* mkdir(parent, ".git");
      yield* mkdir(parent, "src");

      const result = yield* scan.scan({ parentPath: parent });

      expect(result.parentHasGit).toBe(true);
      const childNames = result.children.map((c) => c.name);
      expect(childNames).not.toContain(".git");
      expect(childNames).toContain("src");
    }),
  );

  it.effect("treats .git files (worktree clones) as git markers", () =>
    Effect.gen(function* () {
      const scan = yield* WorkspaceGitScan;
      const parent = yield* Effect.scoped(makeTempDir());
      yield* mkdir(parent, "worktree-clone");
      yield* touch(parent, "worktree-clone", ".git");

      const result = yield* scan.scan({ parentPath: parent });

      const child = result.children.find((c) => c.name === "worktree-clone");
      expect(child?.hasGit).toBe(true);
    }),
  );

  it.effect("skips files in the parent directory", () =>
    Effect.gen(function* () {
      const scan = yield* WorkspaceGitScan;
      const parent = yield* Effect.scoped(makeTempDir());
      yield* touch(parent, "README.md");
      yield* mkdir(parent, "repo");
      yield* mkdir(parent, "repo", ".git");

      const result = yield* scan.scan({ parentPath: parent });

      const names = result.children.map((c) => c.name);
      expect(names).not.toContain("README.md");
      expect(names).toContain("repo");
    }),
  );
});
