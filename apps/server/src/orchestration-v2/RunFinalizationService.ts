import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

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
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      // Retrying a display refresh after the checkpoint is durable blocks the next turn.
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId }).pipe(
        Effect.catchTags({
          RunFinalizationRefreshError: (cause) =>
            Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
              ...input,
              cause,
            }),
        }),
      );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const pullRequestLookups = yield* FiberMap.make<string>();
    const divergenceRefreshes = yield* FiberMap.make<string>();
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null) return;
          const thread = local.isDefaultRef ? null : yield* projections.getThreadShell(threadId);
          const shouldLookUpPullRequest =
            thread?.branch === local.refName &&
            (thread.activeRunId === null || thread.activeRunId === runId);
          // Divergence goes first so a clean tree never reads as up to date while the forge CLI
          // runs. That CLI can take minutes, so the next turn must not wait for it. A newer
          // turn's lookup replaces a running one, but divergence alone must neither cancel a
          // lookup nor be skipped for one.
          const divergence = vcsStatus.refreshDivergence(cwd);
          const logFailure = (error: { readonly message: string }) =>
            Effect.logWarning("failed to refresh remote status after run completion", {
              threadId,
              cwd,
              detail: error.message,
            });
          yield* shouldLookUpPullRequest
            ? divergence.pipe(
                Effect.andThen(vcsStatus.refreshPullRequestStatus(cwd)),
                Effect.catch(logFailure),
                FiberMap.run(pullRequestLookups, cwd),
              )
            : divergence.pipe(
                Effect.catch(logFailure),
                FiberMap.run(divergenceRefreshes, cwd, { onlyIfMissing: true }),
              );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
