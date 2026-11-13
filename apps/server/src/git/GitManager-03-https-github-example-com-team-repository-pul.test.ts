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

import { listed, listedSelectors, makeTempDir, runGit, initRepo, createBareRemote, configureRemote, configureVisibleRemoteUrlWithLocalRewrite, makeManager, layerGitManagerTest } from "./GitManager-fixtures.testkit.ts";
import type { FakeChangeRequest } from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.each([
    [
      "https://github.example.com/team/repository/pull/42?tab=files",
      "github.example.com/team/repository",
    ],
    [
      "https://gitlab.example.com/group/subgroup/repository/-/merge_requests/42",
      "gitlab.example.com/group/subgroup/repository",
    ],
    ["https://bitbucket.org/team/repository/pull-requests/42", "bitbucket.org/team/repository"],
    ["https://codeberg.org/team/repository/pulls/42", "codeberg.org/team/repository"],
    [
      "http://code.example:3000/forgejo/team/repository/pulls/42/files",
      "code.example/forgejo/team/repository",
    ],
    [
      "https://dev.azure.com/org/project/_git/repository/pullrequest/42",
      "dev.azure.com/org/project/_git/repository",
    ],
    [
      "https://org.visualstudio.com/project/_git/repository/pullrequest/42",
      "org.visualstudio.com/project/_git/repository",
    ],
    [
      "https://gitlab.example/group/pull/123/repository/-/merge_requests/42",
      "gitlab.example/group/pull/123/repository",
    ],
    ["https://github.example.com/team/repository/issues/42", null],
  ] as const)("reads the repository from the returned PR URL %s", (url, expected) => {
    expect(GitManager.pullRequestRepositoryKey(url)).toBe(expected);
  });
  it.effect("distinguishes Enterprise forks with the same head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature"]);
      yield* runGit(repoDir, ["push", "-u", "fork", "feature"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.example.com:team/repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.example.com:alice/repository.git",
        forkDir,
      );
      const output: FakeChangeRequest[] = [
        {
          number: 2,
          title: "Another fork",
          url: "https://github.example.com/team/repository/pull/2",
          baseRefName: "main",
          headRefName: "feature",
          state: "open",
          updatedAt: "2026-04-08T15:00:00Z",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "bob/repository",
          headRepositoryOwnerLogin: "bob",
        },
        {
          number: 1,
          title: "This fork",
          url: "https://github.example.com/team/repository/pull/1",
          baseRefName: "main",
          headRefName: "feature",
          state: "open",
          updatedAt: "2026-04-07T15:00:00Z",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "alice/repository",
          headRepositoryOwnerLogin: "alice",
        },
      ];
      const { manager } = yield* makeManager({
        providerScenario: {
          prListByHeadSelector: {
            feature: output,
          },
        },
      });
      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature" })).toMatchObject({
        number: 1,
        repositoryKey: "github.example.com/team/repository",
      });
    }),
  );
  it.effect.each([
    { remoteUrl: "git@gitlab.com:Group/Subgroup/Fork.git", setUpstream: true },
    { remoteUrl: "git@gitlab.com:Group/Subgroup/Fork.git", setUpstream: false },
    { remoteUrl: "https://gitlab.com/Group/Subgroup/Fork.git", setUpstream: true },
    { remoteUrl: "https://gitlab.com/Group/Subgroup/Fork.git", setUpstream: false },
  ] as const)(
    "matches nested-group forks for $remoteUrl/$setUpstream",
    ({ remoteUrl, setUpstream }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        const branch = "feature/NestedGroups";
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", branch]);
        yield* runGit(repoDir, ["push", ...(setUpstream ? ["-u"] : []), "fork", branch]);
        const upstream = yield* runGit(repoDir, [
          "for-each-ref",
          "--format=%(upstream:short)",
          `refs/heads/${branch}`,
        ]);
        expect(upstream.stdout.trim()).toBe(setUpstream ? `fork/${branch}` : "");
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@gitlab.com:Group/Upstream/Repository.git",
          originDir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(repoDir, "fork", remoteUrl, forkDir);
        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            kind: "gitlab",
            headBranchProbe: null,
            prListOtherwise: [
              {
                number: 2,
                title: "Another subgroup's fork",
                url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/2",
                baseRefName: "main",
                headRefName: branch,
                updatedAt: "2026-04-08T15:00:00Z",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "Group/Other/Fork",
                headRepositoryOwnerLogin: "Group",
              },
              {
                number: 1,
                title: "This subgroup's fork",
                url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/1",
                baseRefName: "main",
                headRefName: branch,
                updatedAt: "2026-04-07T15:00:00Z",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "Group/Subgroup/Fork",
                headRepositoryOwnerLogin: "Group",
              },
            ],
          },
        });

        expect(yield* manager.branchPullRequest({ cwd: repoDir, branch })).toMatchObject({
          number: 1,
          repositoryKey: "gitlab.com/group/upstream/repository",
        });
        expect(listed(providerCalls).length).toBeGreaterThan(0);
        for (const call of listed(providerCalls)) {
          expect(call.headSelector.endsWith(branch)).toBe(true);
          expect(call.state).toBe("all");
        }
      }),
  );
  it.effect(
    "status ignores unrelated fork PRs when the current branch tracks the same repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

        const { manager } = yield* makeManager({
          providerScenario: {
            prListSequence: [
              [
                {
                  number: 1661,
                  title: "Fork PR from main",
                  url: "https://github.com/pingdotgg/t3code/pull/1661",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "open",
                  updatedAt: "2026-04-01T15:00:00Z",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "lnieuwenhuis/t3code",
                  headRepositoryOwnerLogin: "lnieuwenhuis",
                },
              ],
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("main");
        expect(status.pr).toBeNull();
      }),
  );
  it.effect("status detects cross-repo PRs from the upstream remote URL owner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      // Origin is the base repository; a lone remote would be the base itself.
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
      yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork-pr.txt"), "fork pr\n");
      yield* runGit(repoDir, ["add", "fork-pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
      yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-488/statemachine"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork-seed",
        "git@github.com:jasonLaster/codething-mvp.git",
        forkDir,
      );

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 488,
                title: "Rebase this PR on latest main",
                url: "https://github.com/pingdotgg/codething-mvp/pull/488",
                baseRefName: "main",
                headRefName: "statemachine",
                state: "open",
                updatedAt: "2026-03-10T07:00:00Z",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "jasonLaster/codething-mvp",
                headRepositoryOwnerLogin: "jasonLaster",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("t3code/pr-488/statemachine");
      expect(status.pr).toEqual({
        number: 488,
        title: "Rebase this PR on latest main",
        url: "https://github.com/pingdotgg/codething-mvp/pull/488",
        baseRef: "main",
        headRef: "statemachine",
        state: "open",
        updatedAt: "2026-03-10T07:00:00.000Z",
      });
      expect(providerCalls).toContainEqual({
        operation: "listChangeRequests",
        headSelector: "statemachine",
        state: "all",
        limit: 100,
      });
    }),
  );
  it.effect("status preserves a fork PR whose head is named after the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["push", "fork-seed", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-777/main"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/main"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork-seed",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListByHeadSelector: {
            main: [
              {
                number: 777,
                title: "Fork PR from main",
                url: "https://github.com/pingdotgg/codething-mvp/pull/777",
                baseRefName: "main",
                headRefName: "main",
                state: "open",
                updatedAt: "2026-03-10T07:00:00Z",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "contributor/codething-mvp",
                headRepositoryOwnerLogin: "contributor",
              },
            ],
          },
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("t3code/pr-777/main");
      expect(status.pr).toEqual({
        number: 777,
        title: "Fork PR from main",
        url: "https://github.com/pingdotgg/codething-mvp/pull/777",
        baseRef: "main",
        headRef: "main",
        state: "open",
        updatedAt: "2026-03-10T07:00:00.000Z",
      });
      expect(providerCalls).toContainEqual({
        operation: "listChangeRequests",
        headSelector: "main",
        state: "all",
        limit: 100,
      });
    }),
  );
  it.effect(
    "status ignores synthetic local branch aliases when the upstream remote name contains slashes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "my-org/upstream",
          "ssh://git@github.com/pingdotgg/codething-mvp.git",
          upstreamDir,
        );
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);

        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            prListByHeadSelector: {
              "effect-atom": [
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                  state: "open",
                  updatedAt: "2026-03-01T10:00:00Z",
                },
              ],
              "upstream/effect-atom": [
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "open",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ],
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("upstream/effect-atom");
        expect(status.pr).toEqual({
          number: 1618,
          title: "Correct PR",
          url: "https://github.com/pingdotgg/t3code/pull/1618",
          baseRef: "main",
          headRef: "effect-atom",
          state: "open",
          updatedAt: "2026-03-01T10:00:00.000Z",
        });
        expect(listedSelectors(providerCalls).includes("upstream/effect-atom")).toBe(false);
        expect(listedSelectors(providerCalls).includes("pingdotgg:upstream/effect-atom")).toBe(
          false,
        );
        expect(
          listedSelectors(providerCalls).includes("my-org/upstream:upstream/effect-atom"),
        ).toBe(false);
      }),
  );
  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 23,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/23",
                baseRefName: "feature/status-default-branch-target",
                headRefName: "main",
                state: "merged",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("main");
      expect(status.pr).toBeNull();
    }),
  );
  it.effect("status does not inherit a merged PR from a feature branch's default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/from-main", "origin/main"]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 54,
                title: "Reverse merge from main",
                url: "https://github.com/pingdotgg/codething-mvp/pull/54",
                baseRefName: "je-filter-list",
                headRefName: "main",
                state: "merged",
                mergedAt: "2023-09-28T03:21:10Z",
                updatedAt: "2023-09-28T03:21:10Z",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/from-main");
      expect(status.pr).toBeNull();
      expect(listed(providerCalls).length > 0).toBe(false);
    }),
  );
  it.effect("status finds a PR pushed under the branch's own name despite a default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-plain", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-plain"]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListByHeadSelector: {
            "feature/pushed-plain": [
              {
                number: 88,
                title: "Pushed without -u",
                url: "https://github.com/pingdotgg/codething-mvp/pull/88",
                baseRefName: "main",
                headRefName: "feature/pushed-plain",
                state: "open",
                updatedAt: "2026-05-01T10:00:00Z",
              },
            ],
          },
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/pushed-plain");
      expect(status.pr?.number).toBe(88);
      expect(listedSelectors(providerCalls).includes("main")).toBe(false);
    }),
  );
  it.effect(
    "status finds a fork PR pushed under the branch's own name despite a default upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
        yield* runGit(repoDir, ["checkout", "-b", "feature/fork-plain", "origin/main"]);
        yield* runGit(repoDir, ["push", "team/fork", "feature/fork-plain"]);
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
              "feature/fork-plain": [
                {
                  number: 89,
                  title: "Fork PR pushed without -u",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/89",
                  baseRefName: "main",
                  headRefName: "feature/fork-plain",
                  state: "open",
                  updatedAt: "2026-05-01T10:00:00Z",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "contributor/codething-mvp",
                  headRepositoryOwnerLogin: "contributor",
                },
              ],
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.pr?.number).toBe(89);
        expect(listedSelectors(providerCalls).includes("feature/fork-plain")).toBe(true);
        expect(
          listedSelectors(providerCalls).some((selector) => selector.startsWith("contributor:")),
        ).toBe(false);
        expect(listedSelectors(providerCalls).includes("main")).toBe(false);
      }),
  );
  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "merged",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "open",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ],
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/46",
        baseRef: "main",
        headRef: "feature/status-open-over-merged",
        state: "open",
        updatedAt: "2026-01-30T10:00:00.000Z",
      });
    }),
  );
  it.effect("status keeps the last known PR when a later lookup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-sticky"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-sticky"]);

      const existingPr = {
        number: 214,
        title: "Sticky PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/214",
        baseRefName: "main",
        headRefName: "feature/pr-sticky",
      };
      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [[existingPr]],
          failWith: "The host is signed out.",
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(214);

      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(214);
    }),
  );
});
