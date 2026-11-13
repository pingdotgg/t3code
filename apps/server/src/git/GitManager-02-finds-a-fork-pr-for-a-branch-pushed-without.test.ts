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
import { ChangeRequest, GitActionProgressEvent, GitPreparePullRequestThreadInput, ModelSelection } from "@t3tools/contracts";
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

import { listed, makeTempDir, runGit, initRepo, createBareRemote, configureVisibleRemoteUrlWithLocalRewrite, makeManager, layerGitManagerTest, squashMergeIntoRemoteMain, squashMergedPr } from "./GitManager-fixtures.testkit.ts";
import type { FakeProviderScenario } from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect("finds a fork PR for a branch pushed without an upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/no-upstream-fork"]);
      yield* runGit(repoDir, ["push", "fork", "feature/no-upstream-fork"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const providerScenario: FakeProviderScenario = {
        prListByHeadSelector: {
          "feature/no-upstream-fork": [
            {
              number: 40,
              title: "Another fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/40",
              baseRefName: "main",
              headRefName: "feature/no-upstream-fork",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "someone-else/codething-mvp",
              headRepositoryOwnerLogin: "someone-else",
            },
            {
              number: 41,
              title: "Our fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/41",
              baseRefName: "main",
              headRefName: "feature/no-upstream-fork",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "contributor/codething-mvp",
              headRepositoryOwnerLogin: "contributor",
            },
          ],
        },
      };
      const { manager } = yield* makeManager({ providerScenario });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/no-upstream-fork",
      });
      expect(pullRequest?.number).toBe(41);
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(41);

      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Continue feature"]);
      const localHead = yield* runGit(repoDir, ["rev-parse", "HEAD"]);
      const pushedHead = yield* runGit(repoDir, [
        "rev-parse",
        "refs/remotes/fork/feature/no-upstream-fork",
      ]);
      expect(localHead.stdout.trim()).not.toBe(pushedHead.stdout.trim());
      const { manager: aheadManager } = yield* makeManager({ providerScenario });
      expect(
        (yield* aheadManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }))?.number,
      ).toBe(41);
      expect((yield* aheadManager.status({ cwd: repoDir })).pr?.number).toBe(41);

      yield* runGit(repoDir, ["config", "branch.feature/no-upstream-fork.remote", "origin"]);
      const upstream = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/feature/no-upstream-fork",
      ]);
      expect(upstream.stdout.trim()).toBe("");
      const { manager: staleRemoteManager } = yield* makeManager({ providerScenario });
      expect(
        (yield* staleRemoteManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }))?.number,
      ).toBe(41);

      yield* runGit(repoDir, ["config", "--unset", "branch.feature/no-upstream-fork.remote"]);
      yield* runGit(repoDir, ["checkout", "-b", "diverged-push", "main"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Rewrite fork head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "fork",
        "HEAD:refs/heads/feature/no-upstream-fork",
      ]);
      yield* runGit(repoDir, ["checkout", "feature/no-upstream-fork"]);
      const { manager: divergedManager } = yield* makeManager({ providerScenario });
      expect(
        yield* divergedManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }),
      ).toBeNull();
    }),
  );
  it.effect("prefers an exact fork ref but does not guess between equal refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const firstForkDir = yield* createBareRemote();
      const secondForkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "first-fork", firstForkDir]);
      yield* runGit(repoDir, ["remote", "add", "second-fork", secondForkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/ambiguous-fork"]);
      yield* runGit(repoDir, ["push", "first-fork", "feature/ambiguous-fork"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "first-fork",
        "git@github.com:contributor/codething-mvp.git",
        firstForkDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "second-fork",
        "git@github.com:someone-else/codething-mvp.git",
        secondForkDir,
      );

      const providerScenario: FakeProviderScenario = {
        prListByHeadSelector: {
          "feature/ambiguous-fork": [
            {
              number: 41,
              title: "One fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/41",
              baseRefName: "main",
              headRefName: "feature/ambiguous-fork",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "contributor/codething-mvp",
              headRepositoryOwnerLogin: "contributor",
            },
          ],
        },
      };
      const { manager: singleRemoteManager } = yield* makeManager({ providerScenario });
      expect(
        (yield* singleRemoteManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/ambiguous-fork",
        }))?.number,
      ).toBe(41);

      yield* runGit(repoDir, ["push", "second-fork", "feature/ambiguous-fork"]);
      const { manager } = yield* makeManager({ providerScenario });
      expect(
        yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/ambiguous-fork" }),
      ).toBeNull();

      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Continue feature"]);
      yield* runGit(repoDir, ["push", "first-fork", "feature/ambiguous-fork"]);
      const { manager: exactManager } = yield* makeManager({ providerScenario });
      expect(
        (yield* exactManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/ambiguous-fork",
        }))?.number,
      ).toBe(41);
    }),
  );
  it.effect("does not guess a fork when an ancestry probe fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/failed-probe"]);
      yield* runGit(repoDir, ["push", "fork", "feature/failed-probe"]);
      yield* runGit(repoDir, ["push", "origin", "feature/failed-probe"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Local work"]);
      const treeOid = (yield* runGit(repoDir, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      yield* runGit(repoDir, ["update-ref", "refs/remotes/origin/feature/failed-probe", treeOid]);
      const forkProbe = yield* runGit(
        repoDir,
        ["merge-base", "--is-ancestor", "refs/remotes/fork/feature/failed-probe", "HEAD"],
        true,
      );
      expect(forkProbe.exitCode).toBe(0);
      const originProbe = yield* runGit(
        repoDir,
        ["merge-base", "--is-ancestor", "refs/remotes/origin/feature/failed-probe", "HEAD"],
        true,
      );
      expect(originProbe.exitCode).not.toBe(0);
      expect(originProbe.exitCode).not.toBe(1);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const providerScenario: FakeProviderScenario = {
        prListByHeadSelector: {
          "feature/failed-probe": [
            {
              number: 43,
              title: "Failed probe PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/43",
              baseRefName: "main",
              headRefName: "feature/failed-probe",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "contributor/codething-mvp",
              headRepositoryOwnerLogin: "contributor",
            },
          ],
        },
      };
      const { manager } = yield* makeManager({ providerScenario });
      expect(
        yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/failed-probe" }),
      ).toBeNull();
    }),
  );
  it.effect("finds a fork PR when the remote name contains a slash", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "team/fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/slash-remote"]);
      yield* runGit(repoDir, ["push", "team/fork", "feature/slash-remote"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "team/fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager } = yield* makeManager({
        providerScenario: {
          prListByHeadSelector: {
            "feature/slash-remote": [
              {
                number: 42,
                title: "Slash remote PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/slash-remote",
                state: "open",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "contributor/codething-mvp",
                headRepositoryOwnerLogin: "contributor",
              },
            ],
          },
        },
      });

      expect(
        (yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/slash-remote" }))
          ?.number,
      ).toBe(42);
    }),
  );
  it.effect("branch PR lookup does not reuse a cached PR after the remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originalRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originalRemoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/repointed-lookup"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/repointed-lookup"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:old-owner/old-repository.git",
        originalRemoteDir,
      );
      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 219,
                title: "Old repository PR",
                url: "https://github.com/old-owner/old-repository/pull/219",
                baseRefName: "main",
                headRefName: "feature/repointed-lookup",
                state: "merged",
                updatedAt: "2026-04-06T15:00:00Z",
              },
            ],
            [],
          ],
        },
      });

      const first = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });
      expect(first?.state).toBe("merged");

      const replacementRemoteDir = yield* createBareRemote();
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:new-owner/new-repository.git",
        replacementRemoteDir,
      );

      const second = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });

      expect(second).toBeNull();
      expect(listed(providerCalls)).toHaveLength(2);
    }),
  );

  // regression: #8600 settle threads server-side
  it.effect("branch PR lookup propagates provider failures", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          failWith: "The host is signed out.",
        },
      });

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SourceControlProviderError");
      const refreshError = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" }, { refresh: true })
        .pipe(Effect.flip);
      expect(refreshError._tag).toBe("SourceControlProviderError");
      expect(listed(providerCalls)).toHaveLength(1);
    }),
  );
  it.effect("status finds a merged PR after its remote branch was deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/merged-branch-deleted"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/merged-branch-deleted"]);

      // Deleting a merged head removes its tracking ref but leaves remote/merge config proving publication.
      yield* runGit(repoDir, ["push", "origin", "--delete", "feature/merged-branch-deleted"]);
      const configuredRemote = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.remote",
      ]);
      const configuredMerge = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.merge",
      ]);
      const trackingRef = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin/feature/merged-branch-deleted",
      ]);
      expect(configuredRemote.stdout.trim()).toBe("origin");
      expect(configuredMerge.stdout.trim()).toBe("refs/heads/feature/merged-branch-deleted");
      expect(trackingRef.stdout.trim()).toBe("");

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 215,
                title: "Merged branch was deleted",
                url: "https://github.com/pingdotgg/t3code/pull/215",
                baseRefName: "main",
                headRefName: "feature/merged-branch-deleted",
                state: "merged",
                mergedAt: "2026-04-02T15:00:00Z",
                updatedAt: "2026-04-02T15:00:00Z",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.hasUpstream).toBe(false);
      expect(status.pr).toEqual({
        number: 215,
        title: "Merged branch was deleted",
        url: "https://github.com/pingdotgg/t3code/pull/215",
        baseRef: "main",
        headRef: "feature/merged-branch-deleted",
        state: "merged",
        updatedAt: "2026-04-02T15:00:00.000Z",
      });
      expect(listed(providerCalls).length).toBeGreaterThan(0);
    }),
  );
  it.effect("status reports nothing to ship after a squash merge deleted the remote branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/squash-deleted";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      yield* runGit(repoDir, ["push", "origin", "--delete", branch]);
      yield* runGit(repoDir, ["fetch", "--prune", "origin"]);

      const { manager } = yield* makeManager({
        providerScenario: { prListSequence: [[squashMergedPr(branch, headSha)]] },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect(status.hasUpstream).toBe(false);
      expect({
        aheadCount: status.aheadCount,
        aheadOfDefaultCount: status.aheadOfDefaultCount,
      }).toEqual({ aheadCount: 0, aheadOfDefaultCount: 0 });
    }),
  );
  it.effect("status reports nothing to ship after a squash merge kept the remote branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/squash-kept";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      yield* runGit(repoDir, ["fetch", "--prune", "origin"]);

      const { manager } = yield* makeManager({
        providerScenario: { prListSequence: [[squashMergedPr(branch, headSha)]] },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect(status.hasUpstream).toBe(true);
      expect({
        aheadCount: status.aheadCount,
        aheadOfDefaultCount: status.aheadOfDefaultCount,
      }).toEqual({ aheadCount: 0, aheadOfDefaultCount: 0 });
    }),
  );
  it.effect("status still reports work to ship for a commit added after a squash merge", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/squash-follow-up";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      NodeFS.writeFileSync(NodePath.join(repoDir, "follow-up.txt"), "after merge\n");
      yield* runGit(repoDir, ["add", "follow-up.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Follow-up work"]);
      yield* runGit(repoDir, ["fetch", "--prune", "origin"]);

      const { manager } = yield* makeManager({
        providerScenario: { prListSequence: [[squashMergedPr(branch, headSha)]] },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect(status.aheadCount).toBe(1);
      expect(status.aheadOfDefaultCount).toBe(2);
    }),
  );
  it.effect("status still reports work against main after a merge into another base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const initialSha = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/release-only";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      // Move the merge to release and leave main without it.
      const squashSha = (yield* runGit(repoDir, ["rev-parse", "origin/main"])).stdout.trim();
      yield* runGit(repoDir, ["push", "origin", `${squashSha}:refs/heads/release`]);
      yield* runGit(repoDir, ["push", "--force", "origin", `${initialSha}:refs/heads/main`]);
      yield* runGit(repoDir, ["fetch", "origin"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [[{ ...squashMergedPr(branch, headSha), baseRefName: "release" }]],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect(status.aheadOfDefaultCount).toBe(1);
    }),
  );
  it.effect("status keeps a squash-merged branch shipped when a later PR lookup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/squash-lookup-fails";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      yield* runGit(repoDir, ["push", "origin", "--delete", branch]);
      yield* runGit(repoDir, ["fetch", "--prune", "origin"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [[squashMergedPr(branch, headSha)]],
          failWith: "Rate limited",
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.aheadOfDefaultCount).toBe(0);
      expect(second.pr?.state).toBe("merged");
      expect({
        aheadCount: second.aheadCount,
        aheadOfDefaultCount: second.aheadOfDefaultCount,
      }).toEqual({ aheadCount: 0, aheadOfDefaultCount: 0 });
    }),
  );
  it.effect("status keeps real divergence for a squash-merged branch that tracks its base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const branch = "feature/squash-tracks-main";
      const headSha = yield* squashMergeIntoRemoteMain(repoDir, branch);
      yield* runGit(repoDir, ["fetch", "origin"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "origin/main"]);

      const { manager } = yield* makeManager({
        providerScenario: { prListSequence: [[squashMergedPr(branch, headSha)]] },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect({ aheadCount: status.aheadCount, behindCount: status.behindCount }).toEqual({
        aheadCount: 1,
        behindCount: 1,
      });
    }),
  );
  it.effect("status reports nothing to ship after a squash merge into a non-origin default", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["branch", "-m", "develop"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "upstream", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "develop"]);
      yield* runGit(repoDir, ["remote", "set-head", "upstream", "develop"]);
      const branch = "feature/squash-develop";
      yield* runGit(repoDir, ["checkout", "-b", branch]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "squash.txt"), "one\ntwo\n");
      yield* runGit(repoDir, ["add", "squash.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature work"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", branch]);
      const headSha = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      const squash = yield* runGit(repoDir, [
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "upstream/develop",
        "-m",
        "Feature work (#217)",
      ]);
      yield* runGit(repoDir, ["push", "upstream", `${squash.stdout.trim()}:refs/heads/develop`]);
      yield* runGit(repoDir, ["fetch", "upstream"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [[{ ...squashMergedPr(branch, headSha), baseRefName: "develop" }]],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.state).toBe("merged");
      expect({
        aheadCount: status.aheadCount,
        aheadOfDefaultCount: status.aheadOfDefaultCount,
      }).toEqual({ aheadCount: 0, aheadOfDefaultCount: 0 });
    }),
  );
});
