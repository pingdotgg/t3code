import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  findWorktreeArtifactDirectories,
  isLinkedWorktreePath,
  removeWorktreeArtifacts,
} from "./worktreeArtifacts.ts";

const TestLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-worktree-artifacts-" });
});

const writeFile = Effect.fn("writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

const makeDir = Effect.fn("makeDir")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(cwd, relativePath), { recursive: true });
});

const runGit = Effect.fn("runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  yield* vcsProcess.run({
    operation: "worktreeArtifacts.test.runGit",
    command: "git",
    args,
    cwd,
  });
});

/**
 * A real repository whose default branch commits `.gitignore` entries, plus
 * a real linked worktree carrying regenerable artifacts.
 */
const makeRepoWithWorktree = Effect.fn("makeRepoWithWorktree")(function* (input: {
  readonly gitignore: string;
}) {
  const path = yield* Path.Path;
  const repo = yield* makeTempDir;
  const worktreeParent = yield* makeTempDir;
  const worktree = path.join(worktreeParent, "worktree");
  yield* runGit(repo, ["init", "--initial-branch=main"]);
  yield* runGit(repo, ["config", "user.email", "test@example.com"]);
  yield* runGit(repo, ["config", "user.name", "Test User"]);
  yield* writeFile(repo, ".gitignore", input.gitignore);
  yield* writeFile(repo, "README.md", "hello\n");
  yield* runGit(repo, ["add", "."]);
  yield* runGit(repo, ["commit", "-m", "init"]);
  yield* runGit(repo, ["worktree", "add", worktree, "-b", "artifact-cleanup-test"]);
  return { repo, worktree };
});

const relativeArtifacts = Effect.fn("relativeArtifacts")(function* (cwd: string) {
  const path = yield* Path.Path;
  const found = yield* findWorktreeArtifactDirectories(cwd);
  return found.map((absolute) => path.relative(cwd, absolute)).sort();
});

it.layer(TestLayer, { excludeTestServices: true })("worktreeArtifacts", (it) => {
  describe("findWorktreeArtifactDirectories", () => {
    it.effect("finds node_modules and framework caches at any depth", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;
          yield* makeDir(cwd, "node_modules/react");
          yield* makeDir(cwd, "apps/web/node_modules");
          yield* makeDir(cwd, "apps/web/.next");
          yield* makeDir(cwd, ".turbo");
          yield* writeFile(cwd, "apps/web/src/index.ts");

          expect(yield* relativeArtifacts(cwd)).toEqual([
            ".turbo",
            "apps/web/.next",
            "apps/web/node_modules",
            "node_modules",
          ]);
        }),
      ),
    );

    it.effect("only treats target as an artifact next to a Cargo.toml", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;
          yield* writeFile(cwd, "native/monitor/Cargo.toml");
          yield* makeDir(cwd, "native/monitor/target/debug");
          yield* makeDir(cwd, "src/target");

          expect(yield* relativeArtifacts(cwd)).toEqual(["native/monitor/target"]);
        }),
      ),
    );

    it.effect("ignores target when the Cargo.toml sibling is a directory", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;
          yield* makeDir(cwd, "pkg/Cargo.toml");
          yield* makeDir(cwd, "pkg/target");

          expect(yield* relativeArtifacts(cwd)).toEqual([]);
        }),
      ),
    );

    it.effect("does not descend into matched artifacts or .git", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;
          yield* makeDir(cwd, "node_modules/nested/node_modules");
          yield* makeDir(cwd, ".git/modules/node_modules");

          expect(yield* relativeArtifacts(cwd)).toEqual(["node_modules"]);
        }),
      ),
    );

    it.effect("does not follow symlinked directories out of the worktree", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          yield* makeDir(outside, "node_modules");
          yield* fileSystem.symlink(outside, path.join(cwd, "linked"));

          expect(yield* relativeArtifacts(cwd)).toEqual([]);
        }),
      ),
    );
  });

  describe("removeWorktreeArtifacts", () => {
    it.effect("removes git-verified regenerable artifacts and keeps source files", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { worktree } = yield* makeRepoWithWorktree({
            gitignore: "node_modules/\ntarget/\n",
          });
          yield* writeFile(worktree, "node_modules/pkg/index.js", "");
          yield* writeFile(worktree, "Cargo.toml", "[package]\n");
          yield* makeDir(worktree, "target/release");

          const result = yield* removeWorktreeArtifacts(worktree);

          expect(result.failed).toEqual([]);
          expect(result.skipped).toEqual([]);
          expect(result.removed.map((absolute) => path.basename(absolute)).sort()).toEqual([
            "node_modules",
            "target",
          ]);
          expect(yield* fileSystem.exists(path.join(worktree, "node_modules"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(worktree, "target"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(worktree, "README.md"))).toBe(true);
        }),
      ),
    );

    it.effect("skips artifact directories git does not verify as ignored", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { worktree } = yield* makeRepoWithWorktree({ gitignore: "" });
          yield* writeFile(worktree, "node_modules/pkg/index.js", "");

          const result = yield* removeWorktreeArtifacts(worktree);

          expect(result.removed).toEqual([]);
          expect(result.skipped.map((absolute) => path.basename(absolute))).toEqual([
            "node_modules",
          ]);
          expect(yield* fileSystem.exists(path.join(worktree, "node_modules"))).toBe(true);
        }),
      ),
    );

    it.effect("skips everything outside a git checkout", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* makeDir(cwd, "node_modules/pkg");

          const result = yield* removeWorktreeArtifacts(cwd);

          expect(result.removed).toEqual([]);
          expect(result.skipped.map((absolute) => path.basename(absolute))).toEqual([
            "node_modules",
          ]);
          expect(yield* fileSystem.exists(path.join(cwd, "node_modules"))).toBe(true);
        }),
      ),
    );
  });

  describe("isLinkedWorktreePath", () => {
    it.effect("recognizes a real linked worktree", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { repo, worktree } = yield* makeRepoWithWorktree({ gitignore: "" });

          expect(yield* isLinkedWorktreePath(worktree)).toBe(true);
          expect(yield* isLinkedWorktreePath(repo)).toBe(false);
        }),
      ),
    );

    it.effect("rejects a directory borrowing another worktree's .git pointer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { worktree } = yield* makeRepoWithWorktree({ gitignore: "" });
          const impostor = yield* makeTempDir;
          const pointer = yield* fileSystem.readFileString(path.join(worktree, ".git"));
          yield* fileSystem.writeFileString(path.join(impostor, ".git"), pointer);

          expect(yield* isLinkedWorktreePath(impostor)).toBe(false);
        }),
      ),
    );

    it.effect("rejects a separate-git-dir primary checkout", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const gitDir = yield* makeTempDir;
          yield* writeFile(gitDir, "HEAD", "ref: refs/heads/main\n");
          const cwd = yield* makeTempDir;
          yield* writeFile(cwd, ".git", `gitdir: ${path.join(gitDir)}\n`);

          expect(yield* isLinkedWorktreePath(cwd)).toBe(false);
        }),
      ),
    );

    it.effect("rejects a malformed .git pointer file", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;
          yield* writeFile(cwd, ".git", "not a pointer\n");

          expect(yield* isLinkedWorktreePath(cwd)).toBe(false);
        }),
      ),
    );

    it.effect("rejects a directory without any .git entry", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDir;

          expect(yield* isLinkedWorktreePath(cwd)).toBe(false);
        }),
      ),
    );
  });
});
