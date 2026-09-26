// @ts-nocheck
import {
  ApprovalRequestId,
  type ChatAttachment,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  applyValidationEvent,
  isValidationLifecycleEvent,
} from "@t3tools/client-runtime/validation-lifecycle";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { childLifecycleNotificationToActivity } from "@t3tools/shared/orchestrationActivity";
import { sameThreadPullRequest } from "@t3tools/shared/threadPullRequests";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionReconciliationJobRepository } from "../../persistence/Services/ProjectionReconciliationJobs.ts";
import { REVIEW_HANDOFF_PROJECTOR } from "../../pullRequestMonitor/PullRequestReviewHandoffReactor.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessageRevertKey,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionQueuedTurnRepository } from "../../persistence/Services/ProjectionQueuedTurns.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadPullRequestRepository } from "../../persistence/Services/ProjectionThreadPullRequests.ts";
import { ProjectionWorkflowRepository } from "../../persistence/Services/ProjectionWorkflows.ts";
import { WorktreeCleanupJobRepository } from "../../persistence/Services/WorktreeCleanupJobs.ts";
import { canonicalizeWorktreePath } from "../../git/worktreePaths.ts";
import {
  chunkRevertTrimIds,
  extraRetainedMessageIdsFromTurns,
  planMetaUpdatedPullRequestLinks,
  resolveInitialThreadPullRequest,
  selectRetainedMessageIds,
  selectRetainedTurnIds,
  selectTrimmedTurnIds,
  shouldPreserveActiveMessageId,
  terminalTurnStateForSessionStatus,
} from "../projection/ProjectionPolicy.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionReconciliationJobRepositoryLive } from "../../persistence/Layers/ProjectionReconciliationJobs.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionQueuedTurnRepositoryLive } from "../../persistence/Layers/ProjectionQueuedTurns.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadPullRequestRepositoryLive } from "../../persistence/Layers/ProjectionThreadPullRequests.ts";
import { ProjectionWorkflowRepositoryLive } from "../../persistence/Layers/ProjectionWorkflows.ts";
import { WorktreeCleanupJobRepositoryLive } from "../../persistence/Layers/WorktreeCleanupJobs.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  emptyProjectionImpact,
  isActionableApprovalRequest,
  mergeProjectionImpact,
  projectionImpactForEvent,
  type ProjectionImpact,
} from "../projection/ProjectionImpact.ts";
import {
  ProjectionReconciler,
  ProjectionReconcilerLive,
} from "../projection/ProjectionReconciler.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions.v2",
  threadTurns: "projection.thread-turns",
  queuedTurns: "projection.queued-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  workflows: "projection.workflows",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

const BOOTSTRAP_EVENT_BATCH_SIZE = 256;

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

function retainProjectionMessageIdsAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessageRevertKey>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): Set<string> {
  const retainedTurnIds = new Set(selectRetainedTurnIds(turns, turnCount));
  return selectRetainedMessageIds(
    messages,
    retainedTurnIds,
    turnCount,
    extraRetainedMessageIdsFromTurns(turns, turnCount),
  );
}

function retainedTurnIdsAfterRevert(
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): Array<string> {
  return selectRetainedTurnIds(turns, turnCount);
}

