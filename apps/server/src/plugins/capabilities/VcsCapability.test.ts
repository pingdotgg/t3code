// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointRef, GitCommandError, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ServerConfig from "../../config.ts";
import { makePluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";
import { makeVcsCapability, PluginVcsPathError } from "./VcsCapability.ts";

const ServerConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "plugin-vcs-capability-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const TestLayer = Layer.mergeAll(GitVcsDriver.layer, CheckpointStore.layer).pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "plugin-vcs-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "VcsCapability.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["checkout", "-b", "main"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

it.layer(TestLayer)("VcsCapability", (it) => {
  describe("git operations", () => {
    it.effect("creates, lists, and removes worktrees with absolute path validation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          const worktreeParent = yield* makeTmpDir("plugin-vcs-worktree-parent-");
          const worktreePath = NodePath.join(worktreeParent, "worktree");
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const grants = yield* makePluginWorkspaceGrants;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore, grants });

          const rejected = yield* Effect.exit(vcs.status({ worktreePath: "relative/path" }));
          expect(rejected._tag).toBe("Failure");
          if (rejected._tag === "Failure") {
            expect(String(rejected.cause)).toContain(PluginVcsPathError.name);
          }

          const created = yield* vcs.createWorktree({
            repoRoot: repo,
            ref: "HEAD",
            path: worktreePath,
            newBranch: "feature/worktree",
          });
          expect(created.worktree.path).toBe(worktreePath);
          expect([...(yield* grants.snapshot())]).toContain(worktreePath);

          const listed = yield* vcs.listWorktrees({ repoRoot: repo });
          const fileSystem = yield* FileSystem.FileSystem;
          const canonicalWorktreePath = yield* fileSystem.realPath(worktreePath);
          const canonicalListedPaths = yield* Effect.forEach(listed.worktrees, (worktree) =>
            fileSystem.realPath(worktree.path),
          );
          expect(canonicalListedPaths.includes(canonicalWorktreePath)).toBe(true);

          yield* vcs.removeWorktree({ repoRoot: repo, path: worktreePath, force: true });
          expect([...(yield* grants.snapshot())]).not.toContain(worktreePath);
          const afterRemove = yield* vcs.listWorktrees({ repoRoot: repo });
          const canonicalAfterRemovePaths = yield* Effect.forEach(
            afterRemove.worktrees,
            (worktree) => fileSystem.realPath(worktree.path),
          );
          expect(canonicalAfterRemovePaths.includes(canonicalWorktreePath)).toBe(false);
        }),
      ),
    );

    it.effect("creates branches, stages and commits, reads diffs, and pushes when configured", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          const remote = yield* makeTmpDir("plugin-vcs-remote-");
          yield* initRepoWithCommit(repo);
          yield* git(remote, ["init", "--bare"]);
          yield* git(repo, ["remote", "add", "origin", remote]);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          yield* vcs.createBranch({ worktreePath: repo, branch: "feature/commit", switch: true });
          yield* writeTextFile(NodePath.join(repo, "README.md"), "# changed\n");
          yield* writeTextFile(NodePath.join(repo, "feature.txt"), "feature\n");
          const workingDiff = yield* vcs.workingTreeDiff({ worktreePath: repo });
          expect(workingDiff.diff).toContain("README.md");

          const commit = yield* vcs.commit({
            worktreePath: repo,
            subject: "Add feature",
            body: "",
          });
          expect(commit.status).toBe("created");
          if (commit.status === "created") {
            expect(commit.commitSha.length).toBeGreaterThan(6);
          }

          const range = yield* vcs.diffRefs({ worktreePath: repo, fromRef: "main", toRef: "HEAD" });
          expect(range.diff).toContain("feature.txt");

          const push = yield* vcs.push({ worktreePath: repo, remoteName: "origin" });
          expect(push.status).toBe("pushed");
        }),
      ),
    );

    it.effect("removes, cleans, reads refs, current branch, and arbitrary ahead counts", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });
          const fileSystem = yield* FileSystem.FileSystem;

          yield* writeTextFile(NodePath.join(repo, "tracked.txt"), "tracked\n");
          yield* git(repo, ["add", "tracked.txt"]);
          yield* git(repo, ["commit", "-m", "add tracked"]);
          yield* vcs.removePath({ worktreePath: repo, path: "tracked.txt" });
          expect(yield* fileSystem.exists(NodePath.join(repo, "tracked.txt"))).toBe(false);
          expect(yield* git(repo, ["status", "--porcelain"])).toContain("D  tracked.txt");
          yield* git(repo, ["reset", "--hard", "HEAD"]);

          yield* fileSystem.makeDirectory(NodePath.join(repo, "scratch"), { recursive: true });
          yield* writeTextFile(NodePath.join(repo, "scratch", "untracked.txt"), "scratch\n");
          yield* vcs.clean({ worktreePath: repo, path: "scratch" });
          expect(yield* fileSystem.exists(NodePath.join(repo, "scratch"))).toBe(false);

          expect(yield* vcs.currentBranch({ worktreePath: repo })).toBe("main");
          yield* vcs.createBranch({ worktreePath: repo, branch: "feature/ahead", switch: true });
          yield* writeTextFile(NodePath.join(repo, "ahead.txt"), "ahead\n");
          yield* vcs.commit({ worktreePath: repo, subject: "ahead", body: "" });
          expect(
            yield* vcs.aheadCount({
              worktreePath: repo,
              base: "main",
              head: "feature/ahead",
            }),
          ).toBe(1);

          const refs = yield* vcs.listRefs({ repoRoot: repo });
          const canonicalRepo = yield* fileSystem.realPath(repo);
          expect(refs).toContainEqual({
            name: "feature/ahead",
            isRemote: false,
            worktreePath: canonicalRepo,
          });
          expect(refs).toContainEqual({
            name: "main",
            isRemote: false,
            worktreePath: null,
          });
        }),
      ),
    );

    it.effect("surfaces remove and clean git failures", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nonRepo = yield* makeTmpDir();
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          const removeExit = yield* Effect.exit(
            vcs.removePath({ worktreePath: nonRepo, path: "missing.txt" }),
          );
          expect(removeExit._tag).toBe("Failure");

          const cleanExit = yield* Effect.exit(
            vcs.clean({ worktreePath: nonRepo, path: "missing-dir" }),
          );
          expect(cleanExit._tag).toBe("Failure");
        }),
      ),
    );

    it.effect("merges with message and no-ff/no-verify options", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          yield* vcs.createBranch({ worktreePath: repo, branch: "feature/merge", switch: true });
          yield* writeTextFile(NodePath.join(repo, "merge.txt"), "merge\n");
          yield* vcs.commit({ worktreePath: repo, subject: "source", body: "" });
          yield* git(repo, ["checkout", "main"]);

          const result = yield* vcs.merge({
            worktreePath: repo,
            ref: "feature/merge",
            message: "Merge feature branch",
            noFf: true,
            noVerify: true,
          });
          expect(result.status).toBe("merged");
          expect(yield* git(repo, ["log", "-1", "--pretty=%s"])).toBe("Merge feature branch");
        }),
      ),
    );

    it.effect("surfaces merge conflicts as a value", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          yield* vcs.createBranch({ worktreePath: repo, branch: "left", switch: true });
          yield* writeTextFile(NodePath.join(repo, "README.md"), "left\n");
          yield* vcs.commit({ worktreePath: repo, subject: "left", body: "" });
          yield* git(repo, ["checkout", "main"]);
          yield* vcs.createBranch({ worktreePath: repo, branch: "right", switch: true });
          yield* writeTextFile(NodePath.join(repo, "README.md"), "right\n");
          yield* vcs.commit({ worktreePath: repo, subject: "right", body: "" });

          const result = yield* vcs.merge({ worktreePath: repo, ref: "left" });
          expect(result.status).toBe("conflict");
          if (result.status === "conflict") {
            expect(result.conflictedFiles).toEqual(["README.md"]);
          }
        }),
      ),
    );

    it.effect("aborts merge conflicts back to a clean tree when requested", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          yield* vcs.createBranch({ worktreePath: repo, branch: "left", switch: true });
          yield* writeTextFile(NodePath.join(repo, "README.md"), "left\n");
          yield* vcs.commit({ worktreePath: repo, subject: "left", body: "" });
          yield* git(repo, ["checkout", "main"]);
          yield* vcs.createBranch({ worktreePath: repo, branch: "right", switch: true });
          yield* writeTextFile(NodePath.join(repo, "README.md"), "right\n");
          yield* vcs.commit({ worktreePath: repo, subject: "right", body: "" });

          const result = yield* vcs.merge({
            worktreePath: repo,
            ref: "left",
            message: "Merge left",
            noFf: true,
            noVerify: true,
            abortOnConflict: true,
          });
          expect(result.status).toBe("conflict");
          if (result.status === "conflict") {
            expect(result.conflictedFiles).toEqual(["README.md"]);
          }
          expect(yield* git(repo, ["status", "--porcelain"])).toBe("");
        }),
      ),
    );

    it.effect("surfaces a real merge failure as an error, not a conflict", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });

          // A nonexistent ref makes `git merge` exit nonzero with NO unmerged
          // files. This is a genuine error and must NOT be masked as a conflict.
          const error = yield* vcs
            .merge({ worktreePath: repo, ref: "does-not-exist-ref", abortOnConflict: true })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(GitCommandError);
          expect((error as GitCommandError).stderr).toContain("does-not-exist-ref");
          // Best-effort abort keeps the tree clean even on a genuine failure.
          expect(yield* git(repo, ["status", "--porcelain"])).toBe("");
        }),
      ),
    );

    it.effect("commits with --no-verify when requested", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });
          const fileSystem = yield* FileSystem.FileSystem;

          const hooksDir = NodePath.join(repo, "hooks");
          yield* fileSystem.makeDirectory(hooksDir, { recursive: true });
          const hookPath = NodePath.join(hooksDir, "pre-commit");
          yield* writeTextFile(hookPath, "#!/bin/sh\nexit 1\n");
          yield* fileSystem.chmod(hookPath, 0o755);
          yield* git(repo, ["config", "core.hooksPath", "hooks"]);

          yield* writeTextFile(NodePath.join(repo, "skip-hook.txt"), "skip\n");
          const result = yield* vcs.commit({
            worktreePath: repo,
            subject: "Bypass hook",
            body: "",
            noVerify: true,
          });
          expect(result.status).toBe("created");
          expect(yield* git(repo, ["log", "-1", "--pretty=%s"])).toBe("Bypass hook");
        }),
      ),
    );

    it.effect("round-trips checkpoints through the existing CheckpointStore surface", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          yield* initRepoWithCommit(repo);
          const gitDriver = yield* GitVcsDriver.GitVcsDriver;
          const checkpointStore = yield* CheckpointStore.CheckpointStore;
          const vcs = makeVcsCapability({ git: gitDriver, checkpoints: checkpointStore });
          const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/plugin-vcs-test/turn/1");

          yield* writeTextFile(NodePath.join(repo, "README.md"), "# changed\n");
          yield* vcs.createCheckpoint({ worktreePath: repo, checkpointRef });
          expect(yield* vcs.hasCheckpoint({ worktreePath: repo, checkpointRef })).toBe(true);

          yield* writeTextFile(NodePath.join(repo, "README.md"), "# after\n");
          const restored = yield* vcs.restoreCheckpoint({ worktreePath: repo, checkpointRef });
          expect(restored.restored).toBe(true);
          const fileSystem = yield* FileSystem.FileSystem;
          expect(yield* fileSystem.readFileString(NodePath.join(repo, "README.md"))).toBe(
            "# changed\n",
          );

          yield* vcs.deleteCheckpoints({ worktreePath: repo, checkpointRefs: [checkpointRef] });
          expect(yield* vcs.hasCheckpoint({ worktreePath: repo, checkpointRef })).toBe(false);
        }),
      ),
    );
  });
});
