import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("captures the root checkpoint and refreshes workspace state", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const projection = {
    checkpointScopes: [{ id: scopeId, cwd: "/repo" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: Effect.void,
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

for (const scenario of [
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
] as const) {
  it.effect(scenario.label, () => {
    const refreshed: string[] = [];
    const threadId = ThreadId.make("thread-pr-refresh");
    const runId = RunId.make("completed-run");
    const layer = RunFinalization.observerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: Effect.void }),
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
}
