import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * A normalized, bounded failure category safe for a log annotation: the
 * error's own tag when it has one (a typed domain failure), or its name
 * otherwise. Never the message or a stringified cause/stack, which can
 * carry git/command output or, further upstream, credentials — the real
 * value stays in the error's own `cause` field for the error chain, not in
 * annotations (effect-service-conventions review).
 */
function failureCategory(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    return error._tag;
  }
  if (error instanceof Error) return error.name;
  return typeof error;
}

/** Same bounded category, from a Cause instead of a single error value. */
function causeCategory(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) return failureCategory(reason.error);
    if (Cause.isDieReason(reason)) return failureCategory(reason.defect);
  }
  return "Interrupted";
}

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
  /**
   * Follows the provider session into (or out of) a worktree during a turn
   * (#11078, e.g. Claude's EnterWorktree/ExitWorktree): the session's cwd is
   * live-tracked separately from the turn's checkpoint cwd `refresh` uses, so
   * this compares it against the thread's recorded location on its own.
   */
  readonly followWorktreeMove: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({
    refresh: () => Effect.void,
    refreshAfterTurn: () => Effect.void,
    followWorktreeMove: () => Effect.void,
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
    // Best-effort: this follow is independent of (and must not block) the
    // checkpoint-cwd branch refresh below, so a failure here is logged and
    // swallowed rather than aborting the rest of finalize.
    yield* observer.followWorktreeMove({ threadId: input.threadId, runId: input.runId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree-location follow failed", {
          threadId: input.threadId,
          runId: input.runId,
          category: causeCategory(cause),
        }),
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
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;

    // A `git checkout`/`git switch` run inside a thread's dedicated worktree
    // (by the agent or the user) bypasses T3's own commands, so the stamped
    // branch goes stale (#11078). Follow it here: adopt the checked-out
    // branch as the thread's branch, but only while the worktree still
    // belongs to exactly this thread. For a shared worktree, whose branch it
    // is would be ambiguous, so leave the stamp alone.
    // Returns whether it dispatched the follow.
    const followBranchDrift = Effect.fn("RunFinalizationService.followBranchDrift")(function* (
      thread: OrchestrationV2ThreadShell,
      cwd: string,
      refName: string,
      runId: RunId,
    ) {
      // No branch to compare-and-swap against, no dedicated worktree to own
      // exclusively, the first-turn auto-rename is still in flight, or `cwd`
      // is not the thread's worktree. The last one happens when
      // followWorktreeMove just moved the thread out of the checkpoint cwd:
      // that cwd's branch belongs to where the thread was, not where it is.
      if (
        thread.branch === null ||
        thread.worktreePath === null ||
        thread.worktreePath !== cwd ||
        isTemporaryWorktreeBranch(refName)
      ) {
        return false;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          // Keyed by the run being finalized, not the branch: a retry of the
          // same at-least-once effect must reuse this id (see
          // checkpoint.capture below), but a later run drifting back to an
          // earlier branch is a fresh occurrence, not a duplicate.
          commandId: CommandId.make(`command:effect:worktree-branch-drift:${runId}`),
          threadId: thread.id,
          branch: refName,
          expectedBranch: thread.branch,
          expectedWorktreePath: thread.worktreePath,
          requireExclusiveWorktree: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to follow worktree branch drift after run completion", {
              threadId: thread.id,
              previousBranch: thread.branch,
              branch: refName,
              category: failureCategory(error),
            }),
          ),
        );
      return true;
    });

    // The provider session's own cwd (tracked live by the adapter, e.g. from
    // Claude's EnterWorktree/ExitWorktree) moving away from the thread's
    // recorded worktreePath (#11078). Unlike followBranchDrift, the
    // worktreePath itself is always worth tracking here, so it commits even
    // into a shared worktree; only the branch adoption is conditional, via
    // the same exclusivity check (requireExclusiveWorktree).
    const followWorktreeMove = ({
      threadId,
      runId,
    }: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) =>
      Effect.gen(function* () {
        const thread = yield* projections.getThreadShell(threadId);
        if (!thread) return;
        if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
        if (thread.activeProviderThreadId === null) return;
        // The session this thread's own provider thread runs on, not just any
        // session bound to the thread: a thread can stay bound to sessions
        // opened elsewhere, whose cwd says nothing about where this agent is.
        const providerContext = yield* projections.getThreadProviderContext(
          threadId,
          thread.providerInstanceId,
        );
        const providerSessionId = providerContext.providerThreads.find(
          (providerThread) => providerThread.id === thread.activeProviderThreadId,
        )?.providerSessionId;
        if (providerSessionId == null) return;
        const liveCwd = providerContext.providerSessions.find(
          (session) => session.id === providerSessionId,
        )?.cwd;
        if (liveCwd === undefined) return;
        // A shared session has one cwd for every thread on it, so a move may
        // have been another thread's. Leave the location alone rather than
        // guess.
        if (yield* projections.isProviderSessionShared(threadId, providerSessionId)) return;
        const project = yield* projects.getById(thread.projectId);
        if (Option.isNone(project)) return;
        const recordedCwd = thread.worktreePath ?? project.value.workspaceRoot;
        if (liveCwd === recordedCwd) return;

        const newWorktreePath = liveCwd === project.value.workspaceRoot ? null : liveCwd;
        const local = yield* vcsStatus.refreshLocalStatus(liveCwd).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to read git status after a worktree move", {
              threadId,
              cwd: liveCwd,
              category: failureCategory(error),
            }).pipe(Effect.as(null)),
          ),
        );
        // A detached HEAD or the still-in-flight first-turn placeholder
        // branch has nothing adoptable; a non-dedicated location (back to
        // the main checkout) never adopts a branch either.
        const checkedOutBranch =
          newWorktreePath !== null &&
          local !== null &&
          local.refName !== null &&
          !isTemporaryWorktreeBranch(local.refName)
            ? local.refName
            : null;

        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            // Keyed by the run being finalized: a retry of the same
            // at-least-once effect must reuse this id, but a later run
            // moving again is a fresh occurrence, not a duplicate.
            commandId: CommandId.make(`command:effect:worktree-location-follow:${runId}`),
            threadId,
            worktreePath: newWorktreePath,
            expectedWorktreePath: thread.worktreePath,
            branch: checkedOutBranch,
            // The session itself moved and is already working from the new
            // location; detaching it (the default for an explicit worktree
            // handoff) would kill useful, in-progress work.
            preserveProviderSession: true,
            ...(checkedOutBranch !== null ? { requireExclusiveWorktree: true } : {}),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to follow the provider session into its new worktree", {
                threadId,
                worktreePath: newWorktreePath,
                category: failureCategory(error),
              }),
            ),
          );
      }).pipe(
        Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd: "<session>", cause })),
      );

    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      followWorktreeMove,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          // isDefaultRef only rules out looking up a PR for the default
          // branch below; a dedicated worktree switching to that branch is
          // still drift and must still be followed, so this cannot bail
          // before the drift check runs (#11078 review).
          if (local.refName === null) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          if (thread.branch !== local.refName) {
            // After following, the cached PR still belongs to the previous
            // branch. Re-resolve it below, default branch included, so the
            // toolbar never pairs the new branch with the old branch's PR.
            if (!(yield* followBranchDrift(thread, cwd, local.refName, runId))) return;
          } else if (local.isDefaultRef) {
            return;
          }
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
