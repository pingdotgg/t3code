import { CheckpointScopeId, CommandId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
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
  /** Refreshes the run's checkout and returns its branch; null when detached or on the default. */
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

  // Agents rename the branch of a thread's worktree (`git branch -m`, `git checkout -b`).
  // Every thread in that worktree still recording the old name follows the checkout,
  // like the launch rename, so PR lookup and worktree cleanup find the real branch.
  const adoptCheckedOutBranch = Effect.fn("RunFinalizationService.adoptCheckedOutBranch")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly cwd: string;
      readonly branch: string;
    }) {
      const thread = yield* projections.getThreadShell(input.threadId);
      // Only a thread's own worktree is followed: a project root is shared by every local
      // thread. A newer run adopts at its own finalization, from a fresher checkout.
      if (
        thread === null ||
        thread.worktreePath !== input.cwd ||
        thread.branch === null ||
        thread.branch === input.branch ||
        (thread.activeRunId !== null && thread.activeRunId !== input.runId)
      )
        return;
      const previousBranch = thread.branch;
      const worktreeThreadIds = (yield* projections.getThreadWorktreePaths({
        includeArchived: true,
      }))
        .filter((entry) => entry.worktreePath === input.cwd)
        .map((entry) => entry.threadId);
      for (const threadId of worktreeThreadIds) {
        const shell = threadId === thread.id ? thread : yield* projections.getThreadShell(threadId);
        if (shell?.branch !== previousBranch) continue;
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.runId}:branch-adopt:${threadId}`),
            threadId,
            branch: input.branch,
            expectedBranch: previousBranch,
            expectedWorktreePath: input.cwd,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to adopt the checked-out worktree branch", {
                threadId,
                branch: input.branch,
                cause,
              }),
            ),
          );
      }
    },
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
      const branch = yield* observer
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
      if (branch !== null)
        yield* adoptCheckedOutBranch({ ...input, cwd, branch }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to adopt the checked-out worktree branch", {
              ...input,
              branch,
              cause,
            }),
          ),
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
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return null;
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
