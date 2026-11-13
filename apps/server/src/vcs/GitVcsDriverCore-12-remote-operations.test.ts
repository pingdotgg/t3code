// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  GitCommandError,
  ReviewDiffPreviewInput,
  VcsRef,
  VcsListRefsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
  type WorktreeSubmodules,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import {
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
  splitNullSeparatedGitStdoutPaths,
  windowsLongPathConfigEnv,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitConfigEnv } from "./VcsProcess.ts";

import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore-fixtures.testkit.ts";

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        yield* git(peer, ["push", "origin", "HEAD:refs/heads/unrelated"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({
          cwd,
          remoteName: "origin",
          refName: `origin/${initialBranch}`,
        });
        assert.isFalse(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );

        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: initialBranch,
          }),
          true,
        );
        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: "local-only",
          }),
          false,
        );

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
          remoteHead,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);

        yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "local-only" });
        assert.isTrue(
          yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
        );
      }),
    );

    it.effect("fetches the selected worktree base for Changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fork = yield* makeTmpDir("git-fork-");
        const source = yield* makeTmpDir("git-source-");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-M", "stable"]);
        yield* git(fork, ["init", "--bare"]);
        yield* git(source, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        yield* git(cwd, ["remote", "add", "upstream", source]);
        yield* git(cwd, ["push", "origin", "stable"]);
        yield* git(cwd, ["push", "-u", "upstream", "stable:release"]);
        const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* writeTextFile(cwd, "fork.txt", "fork-only work\n");
        yield* git(cwd, ["add", "fork.txt"]);
        yield* git(cwd, ["commit", "-m", "fork work"]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);

        // Advance the source without updating this checkout's tracking refs.
        yield* writeTextFile(cwd, "upstream.txt", "upstream-only work\n");
        yield* git(cwd, ["add", "upstream.txt"]);
        yield* git(cwd, ["commit", "-m", "source advance"]);
        const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(source, ["--git-dir=.", "fetch", cwd, "stable:refs/heads/release"]);
        yield* git(cwd, ["reset", "--hard", localHead]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" });
        assert.deepEqual(fetched, {
          commitSha: remoteHead,
          remoteRefName: "upstream/release",
        });
        yield* git(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);
        assert.deepEqual(
          yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "upstream/release" }),
          { commitSha: remoteHead, remoteRefName: "upstream/release" },
        );
        yield* git(cwd, ["branch", "--unset-upstream", "stable"]);
        assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" }), {
          commitSha: localHead,
          remoteRefName: "origin/stable",
        });
        assert.equal(yield* git(cwd, ["rev-parse", "stable"]), localHead);

        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: fetched!.commitSha,
          newRefName: "feature/from-upstream",
          baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
        });
        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        yield* writeTextFile(worktreePath, "feature.txt", "feature work\n");
        yield* git(worktreePath, ["add", "feature.txt"]);
        yield* git(worktreePath, ["commit", "-m", "feature work"]);

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(changes.diff, "+feature work");
        assert.notInclude(changes.diff, "upstream-only work");
        const status = yield* driver.statusDetailsLocal(worktreePath, {
          includeBranchChanges: true,
        });
        assert.strictEqual(status.aheadCount, 1);
        assert.strictEqual(status.branchChanges?.insertions, 1);
        assert.strictEqual(status.branchChanges?.deletions, 0);
        // gh pr create consumes this setting verbatim as the hosted target branch.
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.feature/from-upstream.t3-merge-base"),
          "release",
        );
        assert.equal(changes.baseRef, "upstream/release");
      }),
    );

    it.effect("does not use a deleted remote worktree base's stale tracking commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", `${initialBranch}:release`]);
        yield* git(remote, ["--git-dir=.", "update-ref", "-d", "refs/heads/release"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.equal(
          yield* git(cwd, ["rev-parse", "refs/remotes/origin/release"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
        yield* git(cwd, ["remote", "remove", "origin"]);
        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
      }),
    );

    it.effect("fetches a worktree base without downloading tags", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "tagged release"]);
        const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["tag", "v1"]);
        yield* git(cwd, ["push", "origin", initialBranch, "v1"]);
        yield* git(cwd, ["tag", "-d", "v1"]);
        yield* git(cwd, ["reset", "--hard", localHead]);
        yield* git(cwd, ["update-ref", "-d", `refs/remotes/origin/${initialBranch}`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }), {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.equal(yield* git(cwd, ["tag", "--list", "v1"]), "");
      }),
    );

    it.effect("fetches the remote a caller already resolved for the worktree base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "unpublished" }));
        assert.deepEqual(
          yield* driver.fetchWorktreeBaseCommit({
            cwd,
            refName: "unpublished",
            remote: { remoteName: "origin", branchName: initialBranch },
          }),
          { commitSha: head, remoteRefName: `origin/${initialBranch}` },
        );
      }),
    );

    it.effect("fails instead of falling back when the worktree base remote is unreachable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", `${cwd}/missing.git`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver
          .fetchWorktreeBaseCommit({ cwd, refName: initialBranch })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect("rebases a pushed branch's pulls when branch.autoSetupRebase asks for it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["config", "branch.autoSetupRebase", "always"]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/rebase"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), { setUpstream: true });
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/rebase.rebase"), "true");
      }),
    );

    it.effect("reports a push whose upstream could not be recorded", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-q", "-b", "feature/locked"]);
        yield* writeTextFile(cwd, ".git/config.lock", "");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // Recording the upstream retries on the real clock before giving up.
        const pushed = yield* TestClock.withLive(driver.pushCurrentBranch(cwd, null));

        assert.deepInclude(pushed, { status: "pushed", setUpstream: false });
        assert.include(
          yield* git(cwd, ["ls-remote", "origin", "refs/heads/feature/locked"]),
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/locked.remote"), null);
      }),
    );

    it.effect.each(["feature/push", "origin/feature/push"])(
      "publishes %s when the configured diff base already contains HEAD",
      (branch) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const originRemote = yield* makeTmpDir("git-origin-remote-");
          const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(originRemote, ["init", "--bare"]);
          yield* git(upstreamRemote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", originRemote]);
          yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
          yield* git(cwd, ["push", "origin", "main", "main:refs/heads/feature/push"]);
          yield* git(cwd, ["checkout", "--no-track", "-b", branch]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add feature", "");
          yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/main"]);
          yield* git(cwd, ["config", `branch.${branch}.gh-merge-base`, "upstream/main"]);

          const status = yield* driver.statusDetails(cwd);
          assert.equal(status.hasUpstream, false);
          assert.equal(status.aheadCount, 0);
          assert.equal(status.behindCount, 0);
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          assert.notEqual(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          const pushed = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(pushed, {
            status: "pushed",
            branch,
            upstreamBranch: "origin/feature/push",
            setUpstream: true,
          });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            head,
          );

          yield* git(cwd, ["branch", "--unset-upstream"]);
          const skipped = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skipped, { status: "skipped_up_to_date", branch });

          yield* writeTextFile(cwd, "remote.txt", "remote update\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Advance publish branch", "");
          yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature/push"]);
          const publishedHead = yield* git(originRemote, [
            "--git-dir=.",
            "rev-parse",
            "refs/heads/feature/push",
          ]);
          yield* git(cwd, ["reset", "--hard", head]);
          const skippedBehindRemote = yield* driver.pushCurrentBranch(cwd, null);
          assert.deepInclude(skippedBehindRemote, { status: "skipped_up_to_date", branch });
          assert.equal(
            yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
            publishedHead,
          );
        }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* git(cwd, ["add", "-A"]);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstream = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "upstream", "dev"]);
        const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "upstream/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"]),
          "Add feature",
        );
        assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "dev"]), devSha);
        assert.equal(yield* git(upstream, ["--git-dir=.", "rev-parse", "dev"]), upstreamDevSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.t3-merge-base"), "dev");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.equal(changes.baseRef, "upstream/dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
