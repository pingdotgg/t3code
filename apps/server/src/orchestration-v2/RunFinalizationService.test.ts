import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectFolderAt = (workspaceRoot: string) =>
  Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot } as Project),
    }),
    FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
  );

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
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
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
              checkpoints: [],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () =>
            Effect.gen(function* () {
              captured.push("refresh");
              return yield* new RunFinalization.RunFinalizationRefreshError({
                cwd: "/repo",
                cause: new Error("Git command timed out"),
              });
            }),
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(captured, ["checkpoint", "refresh"]);
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
        label: "keeps a project-folder thread's branch when its turn returns to the default branch",
        branch: "feature",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "leaves a branch checked out outside the project folder",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        workspaceRoot: "/elsewhere",
        expected: [],
      },
      {
        label: "leaves a worktree thread's branch to the worktree sync",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        worktreePath: "/repo",
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "other",
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
    Layer.provideMerge(
      Layer.mergeAll(
        projectFolderAt("workspaceRoot" in scenario ? scenario.workspaceRoot : "/repo"),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
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
              worktreePath: "worktreePath" in scenario ? scenario.worktreePath : null,
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

it.effect("returns from the post-turn refresh without waiting for the PR lookup", () => {
  const threadId = ThreadId.make("thread-slow-forge");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        projectFolderAt("/repo"),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
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
              worktreePath: null,
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
    Layer.provideMerge(
      Layer.mergeAll(
        projectFolderAt("/repo"),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
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
              worktreePath: null,
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

it.effect("a project-folder thread adopts the branch its agent checked out", () => {
  const scenario = { stored: "theo/edge", checkedOut: "theo/update-13.4.0" };
  const threadId = ThreadId.make("thread-project-folder");
  const runId = RunId.make("completed-run");
  const commands: OrchestrationV2ServerCommand[] = [];
  const refreshed: string[] = [];
  const lookedUp = Deferred.makeUnsafe<void>();
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        projectFolderAt("/repo"),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshPullRequestStatus: (cwd) => {
            refreshed.push(cwd);
            return Deferred.succeed(lookedUp, undefined).pipe(Effect.as(null));
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId: ProjectId.make("project-zact"),
              branch: scenario.stored,
              worktreePath: null,
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(
      commands.flatMap((command) =>
        command.type === "thread.metadata.update" && command.branch !== undefined
          ? [
              {
                threadId: command.threadId,
                branch: command.branch,
                expectedBranch: command.expectedBranch,
                expectedWorktreePath: command.expectedWorktreePath,
              },
            ]
          : [],
      ),
      [
        {
          threadId,
          branch: scenario.checkedOut,
          expectedBranch: scenario.stored,
          expectedWorktreePath: null,
        },
      ],
      `thread kept branch ${scenario.stored} after its turn checked out ${scenario.checkedOut}`,
    );
    yield* Deferred.await(lookedUp);
    assert.deepEqual(refreshed, ["/repo"]);
  }).pipe(Effect.provide(layer));
});
