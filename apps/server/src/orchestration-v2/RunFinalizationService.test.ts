// @effect-diagnostics nodeBuiltinImport:off - the code index fixture is a temporary checkout.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as CodeIntelligence from "../project/knowledge/CodeIntelligence.ts";
import * as ModelEvaluations from "../modelEvaluations/ModelEvaluations.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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

it.effect("coalesces completed turns without starving later project refreshes", () => {
  const projectA = ProjectId.make("project-turn-refresh-a");
  const projectB = ProjectId.make("project-turn-refresh-b");
  const refreshed: ProjectId[] = [];
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
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
              }),
            refreshAfterTurn: () => Effect.void,
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
      assert.deepEqual(captured, ["checkpoint", "evaluation", "sync", "refresh"]);
    }).pipe(Effect.provide(layer));
  },
);

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
          const layer = RunFinalization.layer.pipe(
            Layer.provideMerge(RunFinalization.layerObserver),
            Layer.provideMerge(CodeIntelligence.layer),
            Layer.provide(
              Layer.mergeAll(
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
              NodeFSP.readFile(NodePath.join(root, ".codegraph-t3/published"), "utf8"),
            );

          // A checkout nobody has queried is not indexed behind the user's back.
          yield* finalize;
          assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".codegraph-t3")));

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
            NodePath.join(root, ".codegraph-t3"),
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
