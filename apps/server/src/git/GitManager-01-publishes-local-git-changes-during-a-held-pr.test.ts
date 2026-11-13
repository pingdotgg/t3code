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

import { listed, listedSelectors, makeTempDir, removePath, makeDirectory, runGit, initRepo, createBareRemote, configureRemote, configureVisibleRemoteUrlWithLocalRewrite, makeManager, layerGitManagerTest } from "./GitManager-fixtures.testkit.ts";
import type { FakeChangeRequest, FakeProviderScenario } from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect(
    "publishes local Git changes during a held PR lookup without caching its old branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-refresh-status-gh-gate-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "release"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "release"]);
        yield* runGit(repoDir, ["tag", "release"]);
        const oldPr = {
          number: 613,
          title: "Release PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/613",
          baseRefName: "main",
          headRefName: "release",
        };
        const newPr = { ...oldPr, number: 614, headRefName: "heads/release" };
        const providerScenario: FakeProviderScenario = {
          prListSequence: [oldPr, oldPr, newPr].map((pr) => [pr]),
        };
        const { manager } = yield* makeManager({ providerScenario });
        const context = yield* Layer.build(
          VcsStatusBroadcaster.layer.pipe(
            Layer.provide(
              GitWorkflowService.layer.pipe(
                Layer.provide(Layer.succeed(GitManager.GitManager, manager)),
                Layer.provide(
                  VcsDriverRegistry.layer.pipe(
                    Layer.provide(VcsProjectConfig.layer),
                    Layer.provide(VcsProcess.layer),
                  ),
                ),
              ),
            ),
            Layer.provide(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(true),
              }),
            ),
          ),
        );
        const broadcaster = Context.get(context, VcsStatusBroadcaster.VcsStatusBroadcaster);
        const initial = yield* broadcaster.getStatus({ cwd: repoDir });
        expect(initial.refName).toBe("release");
        expect(initial.pr?.number).toBe(613);

        const subscribed = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        yield* broadcaster.streamStatus({ cwd: repoDir, includeRemote: false }).pipe(
          Stream.runForEach((event) => {
            if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
            if (event._tag === "localUpdated" && event.local.hasWorkingTreeChanges) {
              return Deferred.succeed(published, undefined);
            }
            return Effect.void;
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        const gate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        providerScenario.prListGate = gate;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(NodePath.join(repoDir, "README.md"), "changed before refresh\n");
        const completed = yield* Deferred.make<void>();
        const refresh = yield* broadcaster
          .refreshStatus(repoDir)
          .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped);
        yield* Deferred.await(gate.started);
        const pending = Option.getOrThrow(
          yield* Stream.runHead(broadcaster.streamStatus({ cwd: repoDir, includeRemote: false })),
        );
        expect(pending._tag).toBe("snapshot");
        if (pending._tag === "snapshot") expect(pending.local.hasWorkingTreeChanges).toBe(true);
        yield* Deferred.await(published);
        expect(yield* Deferred.isDone(completed)).toBe(false);

        yield* runGit(repoDir, ["checkout", "-b", "heads/release"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "refs/heads/heads/release"]);
        yield* Deferred.succeed(gate.release, undefined);
        const refreshed = yield* Fiber.join(refresh);
        expect(refreshed.refName).toBe("heads/release");
        expect(refreshed.hasWorkingTreeChanges).toBe(true);
        expect(refreshed.pr).toBeNull();
        const snapshot = Option.getOrThrow(
          yield* Stream.runHead(broadcaster.streamStatus({ cwd: repoDir, includeRemote: false })),
        );
        expect(snapshot._tag).toBe("snapshot");
        if (snapshot._tag === "snapshot") expect(snapshot.remote).toBeNull();

        delete providerScenario.prListGate;
        const recovered = yield* broadcaster.getStatus({ cwd: repoDir });
        expect(recovered.refName).toBe("heads/release");
        expect(recovered.pr?.number).toBe(614);
        expect((yield* broadcaster.getStatus({ cwd: repoDir })).pr?.number).toBe(614);
      }),
  );
  it.effect("status reports the listed PR whose head is the branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-valid-pr-entry"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-valid-pr-entry"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 14,
                title: "Another branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/14",
                baseRefName: "main",
                headRefName: "feature/another-branch",
              },
              {
                number: 15,
                title: "Valid PR title",
                url: "https://github.com/pingdotgg/codething-mvp/pull/15",
                baseRefName: "main",
                headRefName: "feature/status-valid-pr-entry",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 15,
        title: "Valid PR title",
        url: "https://github.com/pingdotgg/codething-mvp/pull/15",
        baseRef: "main",
        headRef: "feature/status-valid-pr-entry",
        state: "open",
        updatedAt: null,
      });
    }),
  );
  it.effect("status reports the latest of a branch's closed and merged PRs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-lowercase-state"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-lowercase-state"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 16,
                title: "Closed PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/16",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "closed",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                number: 17,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/17",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 17,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/17",
        baseRef: "main",
        headRef: "feature/status-lowercase-state",
        state: "merged",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
    }),
  );
  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("t3code-git-manager-missing-dir-");
      const cwd = NodePath.join(rootDir, "deleted-repo");
      yield* makeDirectory(cwd);
      yield* removePath(cwd);
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }),
  );
  it.effect("a git read in flight during a T3 git action does not outlive it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/racing-upstream"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/racing-upstream"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/heads/feature/raced-head"]);
      const pullRequest = (number: number, headRefName: string): FakeChangeRequest[] => [
        {
          number,
          title: headRefName,
          url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
          baseRefName: "main",
          headRefName,
          state: "open",
          updatedAt: "2026-04-07T15:00:00Z",
        },
      ];
      const gate = {
        matches: (args: ReadonlyArray<string>) =>
          args[0] === "for-each-ref" && args.at(-1) === "refs/heads/feature/racing-upstream",
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const { manager } = yield* makeManager({
        gitSpawnGate: gate,
        providerScenario: {
          prListByHeadSelector: {
            "feature/racing-upstream": pullRequest(237, "feature/racing-upstream"),
            "feature/raced-head": pullRequest(238, "feature/raced-head"),
          },
        },
      });
      const lookup = manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/racing-upstream",
      });

      const inFlight = yield* Effect.forkChild(lookup);
      yield* Deferred.await(gate.reached);
      yield* runGit(repoDir, ["branch", "--set-upstream-to=origin/feature/raced-head"]);
      yield* manager.invalidateStatus(repoDir);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(inFlight);

      expect((yield* lookup)?.number).toBe(238);
    }),
  );
  it.effect("branch PR lookup notifies linked threads when draft status changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/draft-status"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/draft-status"]);
      const drafts = [false, true, true, false, false, true];
      const pullRequest: FakeChangeRequest = {
        number: 1,
        title: "Draft status",
        url: "https://github.com/pingdotgg/codething-mvp/pull/1",
        baseRefName: "main",
        headRefName: "feature/draft-status",
        state: "open",
      };
      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            ...drafts.map((isDraft) => [{ ...pullRequest, isDraft }]),
            [
              {
                ...pullRequest,
                number: 2,
                url: "https://github.com/pingdotgg/codething-mvp/pull/2",
                state: "merged",
              },
            ],
          ],
        },
      });
      const changes = yield* manager.subscribePullRequestStateChanges;
      for (const isDraft of drafts) {
        const pr = yield* manager.branchPullRequest(
          { cwd: repoDir, branch: "feature/draft-status" },
          { refresh: true },
        );
        expect(pr?.isDraft === true).toBe(isDraft);
      }
      // A different PR ends collection without waiting on a background stream consumer.
      yield* manager.branchPullRequest(
        { cwd: repoDir, branch: "feature/draft-status" },
        { refresh: true },
      );
      const events = yield* Stream.runCollect(
        changes.pipe(Stream.takeUntil((event) => event.number === 2, { excludeLast: true })),
      );
      expect(events).toEqual([
        { host: "github.com", repository: "pingdotgg/codething-mvp", number: 1 },
        { host: "github.com", repository: "pingdotgg/codething-mvp", number: 1 },
        { host: "github.com", repository: "pingdotgg/codething-mvp", number: 1 },
      ]);
    }),
  );
  it.effect("a settled branch PR is rechecked only when the branch moves or every 15 minutes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/settled"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/settled"]);
      const pullRequest = (number: number, state: "open" | "merged"): FakeChangeRequest => ({
        number,
        title: "Settled",
        url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
        baseRefName: "main",
        headRefName: "feature/settled",
        state,
        updatedAt: `2026-04-0${number}T15:00:00Z`,
      });
      const gitCommands: string[] = [];
      const { manager } = yield* makeManager({
        gitCommands,
        providerScenario: {
          prListSequence: [
            [pullRequest(1, "merged")],
            [pullRequest(1, "merged")],
            [pullRequest(1, "merged")],
          ],
          prListOtherwise: [pullRequest(2, "open")],
        },
      });
      const lookup = manager.branchPullRequest({ cwd: repoDir, branch: "feature/settled" });
      const freshLookups = () => gitCommands.filter((args) => args === "remote").length;

      expect((yield* lookup)?.state).toBe("merged");
      gitCommands.length = 0;
      expect((yield* lookup)?.state).toBe("merged");
      expect((yield* lookup)?.state).toBe("merged");
      expect(gitCommands.map((args) => args.split(" ", 1)[0]).toSorted()).toEqual([
        "config",
        "config",
        "for-each-ref",
        "for-each-ref",
      ]);
      expect(freshLookups()).toBe(0);

      NodeFS.writeFileSync(NodePath.join(repoDir, "settled.txt"), "new work\n");
      yield* runGit(repoDir, ["add", "settled.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New work"]);
      gitCommands.length = 0;
      expect((yield* lookup)?.state).toBe("merged");
      expect(freshLookups()).toBe(1);
      gitCommands.length = 0;
      yield* lookup;
      expect(freshLookups()).toBe(0);

      // Remembered git state expires after 5 minutes; that rereads git without a recheck.
      yield* TestClock.adjust("10 minutes");
      gitCommands.length = 0;
      expect((yield* lookup)?.state).toBe("merged");
      expect(freshLookups()).toBe(1);

      yield* TestClock.adjust("5 minutes");
      gitCommands.length = 0;
      expect((yield* lookup)?.state).toBe("merged");
      expect(freshLookups()).toBe(2);

      // A new PR from the reused branch shows on the next host query.
      yield* TestClock.adjust("5 minutes");
      expect((yield* lookup)?.number).toBe(2);
    }),
  );
  it.effect("branch PR lookup uses a saved tracked branch without changing checkout", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/saved-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/saved-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 216,
                title: "Saved branch PR",
                url: "https://github.com/pingdotgg/t3code/pull/216",
                baseRefName: "main",
                headRefName: "feature/saved-branch",
                headSha: "a".repeat(40),
                state: "open",
                updatedAt: "2026-04-03T15:00:00Z",
              },
            ],
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/saved-branch",
      });

      expect(pullRequest).toMatchObject({
        number: 216,
        title: "Saved branch PR",
        url: "https://github.com/pingdotgg/t3code/pull/216",
        baseRef: "main",
        headRef: "feature/saved-branch",
        headSha: "a".repeat(40),
        state: "open",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-03T15:00:00.000Z",
      });
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    }),
  );
  it.effect("branch PR lookup uses the default branch from a non-origin remote", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "upstream", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "develop"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "develop"]);
      yield* runGit(remoteDir, ["--git-dir=.", "symbolic-ref", "HEAD", "refs/heads/develop"]);
      yield* runGit(repoDir, ["remote", "set-head", "upstream", "develop"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 221,
                title: "Merged main PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/221",
                baseRefName: "develop",
                headRefName: "main",
                state: "merged",
                mergedAt: "2026-04-07T15:00:00Z",
                updatedAt: "2026-04-08T15:00:00Z",
              },
            ],
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({ cwd: repoDir, branch: "main" });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: "2026-04-07T15:00:00Z",
        updatedAt: "2026-04-08T15:00:00.000Z",
      });
    }),
  );
  it.effect("branch PR lookup uses the saved name after the local branch is deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["branch", "feature/deleted-local-branch/child"]);
      yield* runGit(repoDir, [
        "branch",
        "--set-upstream-to",
        "origin/main",
        "feature/deleted-local-branch/child",
      ]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 217,
                title: "Deleted local branch PR",
                url: "https://github.com/pingdotgg/t3code/pull/217",
                baseRefName: "main",
                headRefName: "feature/deleted-local-branch",
                state: "merged",
                updatedAt: "2026-04-04T15:00:00Z",
              },
            ],
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-local-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-04T15:00:00.000Z",
      });
      expect(listedSelectors(providerCalls).includes("feature/deleted-local-branch")).toBe(true);
    }),
  );
  it.effect("branch PR lookup recovers a deleted fork branch from its remote-tracking ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["push", "-u", "team/fork", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-fork-branch"]);
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

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListByHeadSelector: {
            "feature/deleted-fork-branch": [
              {
                number: 218,
                title: "Deleted fork branch PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/218",
                baseRefName: "main",
                headRefName: "feature/deleted-fork-branch",
                state: "merged",
                updatedAt: "2026-04-05T15:00:00Z",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "contributor/codething-mvp",
                headRepositoryOwnerLogin: "contributor",
              },
            ],
          },
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-fork-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-05T15:00:00.000Z",
      });
      expect(
        listed(providerCalls).some(
          (call) => call.headSelector === "feature/deleted-fork-branch" && call.state === "all",
        ),
      ).toBe(true);
      expect(
        listedSelectors(providerCalls).some((selector) => selector.startsWith("contributor:")),
      ).toBe(false);
    }),
  );
  it.effect("branch PR lookup rejects ambiguous deleted-branch remote refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "origin", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "fork", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/ambiguous-remote"]);
      const { manager, providerCalls } = yield* makeManager();

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/ambiguous-remote" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        detail: "Multiple remotes track feature/ambiguous-remote. Its pull request is ambiguous.",
      });
      expect(providerCalls).toHaveLength(0);
    }),
  );
});
