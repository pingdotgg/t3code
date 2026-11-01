import { CheckpointScopeId, CommandId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

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
  /** Resolves to the branch checked out in `cwd`, or null when detached. */
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<string | null, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({
    refresh: () => Effect.succeed(null),
    refreshAfterTurn: () => Effect.void,
  }),
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
  const threads = yield* ThreadManagement.ThreadManagementService;

  // An agent can rename or switch the branch of a thread's own worktree. The
  // stored branch feeds the sidebar and Copy branch, so follow it, but not
  // into a shared worktree where the recorded branch is what keeps threads apart.
  const followWorktreeBranch = Effect.fn("RunFinalizationService.followWorktreeBranch")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly cwd: string;
      readonly checkedOutBranch: string;
    }) {
      if (isTemporaryWorktreeBranch(input.checkedOutBranch)) return;
      const thread = yield* projections.getThreadShell(input.threadId);
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === input.checkedOutBranch ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }
      const worktrees = yield* projections.getThreadWorktreePaths({ includeArchived: true });
      if (
        worktrees.some((other) => other.threadId !== thread.id && other.worktreePath === input.cwd)
      ) {
        return;
      }
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`server:worktree-branch:${input.runId}`),
        threadId: thread.id,
        branch: input.checkedOutBranch,
        expectedBranch: thread.branch,
        expectedWorktreePath: input.cwd,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to follow the worktree branch after checkpoint capture", {
            threadId: input.threadId,
            cause,
          }),
        ),
      ),
  );

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
      const checkedOutBranch = yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.catchTags({
            RunFinalizationRefreshError: (cause) =>
              Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
                ...input,
                cause,
              }).pipe(Effect.as(null)),
          }),
        );
      if (checkedOutBranch !== null) {
        yield* followWorktreeBranch({
          threadId: input.threadId,
          runId: input.runId,
          cwd,
          checkedOutBranch,
        });
      }
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
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null) return null;
          if (local.isDefaultRef) return local.refName;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return local.refName;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return local.refName;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
          return local.refName;
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
