import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { joinWorkspaceRepositoryPath } from "@t3tools/shared/path";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
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
      yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
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
    const workspaceRepositories = yield* WorkspaceRepositories.WorkspaceRepositories;
    const refreshStatus = (input: {
      readonly cwd: string;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly isWorkspaceRepository: boolean;
    }) =>
      Effect.gen(function* () {
        const local = yield* vcsStatus.refreshLocalStatus(input.cwd);
        if (local.refName === null || local.isDefaultRef) return;
        const thread = yield* projections.getThreadShell(input.threadId);
        if (!thread) return;
        // Repositories in a multi-repo project folder keep their own branches, so only a
        // single repository or an isolated run has a thread branch to match.
        const inProjectFolder = input.isWorkspaceRepository && thread.worktreePath === null;
        if (!inProjectFolder && thread.branch !== local.refName) return;
        if (thread.activeRunId !== null && thread.activeRunId !== input.runId) return;
        yield* vcsStatus.refreshPullRequestStatus(input.cwd).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to refresh pull request status after run completion", {
              threadId: input.threadId,
              cwd: input.cwd,
              detail: error.message,
            }),
          ),
        );
      });
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          // A multi-repo workspace folder is not a repository; its repositories hold the status.
          const repositories = yield* workspaceRepositories.list(cwd);
          const statusCwds =
            repositories.length === 0
              ? [cwd]
              : repositories.map((repository) =>
                  joinWorkspaceRepositoryPath(cwd, repository.relativePath),
                );
          yield* Effect.all(
            [
              workspaceEntries.refresh(cwd),
              Effect.forEach(
                statusCwds,
                (statusCwd) =>
                  refreshStatus({
                    cwd: statusCwd,
                    threadId,
                    runId,
                    isWorkspaceRepository: repositories.length > 0,
                  }),
                { concurrency: "unbounded", discard: true },
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
