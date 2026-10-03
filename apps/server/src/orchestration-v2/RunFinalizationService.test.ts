import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

const isRunFinalizationError = Schema.is(RunFinalization.RunFinalizationError);

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
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
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.observerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
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
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
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
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["missing-scope", "read-failure"] as const)(
  "reports %s separately from workspace refresh failures",
  (scenario) => {
    const threadId = ThreadId.make("thread:finalization-error");
    const runId = RunId.make("run:finalization-error");
    const scopeId = CheckpointScopeId.make("scope:finalization-error");
    const refresh = vi.fn(() => Effect.void);
    const layer = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCheckpointContext: () =>
              scenario === "missing-scope"
                ? Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] })
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "read failed",
                    }),
                  ),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refresh,
            refreshAfterTurn: () => Effect.void,
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      const result = yield* Effect.exit(service.finalize({ threadId, runId, scopeId }));
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        assert.isTrue(isRunFinalizationError(error));
        if (isRunFinalizationError(error)) {
          assert.equal(
            error.operation,
            scenario === "missing-scope" ? "missing-checkpoint-scope" : "read-checkpoint-context",
          );
        }
      }
      assert.equal(refresh.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  },
);
