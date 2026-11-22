// @effect-diagnostics nodeBuiltinImport:off - the code index fixture is a temporary checkout.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  VcsProcessExitError,
  type OrchestrationV2ThreadShell,
  type Project,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as CodeIntelligence from "../project/knowledge/CodeIntelligence.ts";
import { indexRootFor } from "../project/knowledge/codeIndexLayout.ts";
import * as ModelEvaluations from "../modelEvaluations/ModelEvaluations.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as WorktreeBranches from "./WorktreeBranches.ts";

// Without a project the observer never touches enrichment, so its methods stay unimplemented.
const layerNoProject = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
);

it.effect("coalesces completed turns without starving later project refreshes", () => {
  const projectA = ProjectId.make("project-turn-refresh-a");
  const projectB = ProjectId.make("project-turn-refresh-b");
  const refreshed: ProjectId[] = [];
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProject,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
        Layer.mock(CodeIntelligence.CodeIntelligence)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurns: (projectIds) =>
            Effect.sync(() => {
              refreshed.push(...projectIds);
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* Effect.forEach(Array.from({ length: 20 }), () => observer.refreshAfterTurn(projectA));
    assert.deepEqual(refreshed, []);
    yield* TestClock.adjust("9 seconds");
    yield* observer.refreshAfterTurn(projectA);
    yield* observer.refreshAfterTurn(projectB);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(refreshed, [projectA, projectB]);

    // Continuous activity starts a new fixed window instead of postponing the last refresh.
    yield* observer.refreshAfterTurn(projectA);
    yield* TestClock.adjust("9 seconds");
    yield* observer.refreshAfterTurn(projectA);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(refreshed, [projectA, projectB, projectA]);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(refreshed, [projectA, projectB, projectA]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["workspace refresh", "evaluation enqueue", "branch sync"] as const)(
  "preserves completed checkpoint finalization when %s fails",
  (failure) => {
    const threadId = ThreadId.make("thread_refresh_failure");
    const runId = RunId.make("run_refresh_failure");
    const scopeId = CheckpointScopeId.make("scope_refresh_failure");
    const captured: string[] = [];
    const refreshed = Deferred.makeUnsafe<void>();
    const layer = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: () =>
              Effect.sync(() => {
                captured.push("checkpoint");
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [
                  {
                    id: runId,
                    threadId,
                    ordinal: 1,
                    providerInstanceId: ProviderInstanceId.make("codex"),
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "chosen-model",
                    },
                    providerThreadId: null,
                    userMessageId: MessageId.make("request"),
                    rootNodeId: null,
                    activeAttemptId: null,
                    status: "completed",
                    requestedAt: DateTime.makeUnsafe(0),
                    startedAt: DateTime.makeUnsafe(0),
                    completedAt: DateTime.makeUnsafe(0),
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                ],
                checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
                checkpoints: [],
              }),
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                branch: "feature",
                worktreePath: "/repo",
              } as OrchestrationV2ThreadShell),
          }),
          Layer.mock(WorktreeBranches.WorktreeBranches)({
            sync: () =>
              Effect.gen(function* () {
                captured.push("sync");
                if (failure === "branch sync")
                  return yield* new GitCommandError({
                    operation: "test",
                    command: "git",
                    cwd: "/repo",
                    detail: "Git index is locked.",
                  });
                return { _tag: "Bound" as const, branch: "feature" };
              }),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refresh: () =>
              Effect.gen(function* () {
                captured.push("refresh");
                if (failure === "workspace refresh")
                  return yield* new RunFinalization.RunFinalizationRefreshError({
                    cwd: "/repo",
                    cause: new Error("Git command timed out"),
                  });
              }).pipe(Effect.ensuring(Deferred.succeed(refreshed, undefined))),
            refreshAfterTurn: () => Effect.void,
            refreshRepositories: () => Effect.void,
          }),
          Layer.mock(ModelEvaluations.ModelEvaluations)({
            enqueueRun: (request) =>
              Effect.gen(function* () {
                assert.deepEqual(request, { threadId, runId, runOutcome: "completed" });
                captured.push("evaluation");
                if (failure === "evaluation enqueue")
                  return yield* new ModelEvaluations.ModelEvaluationPassError({
                    runId,
                    cause: new Error("Could not enqueue evaluation"),
                  });
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize({ threadId, runId, scopeId });
      yield* Deferred.await(refreshed);
      assert.deepEqual(captured, ["checkpoint", "evaluation", "sync", "refresh"]);
    }).pipe(Effect.provide(layer));
  },
);

const finalizationLayer = (
  scopeId: CheckpointScopeId,
  runId: RunId,
  steps: string[],
  refresh: (typeof RunFinalization.RunFinalizationObserver)["Service"]["refresh"],
) => {
  const usedRepositoryScopeId = CheckpointScopeId.make(`${scopeId}_api`);
  const idleRepositoryScopeId = CheckpointScopeId.make(`${scopeId}_docs`);
  const repositoryCheckpoint = (repositoryScopeId: CheckpointScopeId, checkpointRunId: RunId) => ({
    scopeId: repositoryScopeId,
    runId: checkpointRunId,
    ordinalWithinScope: 1,
    appRunOrdinal: null,
    status: "ready" as const,
    ref: CheckpointRef.make(`refs/t3/test/${repositoryScopeId}`),
  });
  return RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              steps.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [
                { id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" },
                {
                  id: usedRepositoryScopeId,
                  runId,
                  kind: "manual" as const,
                  cwd: "/api",
                  repositoryPath: "/api",
                },
                {
                  id: idleRepositoryScopeId,
                  runId,
                  kind: "manual" as const,
                  cwd: "/docs",
                  repositoryPath: "/docs",
                },
              ],
              checkpoints: [
                repositoryCheckpoint(usedRepositoryScopeId, runId),
                repositoryCheckpoint(idleRepositoryScopeId, RunId.make("run_before")),
              ],
            }),
          getThreadShell: () =>
            Effect.succeed({ worktreePath: null } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ModelEvaluations.ModelEvaluations)({}),
        Layer.mock(WorktreeBranches.WorktreeBranches)({}),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
          refreshRepositories: ({ cwds }) =>
            Effect.sync(() => {
              steps.push(`repositories:${cwds.join(",")}`);
            }),
        }),
      ),
    ),
  );
};

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  const refreshed = Deferred.makeUnsafe<void>();
  const layer = finalizationLayer(scopeId, runId, captured, () =>
    Effect.gen(function* () {
      captured.push("refresh");
      yield* Deferred.succeed(refreshed, undefined);
      return yield* new RunFinalization.RunFinalizationRefreshError({
        cwd: "/repo",
        cause: new Error("Git command timed out"),
      });
    }),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    yield* Deferred.await(refreshed);
    // Only the tracked repository this run checkpointed is refreshed.
    assert.sameMembers(captured, ["checkpoint", "refresh", "repositories:/api"]);
  }).pipe(Effect.provide(layer));
});

