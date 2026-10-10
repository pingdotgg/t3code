import {
  CheckpointScopeId,
  CommandId,
  OrchestrationV2RunFinalizationOperation,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalized from "./RunFinalized.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: OrchestrationV2RunFinalizationOperation,
    cause: Schema.Defect(),
  },
) {}

export const isRunFinalizationError = Schema.is(RunFinalizationError);

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    /**
     * Captures the run's checkpoint, refreshes its workspace, then records
     * `run.finalized`. At-least-once: every step is safe to repeat, and a run
     * that already recorded its finalization is left as recorded. Every
     * failure that is not an interruption names the step that failed.
     */
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
    /**
     * Gives up on a run's finalization after the worker's last attempt failed
     * at `operation`: fails the claimed capture effect and records
     * `run.finalization-failed` in one transaction. Returns false, recording
     * nothing, when `workerId` no longer holds the effect's lease.
     */
    readonly abandon: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
      readonly operation: OrchestrationV2RunFinalizationOperation;
      readonly effectId: string;
      readonly workerId: string;
      readonly error: string;
    }) => Effect.Effect<boolean, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const observer = yield* RunFinalizationObserver;

  const finalize = Effect.fn("RunFinalizationService.finalize")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) {
    // Unexpected defects fail the step too; an interruption is replayed.
    const failStep =
      (operation: OrchestrationV2RunFinalizationOperation) => (cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new RunFinalizationError({ ...input, operation, cause: Cause.squash(cause) }),
            );

    // A replay after a crash honours the disposition already recorded.
    if (
      yield* eventSink
        .hasRunFinalization(input.runId)
        .pipe(Effect.catchCause(failStep("capture-checkpoint")))
    )
      return;
    yield* checkpointCapture.execute(input).pipe(Effect.catchCause(failStep("capture-checkpoint")));
    yield* Effect.gen(function* () {
      const projection = yield* projections.getCheckpointContext(input.threadId);
      const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
      if (cwd !== undefined) {
        yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId });
      }
    }).pipe(Effect.catchCause(failStep("refresh-workspace")));
    yield* Effect.gen(function* () {
      const { run } = yield* projections.getCheckpointCaptureContext(input.threadId, input);
      // A rolled-back run was discarded before its capture ran.
      const outcome = run === undefined ? null : RunFinalized.runFinalizedOutcome(run.status);
      if (run === undefined || outcome === null) return;
      // EventSink drops the event when this run already recorded its finalization.
      yield* eventSink.write({
        commandId: CommandId.make(`command:effect:run.finalized:${run.id}`),
        events: [
          RunFinalized.makeRunFinalizedEvent({ run, outcome, occurredAt: yield* DateTime.now }),
        ],
      });
    }).pipe(Effect.catchCause(failStep("record-finalized")));
  });

  const abandon: RunFinalizationService["Service"]["abandon"] = (input) =>
    Effect.gen(function* () {
      const { run } = yield* projections.getCheckpointCaptureContext(input.threadId, input);
      const { committed } = yield* eventSink.failEffect({
        commandId: CommandId.make(`command:effect:run.finalization-failed:${input.runId}`),
        effectId: input.effectId,
        workerId: input.workerId,
        error: input.error,
        // A rolled-back run was discarded; there is nothing to report.
        events:
          run === undefined || run.status === "rolled_back"
            ? []
            : [
                RunFinalized.makeRunFinalizationFailedEvent({
                  run,
                  operation: input.operation,
                  occurredAt: yield* DateTime.now,
                }),
              ],
      });
      return committed;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RunFinalizationError({
            threadId: input.threadId,
            runId: input.runId,
            scopeId: input.scopeId,
            operation: input.operation,
            cause,
          }),
      ),
    );

  return RunFinalizationService.of({ finalize, abandon });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
