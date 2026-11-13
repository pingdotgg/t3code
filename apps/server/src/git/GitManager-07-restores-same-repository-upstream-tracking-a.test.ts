// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import type {
  ChangeRequest,
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ModelSelection,
} from "@t3tools/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  fromRunner,
  decodeJsonReply,
} from "@t3tools/provider-core/server/textGenerationOperations";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

/** A change request the fake host reports. Omitted fields read as an open, undated request. */

import {
  makeTempDir,
  runGit,
  initRepo,
  createBareRemote,
  preparePullRequestThread,
  makeManager,
  asThreadId,
  layerGitManagerTest,
} from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect(
    "restores same-repository upstream tracking after local PR checkout without a remote ref",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-upstream"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "upstream.txt"), "upstream\n");
        yield* runGit(repoDir, ["add", "upstream.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Local upstream PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-upstream"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-upstream"]);
        yield* runGit(repoDir, [
          "update-ref",
          "-d",
          "refs/remotes/origin/feature/pr-local-upstream",
        ]);

        const { manager } = yield* makeManager({
          providerScenario: {
            pullRequest: {
              number: 65,
              title: "Local upstream PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/65",
              baseRefName: "main",
              headRefName: "feature/pr-local-upstream",
              state: "open",
              isCrossRepository: false,
              headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
              headRepositoryOwnerLogin: "pingdotgg",
            },
            repositoryCloneUrls: {
              "pingdotgg/codething-mvp": {
                url: remoteDir,
                sshUrl: remoteDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "65",
          mode: "local",
        });

        expect(result.worktreePath).toBeNull();
        expect(result.branch).toBe("feature/pr-local-upstream");
        expect(
          (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
        ).toBe("origin/feature/pr-local-upstream");
      }),
  );
  it.effect(
    "restores same-repository upstream tracking when provider omits head repository metadata",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-no-head-repo"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "no-head-repo.txt"), "upstream\n");
        yield* runGit(repoDir, ["add", "no-head-repo.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Local PR branch without repo metadata"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-no-head-repo"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-no-head-repo"]);
        yield* runGit(repoDir, [
          "update-ref",
          "-d",
          "refs/remotes/origin/feature/pr-local-no-head-repo",
        ]);

        const { manager } = yield* makeManager({
          providerScenario: {
            pullRequest: {
              number: 66,
              title: "Local upstream PR without repo metadata",
              url: "https://github.com/pingdotgg/codething-mvp/pull/66",
              baseRefName: "main",
              headRefName: "feature/pr-local-no-head-repo",
              state: "open",
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "66",
          mode: "local",
        });

        expect(result.worktreePath).toBeNull();
        expect(result.branch).toBe("feature/pr-local-no-head-repo");
        expect(
          (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
        ).toBe("origin/feature/pr-local-no-head-repo");
      }),
  );
  it.effect("prepares a worktree from the head branch when the host has no pull ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/no-pull-ref"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "head.txt"), "head\n");
      yield* runGit(repoDir, ["add", "head.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Head without a pull ref"]);
      yield* runGit(repoDir, ["push", "origin", "feature/no-pull-ref"]);
      const headSha = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/no-pull-ref"]);
      const remoteUrl = "https://dev.azure.com/org/project/_git/repo";
      yield* runGit(repoDir, ["remote", "set-url", "origin", remoteUrl]);
      yield* runGit(repoDir, ["config", `url.${remoteDir}.insteadOf`, remoteUrl]);

      const { manager: otherRepositoryManager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 79,
            title: "Another repository's PR",
            url: "https://dev.azure.com/org/project/_git/other/pullrequest/79",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "open",
            isCrossRepository: false,
          },
        },
      });
      yield* Effect.flip(
        preparePullRequestThread(otherRepositoryManager, {
          cwd: repoDir,
          reference: "79",
          mode: "worktree",
        }),
      );
      const { manager: mergedManager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 77,
            title: "Merged PR",
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/77",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "merged",
            isCrossRepository: false,
          },
        },
      });
      yield* Effect.flip(
        preparePullRequestThread(mergedManager, {
          cwd: repoDir,
          reference: "77",
          mode: "worktree",
        }),
      );
      const localBranches = (yield* runGit(repoDir, ["branch", "--list"])).stdout;
      expect(localBranches).not.toContain("feature/no-pull-ref");

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 78,
            title: "Azure DevOps PR",
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/78",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "open",
            isCrossRepository: false,
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "78",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/no-pull-ref");
      const worktreeHead = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "HEAD",
      ])).stdout.trim();
      expect(worktreeHead).toBe(headSha);
      const upstream = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstream).toBe("origin/feature/no-pull-ref");
    }),
  );
  it.effect("preserves fork upstream tracking when preparing a worktree PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-fork"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 81,
            title: "Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/81",
            baseRefName: "main",
            headRefName: "feature/pr-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "81",
        mode: "worktree",
      });

      expect(result.worktreePath).not.toBeNull();
      const upstreamRef = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstreamRef).toBe("fork-seed/feature/pr-fork");
      expect(upstreamRef.startsWith("origin/")).toBe(false);
      expect(
        (yield* runGit(result.worktreePath as string, [
          "config",
          "--get",
          "remote.fork-seed.url",
        ])).stdout.trim(),
      ).toBe(forkDir);
    }),
  );
  it.effect("refreshes a reused PR worktree onto the updated pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-stale"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "stale.txt"), "stale\n");
      yield* runGit(repoDir, ["add", "stale.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused stale PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-reused-stale"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-stale-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-stale"]);

      yield* runGit(repoDir, ["checkout", "-b", "author-push", "origin/feature/pr-reused-stale"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "authored.txt"), "authored\n");
      yield* runGit(repoDir, ["add", "authored.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New PR head commit"]);
      yield* runGit(repoDir, ["push", "origin", "author-push:feature/pr-reused-stale"]);
      const updatedHead = (yield* runGit(repoDir, ["rev-parse", "author-push"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 84,
            title: "Reused stale PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/84",
            baseRefName: "main",
            headRefName: "feature/pr-reused-stale",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "84",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-reused-stale");
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(updatedHead);
    }),
  );
  it.effect("resets a clean reused PR worktree onto a force-pushed pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-force-pushed"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "force-pushed.txt"), "first\n");
      yield* runGit(repoDir, ["add", "force-pushed.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Force-pushed PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-force-pushed"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-force-pushed-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-force-pushed"]);
      const staleHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "author-rewrite", "feature/pr-force-pushed"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "force-pushed.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "force-pushed.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten PR head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "author-rewrite:feature/pr-force-pushed",
      ]);
      const rewrittenHead = (yield* runGit(repoDir, ["rev-parse", "author-rewrite"])).stdout.trim();
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-force-pushed",
        staleHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 86,
            title: "Force-pushed PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/86",
            baseRefName: "main",
            headRefName: "feature/pr-force-pushed",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "86",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.isOnPullRequestHead).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        rewrittenHead,
      );
      expect(
        NodeFS.readFileSync(NodePath.join(worktreePath, "force-pushed.txt"), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      ).toBe("rewritten\n");
    }),
  );
  it.effect("keeps a reused PR worktree that carries its own commit off the rewritten head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-commit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "local-commit.txt"), "first\n");
      yield* runGit(repoDir, ["add", "local-commit.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local commit PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-commit"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-local-commit-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-local-commit"]);
      const upstreamHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "local-commit-rewrite", "feature/pr-local-commit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "local-commit.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "local-commit.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten local commit head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "local-commit-rewrite:feature/pr-local-commit",
      ]);
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-local-commit",
        upstreamHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      NodeFS.writeFileSync(NodePath.join(worktreePath, "thread-work.txt"), "thread work\n");
      yield* runGit(worktreePath, ["add", "thread-work.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "Work done in the reused worktree"]);
      const worktreeHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 87,
            title: "Local commit PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/87",
            baseRefName: "main",
            headRefName: "feature/pr-local-commit",
            state: "open",
          },
        },
        setupScriptRunner: {
          runForThread: (setupInput) =>
            Effect.sync(() => {
              setupCalls.push(setupInput);
              return { status: "no-script" as const };
            }),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "87",
        mode: "worktree",
        threadId: asThreadId("thread-pr-local-commit"),
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(worktreeHead);
      expect(NodeFS.existsSync(NodePath.join(worktreePath, "thread-work.txt"))).toBe(true);
      expect(setupCalls).toHaveLength(0);
    }),
  );
  it.effect("keeps a dirty reused PR worktree off the rewritten pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-dirty-worktree"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "dirty.txt"), "first\n");
      yield* runGit(repoDir, ["add", "dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Dirty worktree PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-dirty-worktree"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-dirty-worktree-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-dirty-worktree"]);
      const staleHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "dirty-rewrite", "feature/pr-dirty-worktree"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "dirty.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "dirty.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten dirty head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "dirty-rewrite:feature/pr-dirty-worktree",
      ]);
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-dirty-worktree",
        staleHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      NodeFS.writeFileSync(NodePath.join(worktreePath, "dirty.txt"), "uncommitted edit\n");

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 89,
            title: "Dirty worktree PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/89",
            baseRefName: "main",
            headRefName: "feature/pr-dirty-worktree",
            state: "open",
          },
        },
        setupScriptRunner: {
          runForThread: (setupInput) =>
            Effect.sync(() => {
              setupCalls.push(setupInput);
              return { status: "no-script" as const };
            }),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "89",
        mode: "worktree",
        threadId: asThreadId("thread-pr-dirty-worktree"),
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleHead);
      expect(NodeFS.readFileSync(NodePath.join(worktreePath, "dirty.txt"), "utf8")).toBe(
        "uncommitted edit\n",
      );
      expect(setupCalls).toHaveLength(0);
    }),
  );
  it.effect.each([
    { isCrossRepository: false, padding: 0 },
    { isCrossRepository: false, padding: 110 },
    { isCrossRepository: true, padding: 0 },
    { isCrossRepository: true, padding: 110 },
  ])(
    "reuses an existing PR worktree with $padding preceding matching branches (fork: $isCrossRepository)",
    ({ isCrossRepository, padding }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const forkDir = isCrossRepository ? yield* createBareRemote() : null;
        if (forkDir) {
          yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
          yield* runGit(repoDir, ["push", "fork-seed", "main:pr-pagination"]);
        }
        const headBranch = "pr-pagination";
        const localBranch = isCrossRepository ? "t3code/pr-78/pr-pagination" : headBranch;
        yield* runGit(repoDir, ["branch", localBranch]);
        yield* runGit(repoDir, ["push", "origin", `${localBranch}:refs/pull/78/head`]);
        const worktreePath = NodePath.join(repoDir, "existing-pr");
        yield* runGit(repoDir, ["worktree", "add", worktreePath, localBranch]);
        for (let index = 0; index < padding; index++) {
          yield* runGit(repoDir, [
            "branch",
            `a-padding-${String(index).padStart(3, "0")}/${localBranch}`,
          ]);
        }
        const git = yield* GitVcsDriver.GitVcsDriver;
        const page = yield* git.listRefs({
          cwd: repoDir,
          refKind: "local",
          query: localBranch,
          refresh: true,
        });
        expect(page.nextCursor !== null).toBe(padding > 0);
        expect(page.refs.some((ref) => ref.name === localBranch)).toBe(padding === 0);
        const { manager } = yield* makeManager({
          providerScenario: {
            repositoryCloneUrls: forkDir
              ? { "contributor/codething-mvp": { url: forkDir, sshUrl: forkDir } }
              : {},
            pullRequest: {
              number: 78,
              title: "Paginated PR worktree",
              url: "https://github.com/pingdotgg/codething-mvp/pull/78",
              baseRefName: "main",
              headRefName: headBranch,
              state: "open",
              isCrossRepository,
              ...(isCrossRepository
                ? {
                    headRepositoryNameWithOwner: "contributor/codething-mvp",
                    headRepositoryOwnerLogin: "contributor",
                  }
                : {}),
            },
          },
        });

        // Fetching directly into this checked-out branch would fail with git exit 128.
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "78",
          mode: "worktree",
        });
        expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
          NodeFS.realpathSync.native(worktreePath),
        );
        expect(result.branch).toBe(localBranch);
        expect(result.isOnPullRequestHead).toBe(true);
        expect((yield* runGit(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
          localBranch,
        );
      }),
  );
});