it.effect("completes finalization without waiting for the display refresh", () => {
  const threadId = ThreadId.make("thread_slow_refresh");
  const runId = RunId.make("run_slow_refresh");
  const scopeId = CheckpointScopeId.make("scope_slow_refresh");
  const steps: string[] = [];
  const release = Deferred.makeUnsafe<void>();
  const refreshed = Deferred.makeUnsafe<void>();
  const layer = finalizationLayer(scopeId, runId, steps, () =>
    Deferred.await(release).pipe(Effect.andThen(Deferred.succeed(refreshed, undefined))),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    const finalize = yield* service
      .finalize({ threadId, runId, scopeId })
      .pipe(Effect.timeoutOption("1 minute"), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    assert.isTrue(
      Option.isSome(yield* Fiber.join(finalize)),
      "finalization waited on the display refresh, blocking the thread's next turn",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(refreshed);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const lookedUp = Deferred.makeUnsafe<void>();
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProject,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(CodeIntelligence.CodeIntelligence)({ refreshIfIndexed: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          // Requested synchronously by refresh; the lookup itself runs in the background.
          refreshPullRequestStatus: (cwd) => {
            refreshed.push(cwd);
            return Deferred.succeed(lookedUp, undefined).pipe(Effect.as(null));
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    if (scenario.expected.length > 0) yield* Deferred.await(lookedUp);
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

it.live.each(
  (
    [
      {
        label: "rebinds a thread that ended on a new branch before its pull request refresh",
        checkout: ["switch", "-c", "agent/work"],
        worktreePath: "worktree",
        refName: "agent/work",
        branch: "agent/work",
        lookups: 1,
      },
      {
        label: "leaves a thread that ended on a detached HEAD alone",
        checkout: ["switch", "--detach"],
        worktreePath: "worktree",
        refName: null,
        branch: "feature",
        lookups: 0,
      },
      {
        label: "leaves a thread that ended on the default branch alone",
        checkout: ["switch", "main"],
        worktreePath: "worktree",
        refName: "main",
        branch: "feature",
        lookups: 0,
      },
      {
        label: "leaves a thread working in the project root alone",
        checkout: ["switch", "-c", "agent/work"],
        worktreePath: null,
        refName: "agent/work",
        branch: "feature",
        lookups: 0,
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-branch-sync");
    const runId = RunId.make("completed-run");
    const scopeId = CheckpointScopeId.make("scope-branch-sync");
    const lookedUp = yield* Deferred.make<void>();
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-branch-sync-" }),
    );
    const repo = `${root}/repo`;
    const worktree = `${root}/feature`;
    yield* fs.makeDirectory(repo);
    const command = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: "run-finalization-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "finalize@example.test"]);
    yield* command(repo, ["config", "user.name", "Finalize test"]);
    yield* command(repo, ["commit", "--allow-empty", "-m", "initial"]);
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    if (scenario.refName === "main") yield* command(repo, ["switch", "--detach"]);
    yield* command(worktree, scenario.checkout);

    let thread = {
      id: threadId,
      branch: "feature",
      worktreePath: scenario.worktreePath === null ? null : worktree,
      activeRunId: null,
      archivedAt: null,
      createdAt: DateTime.makeUnsafe(0),
    } as OrchestrationV2ThreadShell;
    let lookups = 0;
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getCheckpointContext: () =>
        Effect.succeed({
          runs: [],
          checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: worktree }],
          checkpoints: [],
        }),
      getThreadShell: () => Effect.sync(() => thread),
    });
    const layer = RunFinalization.layer.pipe(
      Layer.provideMerge(RunFinalization.layerObserver),
      Layer.provide(WorktreeBranches.layer),
      Layer.provide(
        Layer.mergeAll(
          layerNoProject,
          projections,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: () => Effect.succeedSome({ workspaceRoot: repo }) as never,
          }),
          Layer.mock(ModelEvaluations.ModelEvaluations)({}),
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getShellSnapshot: () =>
              Effect.sync(() => ({ threads: [thread], archivedThreads: [] })) as never,
            dispatch: ((command: { readonly branch: string }) =>
              Effect.sync(() => {
                thread = { ...thread, branch: command.branch };
              })) as never,
          }),
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          Layer.mock(CodeIntelligence.CodeIntelligence)({ refreshIfIndexed: () => Effect.void }),
          Layer.mock(PullRequestService.PullRequestService)({
            refreshAfterTurn: () => Effect.void,
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshLocalStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: false,
                isDefaultRef: scenario.refName === "main",
                refName: scenario.refName,
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            refreshPullRequestStatus: () =>
              Effect.suspend(() => {
                lookups++;
                return Deferred.succeed(lookedUp, undefined).pipe(Effect.as(null));
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize({ threadId, runId, scopeId });
      if (scenario.lookups > 0) yield* Deferred.await(lookedUp);
      assert.equal(thread.branch, scenario.branch);
      assert.equal(lookups, scenario.lookups);
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-branch-sync-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("finalizes a run without waiting for the code index refresh its checkpoint started", () =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-finalize-index-"));
      await NodeFSP.mkdir(NodePath.join(root, "src"));
      await NodeFSP.writeFile(
        NodePath.join(root, "src/a.ts"),
        "export function greet() { return 1; }\n",
      );
      return root;
    }),
    (root) =>
      Effect.scoped(
        Effect.gen(function* () {
          const projectId = ProjectId.make("project_index_refresh");
          const threadId = ThreadId.make("thread_index_refresh");
          const runId = RunId.make("run_index_refresh");
          const scopeId = CheckpointScopeId.make("scope_index_refresh");
          const configContext = yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-finalize-index-config-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          );
          const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configContext));
          const indexRoot = indexRootFor(config.codeIndexDir, root);
          const layer = RunFinalization.layer.pipe(
            Layer.provideMerge(RunFinalization.layerObserver),
            Layer.provideMerge(CodeIntelligence.layer),
            Layer.provide(
              Layer.mergeAll(
                layerNoProject,
                Layer.mock(ModelEvaluations.ModelEvaluations)({}),
                Layer.mock(WorktreeBranches.WorktreeBranches)({}),
                Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
                  execute: () => Effect.void,
                }),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getCheckpointContext: () =>
                    Effect.succeed({
                      runs: [],
                      checkpointScopes: [
                        { id: scopeId, runId, kind: "root_run" as const, cwd: root },
                      ],
                      checkpoints: [],
                    }),
                  getThread: () => Effect.die("unused"),
                  getThreadShell: () => Effect.succeed(null),
                }),
                Layer.mock(ProjectStore.ProjectStoreV2)({
                  get: () =>
                    Effect.succeedSome({
                      projectId,
                      workspaceRoot: root,
                      deletedAt: null,
                    } as unknown as ProjectStore.ProjectRow),
                }),
                Layer.mock(WorkspacePaths.WorkspacePaths)({
                  normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
                }),
                Layer.mock(WorkspaceEntries.WorkspaceEntries)({
                  refresh: () => Effect.void,
                  list: () =>
                    Effect.succeed({
                      entries: [{ path: "src/a.ts", kind: "file" as const }],
                      truncated: false,
                    }),
                }),
                Layer.mock(VcsDriver.VcsDriver)({
                  checkpoints: {} as VcsDriver.VcsDriver["Service"]["checkpoints"],
                  listWorkspaceFiles: () =>
                    Effect.fail(
                      new VcsProcessExitError({
                        operation: "test",
                        command: "git ls-files",
                        cwd: root,
                        exitCode: 128,
                        detail: "not a git repository",
                      }),
                    ),
                }),
                Layer.mock(PullRequestService.PullRequestService)({
                  refreshAfterTurn: () => Effect.void,
                }),
                Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
                  refreshLocalStatus: () =>
                    Effect.succeed({
                      isRepo: false,
                      hasPrimaryRemote: false,
                      isDefaultRef: false,
                      refName: null,
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                }),
                ServerSettings.layerTest(),
                Layer.succeed(ServerConfig.ServerConfig, config),
              ),
            ),
          );
          const context = yield* Layer.build(layer);
          const finalization = yield* RunFinalization.RunFinalizationService.pipe(
            Effect.provide(context),
          );
          const intelligence = yield* CodeIntelligence.CodeIntelligence.pipe(
            Effect.provide(context),
          );
          const finalize = finalization.finalize({ threadId, runId, scopeId });
          const published = () =>
            Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(indexRoot, ".codegraph-t3/published"), "utf8"),
            );

          // A checkout nobody has queried is not indexed behind the user's back.
          yield* finalize;
          assert.isFalse(NodeFS.existsSync(indexRoot));

          assert.deepEqual(yield* intelligence.refresh({ projectId }), {
            _tag: "Published",
            generation: 1,
          });
          const events = yield* Stream.toPull(yield* intelligence.subscribeIndex({ projectId }));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(root, "src/a.ts"), "export function renamed() {}\n"),
          );
          const buildHeld = yield* Deferred.make<void>();
          const releaseBuild = yield* Deferred.make<void>();
          const lease = yield* withWorkspaceLease(
            indexRoot,
            Deferred.succeed(buildHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBuild)),
            ),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(buildHeld);

          yield* finalize;
          assert.equal(yield* published(), "1", "finalization returned before the build ran");
          yield* Deferred.succeed(releaseBuild, undefined);
          yield* Fiber.await(lease);
          assert.deepEqual(yield* events, [{ outcome: "published", generation: 2 }]);
          assert.equal(yield* published(), "2");
        }),
      ),
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  ),
);
it.effect("returns from the post-turn refresh without waiting for the PR lookup", () => {
  const threadId = ThreadId.make("thread-slow-forge");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProject,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(CodeIntelligence.CodeIntelligence)({ refreshIfIndexed: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "feature",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: () => Effect.never,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "feature",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const refresh = yield* observer
      .refresh({ cwd: "/repo", threadId, runId })
      .pipe(Effect.timeoutOption("1 minute"), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(refresh);
    assert.isTrue(
      Option.isSome(result),
      "turn finalization waited on the forge PR lookup, blocking the thread's next turn",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("replaces a still-running PR lookup when a newer turn finishes", () => {
  const threadId = ThreadId.make("thread-back-to-back");
  const runId = RunId.make("completed-run");
  const firstInterrupted = Deferred.makeUnsafe<void>();
  const secondLookedUp = Deferred.makeUnsafe<void>();
  let lookups = 0;
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProject,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(CodeIntelligence.CodeIntelligence)({ refreshIfIndexed: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: "feature",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: () =>
            ++lookups === 1
              ? Effect.never.pipe(
                  Effect.onInterrupt(() => Deferred.succeed(firstInterrupted, undefined)),
                )
              : Deferred.succeed(secondLookedUp, undefined).pipe(Effect.as(null)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "feature",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    yield* Deferred.await(firstInterrupted);
    yield* Deferred.await(secondLookedUp);
    assert.strictEqual(lookups, 2);
  }).pipe(Effect.provide(layer));
});

const identityProjectId = ProjectId.make("project-identity-refresh");
const identityThreadId = ThreadId.make("thread-identity-refresh");
const identityRunId = RunId.make("completed-run");

const layerIdentityRefresh = <R>(
  workspaceRoot: string,
  resolver: Layer.Layer<RepositoryIdentityResolver.RepositoryIdentityResolver, never, R>,
) =>
  RunFinalization.layerObserver.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make()).pipe(
          Layer.provide(
            Layer.mergeAll(
              resolver,
              Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
                invalidate: () => Effect.void,
                resolvePath: () => Effect.succeed(null),
              }),
            ),
          ),
        ),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(CodeIntelligence.CodeIntelligence)({ refreshIfIndexed: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: identityThreadId,
              projectId: identityProjectId,
              branch: "main",
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: identityProjectId, workspaceRoot } as Project),
        }),
      ),
    ),
  );

