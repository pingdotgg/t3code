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
  createFakeSourceControlProvider,
  runStackedAction,
  makeManager,
  layerGitManagerTest,
} from "./GitManager-fixtures.testkit.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect("create_pr targets the remote default branch when it is not main", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:master"]);
      yield* runGit(repoDir, ["fetch", "origin"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "master"]);

      yield* runGit(repoDir, ["checkout", "-b", "feature/master-default"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "master-default.txt"), "master default\n");
      yield* runGit(repoDir, ["add", "master-default.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Master default"]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          // Mirrors a provider that cannot report a default branch, as the Azure
          // DevOps CLI does when it cannot detect the repository.
          defaultBranch: "",
          prListSequence: [
            [],
            [
              {
                number: 505,
                title: "Master default",
                url: "https://github.com/pingdotgg/codething-mvp/pull/505",
                baseRefName: "master",
                headRefName: "feature/master-default",
              },
            ],
          ],
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(
        created(providerCalls).some(
          (call) => call.baseRefName === "master" && call.headSelector === "feature/master-default",
        ),
      ).toBe(true);
    }),
  );
  it.effect("create_pr reports a created PR when the lookup after creation fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/lookup-after-create"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "lookup.txt"), "lookup\n");
      yield* runGit(repoDir, ["add", "lookup.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Lookup after create"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/lookup-after-create"]);

      const { service: github } = createFakeSourceControlProvider();
      let created = false;
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...github,
          createChangeRequest: (input) =>
            github.createChangeRequest(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  created = true;
                }),
              ),
            ),
          listChangeRequests: (input) =>
            created
              ? Effect.fail(
                  new SourceControlProviderFailure({
                    provider: github.kind,
                    operation: "listChangeRequests",
                    cwd: input.cwd,
                    detail: "GitHub API rate limit exceeded.",
                  }),
                )
              : github.listChangeRequests(input),
        },
      });

      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "create_pr" });

      expect(created).toBe(true);
      expect(result.pr).toMatchObject({
        status: "created",
        headBranch: "feature/lookup-after-create",
      });
      expect(result.pr.url).toBeUndefined();
    }),
  );
  it.effect("returns existing PR metadata for commit/push/pr action", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 42,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/existing-pr",
              },
            ],
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(42);
      expect(result.toast).toEqual({
        title: "Opened PR #42",
        description: "Existing PR",
        cta: {
          kind: "open_pr",
          label: "View PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        },
      });
      expect(providerCalls.some((call) => call.operation === "getChangeRequest")).toBe(false);
    }),
  );
  it.effect("matches a host's mounted heads without confusing forks sharing a branch", () =>
    Effect.sync(() => {
      // A host that serves repositories below a mount names them without it.
      const repositoryNameFromRemoteUrl = (url: string) =>
        url.replace(/^https:\/\/[^/]+\/forgejo\//u, "").replace(/\.git$/u, "");
      for (const owner of ["maria", "reviewer"]) {
        const pr = {
          number: 42,
          title: "Greeting",
          url: "https://forgejo.example/forgejo/maria/project/pulls/42",
          baseRefName: "main",
          headRefName: "greeting",
          state: "open" as const,
          isDraft: false,
          closedAt: null,
          mergedAt: null,
          updatedAt: Option.none(),
          isCrossRepository: owner !== "maria",
          headRepositoryNameWithOwner: `${owner}/project`,
          headRepositoryOwnerLogin: owner,
        };
        const repository = GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          `https://forgejo.example/forgejo/${owner}/project.git`,
          { repositoryNameFromRemoteUrl },
        );
        expect(repository).toBe(`${owner}/project`);
        const context = {
          headBranch: "greeting",
          headRepositoryNameWithOwner: repository,
          headRepositoryOwnerLogin: repository?.split("/")[0] ?? null,
          isCrossRepository: owner !== "maria",
        };
        expect(GitManager.matchesBranchHeadContext(pr, context)).toBe(true);
        expect(
          GitManager.matchesBranchHeadContext(pr, {
            ...context,
            headRepositoryNameWithOwner: "other/project",
            headRepositoryOwnerLogin: "other",
          }),
        ).toBe(false);
      }
      expect(
        GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          "https://gitlab.example/group/maria/project.git",
          {},
        ),
      ).toBe("group/maria/project");
    }),
  );
  it.effect("rejects same-repo PR metadata when matching a cross-repo head context", () =>
    Effect.sync(() => {
      const headContext = {
        headBranch: "statemachine",
        headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
        headRepositoryOwnerLogin: "pingdotgg",
        isCrossRepository: true,
      };

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 41,
            title: "Same-repo PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/41",
            baseRefName: "main",
            headRefName: "statemachine",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: false,
            headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
            headRepositoryOwnerLogin: "pingdotgg",
          },
          headContext,
        ),
      ).toBe(false);

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 142,
            title: "Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/142",
            baseRefName: "main",
            headRefName: "statemachine",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: true,
            headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
            headRepositoryOwnerLogin: "pingdotgg",
          },
          headContext,
        ),
      ).toBe(true);
    }),
  );
  it.effect("accepts fork PR metadata when origin is the fork checkout remote", () =>
    Effect.sync(() => {
      const headContext = {
        headBranch: "t3code/git-audit-stability",
        headRepositoryNameWithOwner: "justsomelegs/t3code",
        headRepositoryOwnerLogin: "justsomelegs",
        isCrossRepository: false,
      };

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 2284,
            title: "Improve branch mismatch warnings",
            url: "https://github.com/pingdotgg/t3code/pull/2284",
            baseRefName: "main",
            headRefName: "t3code/git-audit-stability",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: true,
            headRepositoryNameWithOwner: "justsomelegs/t3code",
            headRepositoryOwnerLogin: "justsomelegs",
          },
          headContext,
        ),
      ).toBe(true);
    }),
  );
  it.effect("create_pr sends bounded checks to the model and omits rolled-back runs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/thread-context"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "thread-context.txt"), "context\n");
      yield* runGit(repoDir, ["add", "thread-context.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Thread context"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const threadId = ThreadId.make("thread:pr-thread-context");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const createdAt = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
      const run = (ordinal: number, status: "completed" | "rolled_back") => ({
        id: RunId.make(`run:pr-thread-context:${ordinal}`),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:pr-thread-context:${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        checkpointId: null,
        contextHandoffId: null,
      });
      const itemBase = (ordinal: number, runId: RunId) => ({
        id: TurnItemId.make(`item:pr-thread-context:${ordinal}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: createdAt,
        completedAt: createdAt,
        updatedAt: createdAt,
      });
      let generatedThreadContext: string | undefined;
      let generatedPrompt = "";
      const writer = fromRunner("test", (request) => {
        generatedPrompt = request.prompt;
        return decodeJsonReply(request, "test", '{"title":"Thread context","body":"Body"}');
      });

      const { manager } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedThreadContext = input.threadContext;
            return writer.generatePrContent(input);
          },
        },
        seed: Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const completedRun = run(1, "completed");
          const abandonedRun = run(2, "rolled_back");
          yield* store.apply({
            id: EventId.make("event:pr-thread-context:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project:pr-thread-context"),
              title: "PR thread context",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: repoDir,
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: threadId,
              },
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          for (const payload of [completedRun, abandonedRun]) {
            yield* store.apply({
              id: EventId.make(`event:pr-thread-context:run:${payload.ordinal}`),
              type: "run.updated",
              threadId,
              runId: payload.id,
              occurredAt: createdAt,
              payload,
            });
          }
          const items = [
            {
              ...itemBase(1, completedRun.id),
              type: "user_message" as const,
              messageId: completedRun.userMessageId,
              createdBy: "user" as const,
              creationSource: "web" as const,
              inputIntent: "turn_start" as const,
              text: "Make the PR writer see the thread",
              attachments: [],
            },
            {
              ...itemBase(3, completedRun.id),
              type: "command_execution" as const,
              input: "vp test run",
              output: `${"collecting tests\n".repeat(4_000)}Tests 12 passed`,
              exitCode: 0,
            },
            {
              ...itemBase(4, completedRun.id),
              type: "command_execution" as const,
              input: "vp lint",
              output: "2 lint errors",
              exitCode: 1,
            },
            {
              ...itemBase(5, abandonedRun.id),
              type: "command_execution" as const,
              input: "vp run abandoned",
              output: "abandoned output",
              exitCode: 0,
            },
          ];
          for (const payload of items) {
            yield* store.apply({
              id: EventId.make(`event:pr-thread-context:${payload.id}`),
              type: "turn-item.updated",
              threadId,
              runId: payload.runId,
              occurredAt: createdAt,
              payload,
            });
          }
        }),
      });

      yield* manager.runStackedAction({
        actionId: "test-action-id",
        cwd: repoDir,
        action: "create_pr",
        threadId,
      });

      expect(generatedPrompt).toContain("Command: vp test run\nExit code: 0");
      expect(generatedPrompt).toContain("Tests 12 passed");
      expect(generatedPrompt).toContain("Make the PR writer see the thread");
      expect(generatedPrompt).toContain("Command: vp lint\nExit code: 1");
      expect(generatedPrompt).toContain("2 lint errors");
      expect(generatedPrompt).not.toContain("vp run abandoned");
      expect(generatedPrompt).not.toContain("abandoned output");
      expect(Buffer.byteLength(generatedThreadContext ?? "")).toBeLessThanOrEqual(16_000);
    }),
  );
  it.effect.each(["commit", "short-commit", "tag", "revision"] as const)(
    "creates a PR against the default branch with a legacy %s base setting",
    (kind) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", "main", "trunk"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "trunk"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/legacy-base"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");
        yield* runGit(repoDir, ["add", "feature.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
        const commit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["tag", "v1"]);
        const baseRef =
          kind === "commit"
            ? commit
            : kind === "short-commit"
              ? commit.slice(0, 12)
              : kind === "tag"
                ? "v1"
                : "HEAD~0";
        yield* runGit(repoDir, ["config", "branch.feature/legacy-base.gh-merge-base", baseRef]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/legacy-base"]);
        let generatedBase = "";
        let generatedSummary = "";
        const { manager, providerCalls } = yield* makeManager({
          providerScenario: { defaultBranch: "trunk", prListSequence: [[], []] },
          textGeneration: {
            generatePrContent: (input) => {
              generatedBase = input.baseBranch;
              generatedSummary = input.commitSummary;
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });

        const result = yield* runStackedAction(manager, { cwd: repoDir, action: "create_pr" });

        expect(result.pr.status).toBe("created");
        expect(generatedBase).toBe("trunk");
        expect(generatedSummary).toContain("Feature commit");
        expect(
          created(providerCalls).some(
            (call) => call.baseRefName === "trunk" && call.headSelector === "feature/legacy-base",
          ),
        ).toBe(true);
      }),
  );
  it.effect("generates PR content from the created worktree's selected remote base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const upstreamDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "upstream", upstreamDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fork-release"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork-only work\n");
      NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".github/pull_request_template.md"),
        "Fork template",
      );
      yield* runGit(repoDir, ["add", "."]);
      yield* runGit(repoDir, ["commit", "-m", "Fork release commit"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/heads/release"]);
      yield* runGit(repoDir, ["checkout", "-b", "stable", "main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "upstream.txt"), "upstream-only work\n");
      NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".github/pull_request_template.md"),
        "Upstream template",
      );
      yield* runGit(repoDir, ["add", "."]);
      yield* runGit(repoDir, ["commit", "-m", "Upstream release commit"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "stable:release"]);
      yield* runGit(repoDir, ["branch", "upstream/release", "fork-release"]);

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd: repoDir, refName: "stable" });
      expect(fetched).not.toBeNull();
      const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
      yield* driver.createWorktree({
        cwd: repoDir,
        path: worktreePath,
        refName: fetched!.commitSha,
        newRefName: "feature/from-upstream",
        baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
      });
      NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature work\n");
      yield* runGit(worktreePath, ["add", "feature.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);
      yield* runGit(worktreePath, ["push", "-u", "origin", "feature/from-upstream"]);

      const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
      const { manager, providerCalls } = yield* makeManager({
        providerScenario: { prListSequence: [[], []] },
        textGeneration: {
          generatePrContent: (input) => {
            generatedInputs.push(input);
            return Effect.succeed({ title: "Feature PR", body: "Feature body" });
          },
        },
      });
      const result = yield* runStackedAction(manager, { cwd: worktreePath, action: "create_pr" });

      expect(result.pr.status).toBe("created");
      expect(generatedInputs).toHaveLength(1);
      const generated = generatedInputs[0]!;
      expect.soft(generated.commitSummary).toContain("Feature commit");
      expect.soft(generated.commitSummary).not.toContain("Upstream release commit");
      expect.soft(generated.commitSummary).not.toContain("Fork release commit");
      expect.soft(generated.diffSummary).toContain("feature.txt");
      expect.soft(generated.diffSummary).not.toContain("upstream.txt");
      expect.soft(generated.diffSummary).not.toContain("fork.txt");
      expect.soft(generated.diffPatch).toContain("+feature work");
      expect.soft(generated.diffPatch).not.toContain("upstream-only work");
      expect.soft(generated.diffPatch).not.toContain("fork-only work");
      expect.soft(generated.changeRequestTemplate).toBe("Upstream template");
      expect(
        created(providerCalls).some(
          (call) => call.baseRefName === "release" && call.headSelector === "feature/from-upstream",
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "preserves a local worktree PR base that shadows a remote ref, including legacy bases",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["remote", "add", "upstream", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "-b", "release"]);
        NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
        NodeFS.writeFileSync(NodePath.join(repoDir, "remote.txt"), "remote-only work\n");
        NodeFS.writeFileSync(
          NodePath.join(repoDir, ".github/pull_request_template.md"),
          "Remote release template",
        );
        yield* runGit(repoDir, ["add", "."]);
        yield* runGit(repoDir, ["commit", "-m", "Remote release commit"]);
        yield* runGit(repoDir, ["push", "upstream", "release"]);

        yield* runGit(repoDir, ["checkout", "-b", "upstream/release", "main"]);
        NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
        NodeFS.writeFileSync(NodePath.join(repoDir, "local.txt"), "local-base work\n");
        NodeFS.writeFileSync(
          NodePath.join(repoDir, ".github/pull_request_template.md"),
          "Local branch template",
        );
        yield* runGit(repoDir, ["add", "."]);
        yield* runGit(repoDir, ["commit", "-m", "Local base commit"]);
        yield* runGit(repoDir, ["push", "upstream", "refs/heads/upstream/release"]);
        yield* runGit(repoDir, ["push", "origin", "refs/heads/upstream/release"]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd: repoDir,
          path: worktreePath,
          refName: "refs/heads/upstream/release",
          newRefName: "feature/from-local",
          baseRefName: "refs/heads/upstream/release",
        });
        NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature work\n");
        yield* runGit(worktreePath, ["add", "feature.txt"]);
        yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/from-local"]);

        const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
        const { manager, providerCalls } = yield* makeManager({
          providerScenario: { prListSequence: [[], [], [], []] },
          textGeneration: {
            generatePrContent: (input) => {
              generatedInputs.push(input);
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });
        const result = yield* runStackedAction(manager, { cwd: worktreePath, action: "create_pr" });
        expect(result.pr.status).toBe("created");

        // A branch created outside T3 has only gh's legacy short base setting.
        yield* runGit(worktreePath, ["checkout", "-b", "feature/legacy-local-base"]);
        yield* runGit(worktreePath, [
          "config",
          "branch.feature/legacy-local-base.gh-merge-base",
          "upstream/release",
        ]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/legacy-local-base"]);
        const legacyResult = yield* runStackedAction(manager, {
          cwd: worktreePath,
          action: "create_pr",
        });
        expect(legacyResult.pr.status).toBe("created");
        expect(generatedInputs).toHaveLength(2);
        for (const generated of generatedInputs) {
          expect.soft(generated.baseBranch).toBe("upstream/release");
          expect.soft(generated.commitSummary.trim()).toMatch(/^[a-f0-9]+ Feature commit$/);
          expect.soft(generated.diffSummary).toContain("feature.txt");
          expect.soft(generated.diffSummary).toContain("1 file changed, 1 insertion(+)");
          expect.soft(generated.diffPatch).toContain("+feature work");
          expect.soft(generated.diffPatch).not.toContain("local-base work");
          expect.soft(generated.diffPatch).not.toContain("remote-only work");
          expect.soft(generated.diffPatch).not.toContain("pull_request_template.md");
          expect.soft(generated.changeRequestTemplate).toBe("Local branch template");
        }
        expect.soft(created(providerCalls)).toEqual([
          { baseRefName: "upstream/release", headSelector: "feature/from-local" },
          { baseRefName: "upstream/release", headSelector: "feature/legacy-local-base" },
        ]);
      }),
  );
});
