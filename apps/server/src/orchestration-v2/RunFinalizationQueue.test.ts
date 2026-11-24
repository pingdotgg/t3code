import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, GitCommandError, RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitles from "./ThreadTitleRegenerationService.ts";

const threadId = ThreadId.make("thread:finalization-queue");
const runId = RunId.make("run:finalization-queue");
const scopeId = CheckpointScopeId.make("scope:finalization-queue");
const captureEffect = {
  id: "effect:finalization-queue:capture",
  commandId: CommandId.make("command:finalization-queue:capture"),
  threadId,
  request: { type: "checkpoint.capture" as const, runId, scopeId },
};
const startEffect = {
  id: "effect:finalization-queue:start",
  commandId: CommandId.make("command:finalization-queue:start"),
  threadId,
  request: { type: "provider-turn.start" as const, runId: RunId.make("run:next") },
};

const makeWorker = (
  calls: string[],
  capture: Effect.Effect<void, CheckpointCapture.CheckpointCaptureExecutionError>,
) => {
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getCheckpointContext: () =>
      Effect.succeed({
        runs: [],
        checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
        checkpoints: [],
      }),
    getThreadShell: () => Effect.succeed(null),
  });
  const observer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.gen(function* () {
              calls.push("refresh");
              return yield* new GitCommandError({
                operation: "statusDetailsLocal",
                command: "git",
                cwd: "/repo",
                detail: "VCS process timed out after 30000ms",
              });
            }),
        }),
      ),
    ),
  );
  const finalization = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        observer,
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () => Effect.sync(() => calls.push("capture")).pipe(Effect.andThen(capture)),
        }),
      ),
    ),
  );
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        finalization,
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
        Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
        Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          recoverDelegatedTask: () => Effect.void,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ServerSettings.layerTest(),
        Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
          start: () => Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  return Layer.fresh(EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(executor, outbox))));
};

it.effect.each([
  ["starts the next turn after a post-capture Git status failure", false],
  ["keeps the next turn queued when checkpoint capture fails", true],
] as const)("%s", ([, captureFails]) => {
  const calls: string[] = [];
  const checkpointFailure = new CheckpointCapture.CheckpointCaptureExecutionError({
    threadId,
    runId,
    scopeId,
    cause: "checkpoint storage unavailable",
  });
  return Effect.gen(function* () {
    const queue = yield* EffectOutbox.EffectOutboxV2;
    const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* queue.enqueue([captureEffect, startEffect]);

    assert.equal(yield* effectWorker.drain(2), captureFails ? 1 : 2);
    const captured = Option.getOrThrow(yield* queue.get("effect:finalization-queue:capture"));
    const started = Option.getOrThrow(yield* queue.get("effect:finalization-queue:start"));
    assert.equal(captured.status, captureFails ? "pending" : "succeeded");
    assert.equal(captured.attemptCount, 1);
    assert.equal(started.status, captureFails ? "pending" : "succeeded");
    assert.equal(started.attemptCount, captureFails ? 0 : 1);
    assert.deepEqual(calls, captureFails ? ["capture"] : ["capture", "refresh", "start"]);
    if (captureFails) assert.include(captured.lastError ?? "", "checkpoint storage unavailable");
    else assert.equal(captured.lastError, null);
  }).pipe(Effect.provide(makeWorker(calls, captureFails ? checkpointFailure : Effect.void)));
});

// A run completes before its capture, so the next turn's start is enqueued while capture runs.
it.effect("keeps a next turn started during capture behind that capture", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const captureStarted = yield* Deferred.make<void>();
    const releaseCapture = yield* Deferred.make<void>();
    const capture = Deferred.succeed(captureStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseCapture)),
    );
    return yield* Effect.gen(function* () {
      const queue = yield* EffectOutbox.EffectOutboxV2;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* queue.enqueue([captureEffect]);
      const draining = yield* Effect.forkChild(effectWorker.drain(2));
      yield* Deferred.await(captureStarted);

      yield* queue.enqueue([startEffect]);
      assert.isTrue(Option.isNone(yield* queue.claimNext({ workerId: "second-slot" })));
      assert.deepEqual(calls, ["capture"]);

      yield* Deferred.succeed(releaseCapture, undefined);
      assert.equal(yield* Fiber.join(draining), 2);
      assert.deepEqual(calls, ["capture", "refresh", "start"]);
    }).pipe(Effect.provide(makeWorker(calls, capture)));
  });
});
