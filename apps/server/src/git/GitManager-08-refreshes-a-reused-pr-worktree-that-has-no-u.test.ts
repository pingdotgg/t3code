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
  created,
  makeTempDir,
  runGit,
  initRepo,
  createBareRemote,
  runStackedAction,
  preparePullRequestThread,
  makeManager,
  asThreadId,
  layerGitManagerTest,
} from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect("refreshes a reused PR worktree that has no upstream from the pull request ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-ref-only"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "ref-only.txt"), "ref only\n");
      yield* runGit(repoDir, ["add", "ref-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Pull ref only PR branch"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/90/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-ref-only"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 90,
            title: "Pull ref only PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/90",
            baseRefName: "main",
            headRefName: "feature/pr-ref-only",
            state: "open",
          },
        },
      });

      const created = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "90",
        mode: "worktree",
      });
      const worktreePath = created.worktreePath as string;
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"], true)).exitCode,
      ).not.toBe(0);

      yield* runGit(repoDir, ["fetch", "origin", "refs/pull/90/head"]);
      yield* runGit(repoDir, ["checkout", "-b", "ref-only-author", "FETCH_HEAD"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "ref-only.txt"), "ref only again\n");
      yield* runGit(repoDir, ["add", "ref-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New pull ref head"]);
      yield* runGit(repoDir, ["push", "origin", "ref-only-author:refs/pull/90/head"]);
      const updatedHead = (yield* runGit(repoDir, ["rev-parse", "ref-only-author"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "90",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.isOnPullRequestHead).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(updatedHead);
    }),
  );
  it.effect("creates a merge request worktree from the host's own head ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/mr-ref-only"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "mr.txt"), "merge request\n");
      yield* runGit(repoDir, ["add", "mr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Merge request ref only"]);
      const head = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/merge-requests/93/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/mr-ref-only"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          kind: "gitlab",
          pullRequest: {
            number: 93,
            title: "Merge request ref only",
            url: "https://gitlab.com/pingdotgg/codething-mvp/-/merge_requests/93",
            baseRefName: "main",
            headRefName: "feature/mr-ref-only",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "93",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(true);
      expect(
        (yield* runGit(result.worktreePath as string, ["rev-parse", "HEAD"])).stdout.trim(),
      ).toBe(head);
    }),
  );
  it.effect("preserves an unrelated local branch and upstream that share the fork head name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fork-main-collision"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "contributor.txt"), "contributor\n");
      yield* runGit(repoDir, ["add", "contributor.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Contributor commit on the fork main"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-collision:main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/root-work", "main"]);
      const mainWorktreePath = NodePath.join(
        repoDir,
        "..",
        `local-main-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", mainWorktreePath, "main"]);
      const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
      // Leave the fork tracking ref stale so an unnecessary fetch would change it.
      yield* runGit(repoDir, ["update-ref", "refs/remotes/fork-seed/main", localMainBefore]);
      const trackingRefsBefore = (yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
      ])).stdout;

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 94,
            title: "Fork main collision PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/94",
            baseRefName: "main",
            headRefName: "main",
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
        reference: "94",
        mode: "worktree",
        threadId: asThreadId("thread-pr-fork-main-collision"),
      });

      expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(localMainBefore);
      expect((yield* runGit(mainWorktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        localMainBefore,
      );
      expect(NodeFS.existsSync(NodePath.join(mainWorktreePath, "contributor.txt"))).toBe(false);
      expect(
        (yield* runGit(mainWorktreePath, [
          "rev-parse",
          "--abbrev-ref",
          "@{upstream}",
        ])).stdout.trim(),
      ).toBe("origin/main");
      expect(result.branch).toBe("t3code/pr-94/main");
      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(mainWorktreePath),
      );
      expect(
        (yield* runGit(repoDir, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes",
        ])).stdout,
      ).toBe(trackingRefsBefore);
      expect((yield* runGit(mainWorktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
        "main",
      );
      expect(result.isOnPullRequestHead).toBe(false);
      expect(setupCalls).toHaveLength(0);

      yield* (yield* GitVcsDriver.GitVcsDriver).pullCurrentBranch(mainWorktreePath);
      expect((yield* runGit(mainWorktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        localMainBefore,
      );
    }),
  );
  it.effect("reuses an existing PR worktree and restores fork upstream tracking", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-fork"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-fork-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, [
        "worktree",
        "add",
        "-b",
        "t3code/pr-83/feature/pr-reused-fork",
        worktreePath,
        "feature/pr-reused-fork",
      ]);
      yield* runGit(worktreePath, ["branch", "--unset-upstream"], true);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 83,
            title: "Reused Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-reused-fork",
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
        reference: "83",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("t3code/pr-83/feature/pr-reused-fork");
      expect((yield* runGit(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
        result.branch,
      );
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-reused-fork");
    }),
  );
  it.effect("does not fail PR worktree prep when setup terminal startup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-setup-failure"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "setup-failure.txt"), "setup failure\n");
      yield* runGit(repoDir, ["add", "setup-failure.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR setup failure branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-setup-failure"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/184/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 184,
            title: "Setup failure PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/184",
            baseRefName: "main",
            headRefName: "feature/pr-setup-failure",
            state: "open",
          },
        },
        setupScriptRunner: {
          runForThread: (input) =>
            Effect.fail(
              new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                threadId: input.threadId,
                worktreePath: input.worktreePath,
                operation: "openTerminal",
                cause: new Error("terminal start failed"),
              }),
            ),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "184",
        mode: "worktree",
        threadId: asThreadId("thread-pr-setup-failure"),
      });

      expect(result.branch).toBe("feature/pr-setup-failure");
      expect(result.worktreePath).not.toBeNull();
      expect(NodeFS.existsSync(result.worktreePath as string)).toBe(true);
    }),
  );
  it.effect("rejects worktree prep when the PR head branch is checked out in the main repo", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-root-only"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 79,
            title: "Root-only PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/79",
            baseRefName: "main",
            headRefName: "feature/pr-root-only",
            state: "open",
          },
        },
      });

      const errorMessage = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "79",
        mode: "worktree",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("already checked out in the main repo");
    }),
  );
  it.effect("create_pr preserves dirty work on an already pushed branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-only-follow-up"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr-only.txt"), "pr only\n");
      yield* runGit(repoDir, ["add", "pr-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR only branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-only-follow-up"]);
      const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "staged readme\n");
      yield* runGit(repoDir, ["add", "README.md"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr-only.txt"), "unstaged feature work\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "untracked work\n");
      const statusBefore = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;
      const stagedBefore = (yield* runGit(repoDir, ["diff", "--cached"])).stdout;
      let generatedContent: TextGeneration.PrContentGenerationInput | undefined;

      const { manager } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedContent = input;
            return Effect.succeed({ title: "PR only branch", body: "Committed feature work" });
          },
        },
        providerScenario: {
          prListSequence: [
            [],
            [
              {
                number: 201,
                title: "PR only branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/201",
                baseRefName: "main",
                headRefName: "feature/pr-only-follow-up",
                state: "open",
                isCrossRepository: false,
              },
            ],
          ],
        },
      });
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "create_pr",
        },
        {
          actionId: "action-pr-only",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("created");
      expect(generatedContent?.diffPatch).toContain("+pr only");
      expect(generatedContent?.diffPatch).not.toContain("staged readme");
      expect(generatedContent?.diffPatch).not.toContain("unstaged feature work");
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
      expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout).toBe(statusBefore);
      expect((yield* runGit(repoDir, ["diff", "--cached"])).stdout).toBe(stagedBefore);
      expect(
        events.filter(
          (event): event is Extract<GitActionProgressEvent, { kind: "phase_started" }> =>
            event.kind === "phase_started",
        ),
      ).toEqual([
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Preparing PR...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Generating PR content...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Creating pull request...",
        }),
      ]);
    }),
  );
});