it.effect("resolves the identity of a project whose remote was added during the turn", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-run-finalization-identity-test-",
    });
    const git = (args: ReadonlyArray<string>) =>
      processRunner.run({ command: "git", args: ["-C", workspaceRoot, ...args] });
    yield* git(["init"]);

    yield* Effect.gen(function* () {
      const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
      // A shell read before the turn caches the folder as having no repository.
      assert.isNull(yield* enrichment.readRepositoryIdentity(workspaceRoot));

      yield* git(["remote", "add", "origin", "https://github.com/t3-triage/example-29929.git"]);
      const changes = yield* enrichment.subscribeChanges;
      const observer = yield* RunFinalization.RunFinalizationObserver;
      yield* observer.refresh({
        cwd: workspaceRoot,
        threadId: identityThreadId,
        runId: identityRunId,
      });

      const change = yield* PubSub.take(changes);
      assert.strictEqual(
        change.enrichment.repositoryIdentity?.locator.remoteUrl,
        "https://github.com/t3-triage/example-29929.git",
        "the project's repository identity is still null after the turn added a remote",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(layerIdentityRefresh(workspaceRoot, RepositoryIdentityResolver.layer)),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.effect("returns from the post-turn refresh while the identity resolver is still running", () => {
  const workspaceRoot = "/repo-stubbed-identity";
  const identity: RepositoryIdentity = {
    canonicalKey: "example.test/stubbed-identity",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://example.test/stubbed-identity.git",
    },
  };
  const releaseResolver = Deferred.makeUnsafe<void>();
  let remoteAdded = false;
  const resolver = Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (_cwd, options) =>
      options?.refresh
        ? Deferred.await(releaseResolver).pipe(
            Effect.map(() => {
              remoteAdded = true;
              return identity;
            }),
          )
        : Effect.sync(() => (remoteAdded ? identity : null)),
  });
  return Effect.gen(function* () {
    const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
    assert.isNull(yield* enrichment.readRepositoryIdentity(workspaceRoot));
    const changes = yield* enrichment.subscribeChanges;
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const refresh = yield* observer
      .refresh({ cwd: workspaceRoot, threadId: identityThreadId, runId: identityRunId })
      .pipe(Effect.timeoutOption("1 minute"), Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 minute");
    assert.isTrue(
      Option.isSome(yield* Fiber.join(refresh)),
      "turn finalization waited on the identity resolver, blocking the thread's next turn",
    );

    yield* Deferred.succeed(releaseResolver, undefined);
    const change = yield* PubSub.take(changes);
    assert.strictEqual(change.enrichment.repositoryIdentity?.canonicalKey, identity.canonicalKey);
  }).pipe(Effect.scoped, Effect.provide(layerIdentityRefresh(workspaceRoot, resolver)));
});
