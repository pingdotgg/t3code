import { existsSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { JjCoreLive } from "./JjCore.ts";
import { JjCore } from "../Services/JjCore.ts";
import {
  addRemoteAndPush,
  createBareRemote,
  initJjRepo,
  listBookmarks,
  makeTempDir,
  runGit,
  runJj,
  runJjStdout,
  writeTextFile,
} from "./JjTestUtils.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-core-test-" });
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const JjCoreTestLayer = JjCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(GitCoreTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, JjCoreTestLayer);

it.layer(TestLayer)("JjCore", (it) => {
  describe("statusDetails", () => {
    it.effect("returns status for a clean jj repository", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-status-");
        yield* initJjRepo(repoDir);

        const jjCore = yield* JjCore;
        const status = yield* jjCore.statusDetails(repoDir);

        expect(status.isRepo).toBe(true);
        expect(status.branch).toBe("main");
        expect(status.isDefaultBranch).toBe(true);
        expect(status.hasWorkingTreeChanges).toBe(false);
        expect(status.workingTree.files).toHaveLength(0);
      }),
    );

    it.effect("detects working tree changes", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-status-dirty-");
        yield* initJjRepo(repoDir);
        yield* writeTextFile(path.join(repoDir, "dirty.txt"), "dirty\n");
        yield* runJj(repoDir, ["file", "track", "dirty.txt"]);

        const jjCore = yield* JjCore;
        const status = yield* jjCore.statusDetails(repoDir);

        expect(status.hasWorkingTreeChanges).toBe(true);
        expect(status.workingTree.files.length).toBeGreaterThan(0);
        expect(status.workingTree.insertions).toBeGreaterThan(0);
      }),
    );
  });

  describe("commit and push", () => {
    it.effect("commits changes and pushes to a remote", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-commit-");
        yield* initJjRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", remoteDir);

        yield* writeTextFile(path.join(repoDir, "feature.txt"), "committed\n");
        const jjCore = yield* JjCore;
        const { commitSha } = yield* jjCore.commit(repoDir, "Add feature file", "");

        expect(commitSha.length).toBeGreaterThan(0);

        const statusAfterCommit = yield* jjCore.statusDetails(repoDir);
        expect(statusAfterCommit.branch).toBe("main");
        expect(statusAfterCommit.aheadCount).toBeGreaterThan(0);

        const pushResult = yield* jjCore.pushCurrentBranch(repoDir, "main");
        expect(pushResult.status).toBe("pushed");

        const statusAfterPush = yield* jjCore.statusDetails(repoDir);
        expect(statusAfterPush.aheadCount).toBe(0);
      }),
    );
  });

  describe("pullCurrentBranch", () => {
    it.effect("pulls upstream changes into the local bookmark", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-pull-");
        yield* initJjRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", remoteDir);

        // Simulate upstream changes by pushing directly to the bare remote.
        // This part uses git because we're operating on a separate clone
        // that isn't a jj repo — it represents another developer pushing.
        const tmpClone = yield* makeTempDir("t3code-jj-pull-clone-");
        yield* runGit(tmpClone, ["clone", "--branch", "main", remoteDir, "."]);
        yield* runGit(tmpClone, ["config", "user.email", "test@example.com"]);
        yield* runGit(tmpClone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmpClone, "upstream.txt"), "upstream change\n");
        yield* runGit(tmpClone, ["add", "upstream.txt"]);
        yield* runGit(tmpClone, ["commit", "-m", "upstream commit"]);
        yield* runGit(tmpClone, ["push", "origin", "main"]);

        const jjCore = yield* JjCore;
        const pullResult = yield* jjCore.pullCurrentBranch(repoDir);

        expect(pullResult.status).toBe("pulled");
        expect(existsSync(path.join(repoDir, "upstream.txt"))).toBe(true);
      }),
    );

    it.effect("pulls even when working copy has uncommitted changes", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-pull-dirty-");
        yield* initJjRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", remoteDir);

        // Simulate upstream changes (git clone — separate developer)
        const tmpClone = yield* makeTempDir("t3code-jj-pull-dirty-clone-");
        yield* runGit(tmpClone, ["clone", "--branch", "main", remoteDir, "."]);
        yield* runGit(tmpClone, ["config", "user.email", "test@example.com"]);
        yield* runGit(tmpClone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmpClone, "upstream.txt"), "upstream\n");
        yield* runGit(tmpClone, ["add", "upstream.txt"]);
        yield* runGit(tmpClone, ["commit", "-m", "upstream commit"]);
        yield* runGit(tmpClone, ["push", "origin", "main"]);

        // Create local working copy changes
        yield* writeTextFile(path.join(repoDir, "local-wip.txt"), "work in progress\n");
        yield* runJj(repoDir, ["file", "track", "local-wip.txt"]);

        const jjCore = yield* JjCore;
        const beforePull = yield* jjCore.statusDetails(repoDir);
        expect(beforePull.hasWorkingTreeChanges).toBe(true);

        // Should NOT block — JJ auto-snapshots and rebases
        const pullResult = yield* jjCore.pullCurrentBranch(repoDir);
        expect(pullResult.status).toBe("pulled");

        // Both upstream and local files should be present
        expect(existsSync(path.join(repoDir, "upstream.txt"))).toBe(true);
        expect(existsSync(path.join(repoDir, "local-wip.txt"))).toBe(true);
      }),
    );
  });

  describe("setBranchUpstream", () => {
    it.effect("round-trips upstream config values correctly", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-upstream-");
        yield* initJjRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", remoteDir);

        const jjCore = yield* JjCore;
        yield* jjCore.setBranchUpstream({
          cwd: repoDir,
          branch: "main",
          remoteName: "origin",
          remoteBranch: "main",
        });

        const remoteCfg = yield* jjCore.readConfigValue(repoDir, "branch.main.remote");
        const mergeCfg = yield* jjCore.readConfigValue(repoDir, "branch.main.merge");

        expect(remoteCfg).toBe("origin");
        expect(mergeCfg).toBe("refs/heads/main");

        // Verify statusDetails resolves the upstream correctly
        const status = yield* jjCore.statusDetails(repoDir);
        expect(status.upstreamRef).toBe("origin/main");
      }),
    );
  });

  describe("createBranch", () => {
    it.effect("creates a bookmark at the working copy revision", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-createbranch-");
        yield* initJjRepo(repoDir);
        yield* writeTextFile(path.join(repoDir, "new-feature.txt"), "feature\n");
        yield* runJj(repoDir, ["file", "track", "new-feature.txt"]);

        const jjCore = yield* JjCore;
        yield* jjCore.createBranch({ cwd: repoDir, branch: "feat/new" });

        // The bookmark should point at @ (the working copy with changes)
        const currentChangeId = yield* runJjStdout(repoDir, [
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          "commit_id",
        ]);
        const bookmarkChangeId = yield* runJjStdout(repoDir, [
          "log",
          "-r",
          "feat/new",
          "--no-graph",
          "-T",
          "commit_id",
        ]);
        expect(bookmarkChangeId).toBe(currentChangeId);

        // Should be resolvable as current branch
        const status = yield* jjCore.statusDetails(repoDir);
        expect(status.branch).toBe("feat/new");
      }),
    );
  });

  describe("filterIgnoredPaths", () => {
    it.effect("filters out gitignored paths", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-core-ignore-");
        yield* initJjRepo(repoDir);
        yield* writeTextFile(path.join(repoDir, ".gitignore"), "ignored.txt\n");
        yield* runJj(repoDir, ["file", "track", ".gitignore"]);
        yield* writeTextFile(path.join(repoDir, "tracked.txt"), "tracked\n");
        yield* runJj(repoDir, ["file", "track", "tracked.txt"]);
        yield* writeTextFile(path.join(repoDir, "ignored.txt"), "should be ignored\n");

        const jjCore = yield* JjCore;
        const result = yield* jjCore.filterIgnoredPaths(repoDir, [
          "tracked.txt",
          "ignored.txt",
          ".gitignore",
        ]);

        expect(result).toContain("tracked.txt");
        expect(result).toContain(".gitignore");
        expect(result).not.toContain("ignored.txt");
      }),
    );
  });

  describe("fetchPullRequestBranch", () => {
    it.effect(
      "fetches a GitHub pull request head into a local bookmark without switching the root repo",
      () =>
        Effect.gen(function* () {
          const repoDir = yield* makeTempDir("t3code-jj-core-");
          yield* initJjRepo(repoDir);
          const remoteDir = yield* createBareRemote();
          yield* addRemoteAndPush(repoDir, "origin", remoteDir);

          // Create a feature branch with a commit, push it, and simulate a
          // GitHub PR ref.  The PR ref push uses git since jj doesn't have
          // an equivalent for arbitrary refspecs.
          yield* writeTextFile(path.join(repoDir, "pr-fetch.txt"), "fetch me\n");
          yield* runJj(repoDir, ["file", "track", "pr-fetch.txt"]);
          yield* runJj(repoDir, ["describe", "-m", "Add PR fetch branch"]);
          yield* runJj(repoDir, ["bookmark", "create", "feature/pr-fetch", "-r", "@"]);
          yield* runJj(repoDir, ["new"]);
          yield* runJj(repoDir, ["git", "fetch", "--remote", "origin"], true);
          yield* runJj(repoDir, ["bookmark", "track", "feature/pr-fetch@origin"], true);
          yield* runJj(repoDir, ["git", "push", "--remote", "origin", "-b", "feature/pr-fetch"]);
          // Simulate GitHub's PR ref — jj doesn't support arbitrary refspecs.
          yield* runJj(repoDir, ["git", "export"]);
          yield* runJj(repoDir, [
            "util",
            "exec",
            "--",
            "git",
            "push",
            "origin",
            "feature/pr-fetch:refs/pull/55/head",
          ]);
          yield* runJj(repoDir, ["git", "import"]);
          // Move back to main so fetchPullRequestBranch doesn't see us on the feature branch.
          yield* runJj(repoDir, ["new", "main"]);

          yield* (yield* JjCore).fetchPullRequestBranch({
            cwd: repoDir,
            prNumber: 55,
            branch: "t3code/pr-55/feature-pr-fetch",
            remoteName: "origin",
            remoteBranch: "feature/pr-fetch",
          });

          const bookmarks = yield* listBookmarks(repoDir);
          expect(
            bookmarks.some(
              (bookmark) =>
                bookmark.name === "t3code/pr-55/feature-pr-fetch" && bookmark.remote === undefined,
            ),
          ).toBe(true);

          const status = yield* (yield* JjCore).statusDetails(repoDir);
          expect(status.branch).toBe("main");
        }),
    );
  });

  describe("remote branch mapping", () => {
    it.effect(
      "maps a synthetic local bookmark to a different remote branch and preserves upstream in a workspace",
      () =>
        Effect.gen(function* () {
          const repoDir = yield* makeTempDir("t3code-jj-core-");
          yield* initJjRepo(repoDir);
          const originDir = yield* createBareRemote();
          const forkDir = yield* createBareRemote();
          yield* addRemoteAndPush(repoDir, "origin", originDir);
          // Create a feature branch, push to the fork remote, then clean up.
          // Uses git export/import to set up the cross-repo scenario that
          // JjCore.fetchRemoteBranch must handle.
          yield* writeTextFile(path.join(repoDir, "fork.txt"), "fork\n");
          yield* runJj(repoDir, ["file", "track", "fork.txt"]);
          yield* runJj(repoDir, ["describe", "-m", "Fork PR branch"]);
          yield* runJj(repoDir, ["bookmark", "create", "feature/pr-fork", "-r", "@"]);
          yield* runJj(repoDir, ["new"]);
          yield* runJj(repoDir, ["git", "remote", "add", "fork", forkDir]).pipe(Effect.asVoid);
          yield* runJj(repoDir, ["git", "export"]);
          yield* runGit(repoDir, ["push", "fork", "feature/pr-fork"]);
          yield* runJj(repoDir, ["bookmark", "delete", "feature/pr-fork"]);
          yield* runJj(repoDir, ["git", "import"]);

          const syntheticBranch = "t3code/pr-81/feature-pr-fork";
          yield* (yield* JjCore).fetchRemoteBranch({
            cwd: repoDir,
            remoteName: "fork",
            remoteBranch: "feature/pr-fork",
            localBranch: syntheticBranch,
          });
          yield* (yield* JjCore).setBranchUpstream({
            cwd: repoDir,
            branch: syntheticBranch,
            remoteName: "fork",
            remoteBranch: "feature/pr-fork",
          });

          const worktreePath = path.join(repoDir, "pr-worktree");
          const worktree = yield* (yield* JjCore).createWorktree({
            cwd: repoDir,
            branch: syntheticBranch,
            path: worktreePath,
          });

          expect(existsSync(worktree.worktree.path)).toBe(true);
          const worktreeStatus = yield* (yield* JjCore).statusDetails(worktree.worktree.path);
          expect(worktreeStatus.branch).toBe(syntheticBranch);
          expect(worktreeStatus.upstreamRef).toBe("fork/feature/pr-fork");

          const remoteHeadBefore = yield* runGit(forkDir, [
            "rev-parse",
            "refs/heads/feature/pr-fork",
          ]).pipe(Effect.map((result) => result.stdout.trim()));

          yield* writeTextFile(path.join(worktree.worktree.path, "workspace.txt"), "workspace\n");
          yield* (yield* JjCore).commit(worktree.worktree.path, "Update workspace", "");
          const pushResult = yield* (yield* JjCore).pushCurrentBranch(
            worktree.worktree.path,
            syntheticBranch,
          );

          const remoteHeadAfter = yield* runGit(forkDir, [
            "rev-parse",
            "refs/heads/feature/pr-fork",
          ]).pipe(Effect.map((result) => result.stdout.trim()));

          expect(pushResult.status).toBe("pushed");
          expect(pushResult.upstreamBranch).toBe("fork/feature/pr-fork");
          expect(remoteHeadAfter).not.toBe(remoteHeadBefore);

          const rootStatus = yield* (yield* JjCore).statusDetails(repoDir);
          expect(rootStatus.branch).toBe("main");
        }),
    );
  });
});