function trimmedTurnIdsAfterRevert(
  presentTurnIds: ReadonlyArray<string>,
  retainedTurnIds: ReadonlyArray<string>,
): Array<string> {
  return selectTrimmedTurnIds(presentTurnIds, retainedTurnIds);
}

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const reconciliationJobs = yield* ProjectionReconciliationJobRepository;
    const reconciler = yield* ProjectionReconciler;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadPullRequestRepository = yield* ProjectionThreadPullRequestRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionQueuedTurnRepository = yield* ProjectionQueuedTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const projectionWorkflowRepository = yield* ProjectionWorkflowRepository;
    const worktreeCleanupJobRepository = yield* WorktreeCleanupJobRepository;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            kind: event.payload.kind ?? "workspace",
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            autoPull: false,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            ...(event.payload.autoPull !== undefined ? { autoPull: event.payload.autoPull } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event) {
      if (isValidationLifecycleEvent(event)) {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        const validation = applyValidationEvent(
          {
            request: existingRow.value.validationRequest ?? null,
            run: existingRow.value.validationRun ?? null,
          },
          event,
        );
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          validationRequest: validation.request,
          validationRun: validation.run,
          updatedAt: event.occurredAt,
        });
        return;
      }

      switch (event.type) {
        case "thread.created":
          const { initialPullRequest, source } = resolveInitialThreadPullRequest({
            pullRequest: event.payload.pullRequest,
            reviewSnapshot: event.payload.reviewSnapshot,
          });
          yield* projectionThreadPullRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadRepository.upsert({
            nudging: event.payload.nudging,
            collaborationRequests: [],
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            parentThreadId: event.payload.parentThreadId ?? null,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            pendingRuntimeMode: event.payload.pendingRuntimeMode ?? null,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            ...(event.payload.workspaceBinding !== undefined
              ? { workspaceBinding: event.payload.workspaceBinding }
              : {}),
            pullRequest: initialPullRequest ?? null,
            pendingPullRequestAssociation: null,
            reviewSnapshot: event.payload.reviewSnapshot ?? null,
            reviewResult: null,
            validationRun: null,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            latestChildNotificationAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          if (initialPullRequest !== undefined && initialPullRequest !== null) {
            yield* projectionThreadPullRequestRepository.upsert({
              threadId: event.payload.threadId,
              pullRequest: initialPullRequest,
              source: source ?? "recovered",
              linkedAt: event.payload.createdAt,
            });
          }
          return;

        case "thread.archived": {
          if (event.payload.worktreeCleanup !== undefined) {
            yield* worktreeCleanupJobRepository.enqueue({
              threadId: event.payload.threadId,
              cwd: event.payload.worktreeCleanup.cwd,
              worktreePath: event.payload.worktreeCleanup.path,
              canonicalWorktreePath: yield* Effect.promise(() =>
                canonicalizeWorktreePath(event.payload.worktreeCleanup!.path),
              ),
              requestedAt: event.payload.archivedAt,
              source: "archive",
              allowTerminalReset: true,
            });
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          // Archive can schedule destructive cleanup. Cancel any pending job for
          // this thread (or its path aliases) so unarchive cannot race a remove
          // that treats the restored thread as non-owning.
          // Missing-path clearing is done by ThreadDeletionReactor via
          // thread.meta.update so both projections clear the stale binding.
          yield* worktreeCleanupJobRepository.cancelByThreadId(event.payload.threadId);
          const worktreePath = existingRow.value.worktreePath;
          if (worktreePath !== null) {
            const canonicalPath = yield* Effect.promise(() =>
              canonicalizeWorktreePath(worktreePath),
            );
            const pendingJobs = yield* worktreeCleanupJobRepository.list();
            yield* Effect.forEach(
              pendingJobs,
              (job) =>
                Effect.promise(() => canonicalizeWorktreePath(job.worktreePath)).pipe(
                  Effect.flatMap((pendingPath) =>
                    pendingPath === canonicalPath
                      ? worktreeCleanupJobRepository.cancelByThreadId(job.threadId)
                      : Effect.void,
                  ),
                ),
              { concurrency: 4, discard: true },
            );
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.decoupled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            parentThreadId: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.nudging !== undefined ? { nudging: event.payload.nudging } : {}),
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.workspaceBinding !== undefined
              ? { workspaceBinding: event.payload.workspaceBinding }
              : {}),
            ...(event.payload.pullRequest !== undefined
              ? { pullRequest: event.payload.pullRequest }
              : {}),
            ...(event.payload.pendingPullRequestAssociation !== undefined
              ? { pendingPullRequestAssociation: event.payload.pendingPullRequestAssociation }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          if (event.payload.pullRequest !== undefined) {
            const existingLinks = yield* projectionThreadPullRequestRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            if (event.payload.pullRequest !== null) {
              const plan = planMetaUpdatedPullRequestLinks({
                existingLinks,
                existingLegacyPullRequest: existingRow.value.pullRequest,
                createdAt: existingRow.value.createdAt,
                nextPullRequest: event.payload.pullRequest,
                updatedAt: event.payload.updatedAt,
                source: event.payload.pullRequestSource,
              });
              if (plan.recoveredLegacyLink) {
                yield* projectionThreadPullRequestRepository.upsert({
                  threadId: event.payload.threadId,
                  ...plan.recoveredLegacyLink,
                });
              }
              const upserted = plan.allLinks.find((link) =>
                sameThreadPullRequest(link.pullRequest, event.payload.pullRequest!),
              )!;
              yield* projectionThreadPullRequestRepository.upsert({
                threadId: event.payload.threadId,
                ...upserted,
              });
            }
          }
          return;
        }

        case "thread.collaboration-request-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const requests = [
            ...(existingRow.value.collaborationRequests ?? []).filter(
              (request) => request.requestId !== event.payload.request.requestId,
            ),
            event.payload.request,
          ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            collaborationRequests: requests,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.collaboration-state-cleared": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            collaborationRequests: [],
            updatedAt: event.payload.clearedAt,
          });
          return;
        }

        case "thread.pull-request-linked": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadPullRequestRepository.upsert({
            threadId: event.payload.threadId,
            ...event.payload.link,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pendingPullRequestAssociation: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pull-request-unlinked": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadPullRequestRepository.delete({
            threadId: event.payload.threadId,
            pullRequest: event.payload.pullRequest,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(existingRow.value.pullRequest &&
            sameThreadPullRequest(existingRow.value.pullRequest, event.payload.pullRequest)
              ? { pullRequest: null }
              : {}),
            pendingPullRequestAssociation: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pull-request-rekeyed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadPullRequestRepository.delete({
            threadId: event.payload.threadId,
            pullRequest: event.payload.previousPullRequest,
          });
          yield* projectionThreadPullRequestRepository.upsert({
            threadId: event.payload.threadId,
            ...event.payload.link,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(existingRow.value.pullRequest &&
            sameThreadPullRequest(existingRow.value.pullRequest, event.payload.previousPullRequest)
              ? { pullRequest: event.payload.link.pullRequest }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            pendingRuntimeMode: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pending-runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pendingRuntimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          yield* projectionThreadPullRequestRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          if (event.payload.worktreeCleanup !== undefined) {
            yield* worktreeCleanupJobRepository.enqueue({
              threadId: event.payload.threadId,
              cwd: event.payload.worktreeCleanup.cwd,
              worktreePath: event.payload.worktreeCleanup.path,
              canonicalWorktreePath: yield* Effect.promise(() =>
                canonicalizeWorktreePath(event.payload.worktreeCleanup!.path),
              ),
              requestedAt: event.payload.deletedAt,
              source: "delete",
              allowTerminalReset: true,
            });
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.message-sent":
        case "thread.review-result-set":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested":
        case "thread.queued-turn-created":
        case "thread.queued-turn-updated":
        case "thread.queued-turn-deleted":
        case "thread.queued-turn-dispatched":
        case "thread.queued-turn-failed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.type === "thread.review-result-set"
              ? {
                  reviewResult: event.payload.result,
                  reviewSnapshot: event.payload.result.snapshot,
                }
              : {}),
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.child-lifecycle-notified": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.parentThreadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const latestChildNotificationAt =
            existingRow.value.latestChildNotificationAt !== null &&
            existingRow.value.latestChildNotificationAt > event.payload.createdAt
              ? existingRow.value.latestChildNotificationAt
              : event.payload.createdAt;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestChildNotificationAt,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const latestTurn =
            existingRow.value.latestTurnId === null
              ? Option.none()
              : yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: existingRow.value.latestTurnId,
                });
          if (
            Option.isSome(latestTurn) &&
            latestTurn.value.state === "running" &&
            event.payload.session.status !== "running"
          ) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...latestTurn.value,
              state: terminalTurnStateForSessionStatus(event.payload.session.status),
              completedAt: event.payload.session.updatedAt,
            });
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (event.payload.streaming) {
                return `${message.text}${event.payload.text}`;
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            sequence: previousMessage?.sequence ?? event.sequence,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            ...(event.payload.origin !== undefined
              ? { origin: event.payload.origin }
              : previousMessage?.origin !== undefined
                ? { origin: previousMessage.origin }
                : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          // Narrow key read: revert trimming never inspects text, attachments,
          // or origins, so full message rows are never decoded. Trimmed rows
          // are deleted by id; retained rows are left untouched instead of
          // being deleted and re-upserted one by one.
          const existingKeys = yield* projectionThreadMessageRepository.listRevertKeysByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingKeys.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retainedMessageIds = retainProjectionMessageIdsAfterRevert(
            existingKeys,
            existingTurns,
            event.payload.turnCount,
          );
          const trimmedMessageIds = existingKeys
            .map((key) => key.messageId)
            .filter((messageId) => !retainedMessageIds.has(messageId));
          if (trimmedMessageIds.length === 0) {
            return;
          }

          for (const chunk of chunkRevertTrimIds(trimmedMessageIds)) {
            yield* projectionThreadMessageRepository.deleteByMessageIds({
              threadId: event.payload.threadId,
              messageIds: chunk,
            });
          }
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          // Pure-SQL trim without payload hydration: retention is turn-based,
          // so the trimmed turn set is diffed in JS and deleted with chunked
          // IN lists. Retained rows are never rewritten.
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const presentTurnIds =
            yield* projectionThreadProposedPlanRepository.listTurnIdsByThreadId({
              threadId: event.payload.threadId,
            });
          const trimmedTurnIds = trimmedTurnIdsAfterRevert(
            presentTurnIds,
            retainedTurnIdsAfterRevert(existingTurns, event.payload.turnCount),
          );
          for (const chunk of chunkRevertTrimIds(trimmedTurnIds)) {
            yield* projectionThreadProposedPlanRepository.deleteByTurnIds({
              threadId: event.payload.threadId,
              turnIds: chunk,
            });
          }
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;
        case "thread.child-lifecycle-notified": {
          const activity = childLifecycleNotificationToActivity({
            eventId: event.eventId,
            payload: event.payload,
            sequence: event.sequence,
          });
          yield* projectionThreadActivityRepository.upsert({
            activityId: activity.id,
            threadId: event.payload.parentThreadId,
            turnId: activity.turnId,
            tone: activity.tone,
            kind: activity.kind,
            summary: activity.summary,
            payload: activity.payload,
            ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
            createdAt: activity.createdAt,
          });
          return;
        }

        case "thread.reverted": {
          // Pure-SQL trim without payload hydration: retention is turn-based,
          // so the trimmed turn set is diffed in JS and deleted with chunked
          // IN lists. Retained rows are never rewritten.
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const presentTurnIds = yield* projectionThreadActivityRepository.listTurnIdsByThreadId({
            threadId: event.payload.threadId,
          });
          const trimmedTurnIds = trimmedTurnIdsAfterRevert(
            presentTurnIds,
            retainedTurnIdsAfterRevert(existingTurns, event.payload.turnCount),
          );
          for (const chunk of chunkRevertTrimIds(trimmedTurnIds)) {
            yield* projectionThreadActivityRepository.deleteByTurnIds({
              threadId: event.payload.threadId,
              turnIds: chunk,
            });
          }
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event) {
      if (event.type !== "thread.session-set") {
        return;
      }
      const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
        threadId: event.payload.threadId,
      });
      const resumeCursor = Object.hasOwn(event.payload.session, "resumeCursor")
        ? (event.payload.session.resumeCursor ?? null)
        : Option.match(existingSession, {
            onNone: () => null,
            onSome: (session) => session.resumeCursor,
          });
      const activeMessageId = shouldPreserveActiveMessageId({
        activeTurnId: event.payload.session.activeTurnId,
        activeMessageId: event.payload.session.activeMessageId,
      })
        ? Option.match(existingSession, {
            onNone: () => null,
            onSome: (session) => session.activeMessageId ?? null,
          })
        : (event.payload.session.activeMessageId ?? null);
      if (
        event.payload.session.status !== "running" ||
        event.payload.session.activeTurnId === null
      ) {
        const previousActiveTurnId = Option.isSome(existingSession)
          ? existingSession.value.activeTurnId
          : null;
        if (previousActiveTurnId !== null) {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: previousActiveTurnId,
          });
          if (Option.isSome(existingTurn) && existingTurn.value.state === "running") {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: terminalTurnStateForSessionStatus(event.payload.session.status),
              completedAt: existingTurn.value.completedAt ?? event.occurredAt,
              startedAt: existingTurn.value.startedAt ?? event.occurredAt,
              requestedAt: existingTurn.value.requestedAt ?? event.occurredAt,
            });
          }
        }
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        activeMessageId,
        resumeCursor,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyQueuedTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyQueuedTurnsProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.queued-turn-created":
          yield* projectionQueuedTurnRepository.upsert({
            queuedTurnId: event.payload.queuedTurn.id,
            threadId: event.payload.threadId,
            messageId: event.payload.queuedTurn.message.messageId,
            text: event.payload.queuedTurn.message.text,
            attachments: event.payload.queuedTurn.message.attachments,
            origin: event.payload.queuedTurn.origin ?? null,
            modelSelection: event.payload.queuedTurn.modelSelection ?? null,
            titleSeed: event.payload.queuedTurn.titleSeed ?? null,
            runtimeMode: event.payload.queuedTurn.runtimeMode,
            interactionMode: event.payload.queuedTurn.interactionMode,
            sourceProposedPlanThreadId:
              event.payload.queuedTurn.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.queuedTurn.sourceProposedPlan?.planId ?? null,
            createdAt: event.payload.queuedTurn.createdAt,
            updatedAt: event.payload.queuedTurn.updatedAt,
            failedAt: event.payload.queuedTurn.failedAt,
            failureMessage: event.payload.queuedTurn.failureMessage,
          });
          return;

        case "thread.queued-turn-updated": {
          const existing = yield* projectionQueuedTurnRepository.getById({
            queuedTurnId: event.payload.queuedTurnId,
          });
          if (Option.isNone(existing)) {
            return;
          }
          yield* projectionQueuedTurnRepository.upsert({
            ...existing.value,
            text: event.payload.text,
            ...(event.payload.origin !== undefined ? { origin: event.payload.origin } : {}),
            updatedAt: event.payload.updatedAt,
            failedAt: null,
            failureMessage: null,
          });
          return;
        }

        case "thread.queued-turn-deleted":
        case "thread.queued-turn-dispatched":
          yield* projectionQueuedTurnRepository.deleteById({
            queuedTurnId: event.payload.queuedTurnId,
          });
          return;

        case "thread.queued-turn-failed": {
          const existing = yield* projectionQueuedTurnRepository.getById({
            queuedTurnId: event.payload.queuedTurnId,
          });
          if (Option.isNone(existing)) {
            return;
          }
          yield* projectionQueuedTurnRepository.upsert({
            ...existing.value,
            failedAt: event.payload.failedAt,
            failureMessage: event.payload.failureMessage,
            updatedAt: event.payload.failedAt,
          });
          return;
        }

        case "thread.deleted":
          yield* projectionQueuedTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        default:
          return;
      }
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
              threadId: event.payload.threadId,
            });
            const previousActiveTurnId = Option.isSome(existingSession)
              ? existingSession.value.activeTurnId
              : null;
            if (previousActiveTurnId === null) {
              return;
            }
            const existingTurn = yield* projectionTurnRepository.getByTurnId({
              threadId: event.payload.threadId,
              turnId: previousActiveTurnId,
            });
            if (Option.isNone(existingTurn) || existingTurn.value.state !== "running") {
              return;
            }
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: terminalTurnStateForSessionStatus(event.payload.session.status),
              completedAt: existingTurn.value.completedAt ?? event.occurredAt,
              startedAt: existingTurn.value.startedAt ?? event.occurredAt,
              requestedAt: existingTurn.value.requestedAt ?? event.occurredAt,
            });
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "running",
              completedAt: null,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
              checkpointAgentTouchedPaths: [],
              checkpointTurnFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming ? "running" : "completed",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : event.payload.updatedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
            checkpointAgentTouchedPaths: [],
            checkpointTurnFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
            checkpointAgentTouchedPaths: [],
            checkpointTurnFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId:
                event.payload.assistantMessageId ?? existingTurn.value.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              checkpointAgentTouchedPaths: event.payload.agentTouchedPaths,
              checkpointTurnFiles: event.payload.turnFiles,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
            checkpointAgentTouchedPaths: event.payload.agentTouchedPaths,
            checkpointTurnFiles: event.payload.turnFiles,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurnIds = new Set(
            selectRetainedTurnIds(existingTurns, event.payload.turnCount),
          );
          const keptTurns = existingTurns.filter(
            (turn) => turn.turnId !== null && keptTurnIds.has(turn.turnId),
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });

          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (!isActionableApprovalRequest(event.payload.activity.payload)) {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyWorkflowsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyWorkflowsProjection",
    )(function* (event) {
      switch (event.type) {
        case "workflow.run-requested":
          yield* projectionWorkflowRepository.upsertRun({
            ...event.payload.run,
            definition: event.payload.definition,
            workerConfig: event.payload.workerConfig,
          });
          return;

        case "workflow.artifact-created":
          yield* projectionWorkflowRepository.upsertArtifact(event.payload.artifact);
          if (
            event.payload.artifact.payload.kind === "input-context" &&
            event.payload.artifact.nodeId !== undefined
          ) {
            yield* projectionWorkflowRepository.setNodeInputArtifact({
              runId: event.payload.artifact.runId,
              nodeId: event.payload.artifact.nodeId,
              artifactId: event.payload.artifact.id,
              updatedAt: event.occurredAt,
            });
          }
          return;

        case "workflow.node-worker-started":
          yield* projectionWorkflowRepository.startNode({
            runId: event.payload.runId,
            nodeId: event.payload.nodeId,
            workerThreadId: event.payload.workerThreadId,
            startedAt: event.payload.startedAt,
          });
          return;

        case "workflow.worker-result-recorded":
          yield* projectionWorkflowRepository.upsertArtifact(event.payload.artifact);
          yield* projectionWorkflowRepository.recordNodeResult({
            runId: event.payload.runId,
            artifact: event.payload.artifact,
            completedAt: event.payload.completedAt,
          });
          return;

        case "workflow.run-finalized":
          yield* projectionWorkflowRepository.upsertArtifact(event.payload.artifact);
          yield* projectionWorkflowRepository.finalizeRun({
            runId: event.payload.runId,
            artifact: event.payload.artifact,
            status: event.payload.status,
            completedAt: event.payload.completedAt,
          });
          return;

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.queuedTurns,
        apply: applyQueuedTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.workflows,
        apply: applyWorkflowsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    // Bootstrap replays the event stream once for all projectors instead of
    // once per projector, and commits each batch of events in a single
    // transaction with one coalesced cursor upsert per projector. Projectors
    // whose cursor is ahead of an event skip it, so per-projector resume
    // positions are preserved.
    const runProjectorsForEventBatch = Effect.fn("runProjectorsForEventBatch")(function* (
      events: ReadonlyArray<OrchestrationEvent>,
      cursors: Map<ProjectorName, number>,
    ) {
      if (events.length === 0) {
        return emptyProjectionImpact();
      }

      const lastAppliedByProjector = new Map<ProjectorName, OrchestrationEvent>();
      let impact: ProjectionImpact = emptyProjectionImpact();

      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const event of events) {
            let eventApplied = false;
            for (const projector of projectors) {
              if (event.sequence <= (cursors.get(projector.name) ?? 0)) {
                continue;
              }
              yield* projector.apply(event);
              lastAppliedByProjector.set(projector.name, event);
              eventApplied = true;
            }
            if (eventApplied) {
              impact = mergeProjectionImpact(impact, projectionImpactForEvent(event));
            }
          }

          for (const [projectorName, lastApplied] of lastAppliedByProjector) {
            cursors.set(projectorName, lastApplied.sequence);
            yield* projectionStateRepository.upsert({
              projector: projectorName,
              lastAppliedSequence: lastApplied.sequence,
              updatedAt: lastApplied.occurredAt,
            });
          }
          const lastApplied = events.at(-1);
          if (
            lastApplied !== undefined &&
            (impact.shellThreadIds.size > 0 || impact.attachmentThreadIds.size > 0)
          ) {
            yield* reconciliationJobs.enqueue({
              sequence: lastApplied.sequence,
              shellThreadIds: [...impact.shellThreadIds],
              attachmentThreadIds: [...impact.attachmentThreadIds],
              createdAt: lastApplied.occurredAt,
            });
          }
        }),
      );
      return impact;
    });

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.gen(function* () {
      // Scar #131: prune retired projector cursor rows BEFORE computing
      // minCursor. A renamed projector left behind at sequence 0 would
      // otherwise pin the global minimum and replay gigabytes of event
      // history on every startup.
      yield* projectionStateRepository.deleteExcept({
        // The review handoff reactor shares this cursor store but is not a projector.
        projectors: [...projectors.map((projector) => projector.name), REVIEW_HANDOFF_PROJECTOR],
      });

      // Cursor reads are independent, so fan them out. Replay still commits
      // per BOOTSTRAP_EVENT_BATCH_SIZE batch (rows + cursors + intent
      // together per scar #10) and attachment cleanup still waits for the
      // entire replay via reconciler.drain below (scar #132).
      const cursorEntries = yield* Effect.all(
        projectors.map((projector) =>
          projectionStateRepository
            .getByProjector({ projector: projector.name })
            .pipe(
              Effect.map(
                (stateRow) =>
                  [
                    projector.name,
                    Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                  ] as const,
              ),
            ),
        ),
        { concurrency: "unbounded" },
      );
      const cursors = new Map<ProjectorName, number>(cursorEntries);
      const minCursor = cursors.size === 0 ? 0 : Math.min(...cursors.values());
      yield* Stream.runForEach(
        Stream.grouped(
          eventStore.readFromSequence(minCursor, Number.MAX_SAFE_INTEGER),
          BOOTSTRAP_EVENT_BATCH_SIZE,
        ),
        (events) => runProjectorsForEventBatch(events, cursors),
      );
      yield* reconciler.drain.pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.logWarning("projection attachment reconciliation remains pending", {
            error,
          }),
        ),
      );
    }).pipe(
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) => {
      const cursors = new Map<ProjectorName, number>(
        projectors.map((projector) => [projector.name, event.sequence - 1]),
      );
      return runProjectorsForEventBatch([event], cursors).pipe(
        Effect.as({ reconcile: reconciler.drain }),
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );
    };

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadPullRequestRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionQueuedTurnRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionWorkflowRepositoryLive),
  Layer.provideMerge(WorktreeCleanupJobRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(ProjectionReconciliationJobRepositoryLive),
  Layer.provideMerge(
    ProjectionReconcilerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          ProjectionThreadRepositoryLive,
          ProjectionThreadPullRequestRepositoryLive,
          ProjectionThreadMessageRepositoryLive,
          ProjectionThreadProposedPlanRepositoryLive,
          ProjectionThreadActivityRepositoryLive,
          ProjectionPendingApprovalRepositoryLive,
          ProjectionReconciliationJobRepositoryLive,
        ),
      ),
    ),
  ),
);
