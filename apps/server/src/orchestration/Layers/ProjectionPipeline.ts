import {
  ApprovalRequestId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepository } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { type ProjectionThreadTurn } from "../../persistence/Services/ProjectionThreadTurns.ts";
import { ProjectionThreadTurnRepository } from "../../persistence/Services/ProjectionThreadTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionCheckpointRepositoryLive } from "../../persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadTurnRepositoryLive } from "../../persistence/Layers/ProjectionThreadTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function nextTurnCount(turns: ReadonlyArray<ProjectionThreadTurn>): number {
  return turns.reduce((maxTurnCount, turn) => Math.max(maxTurnCount, turn.turnCount), 0) + 1;
}

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionThreadTurnRepository = yield* ProjectionThreadTurnRepository;
  const projectionCheckpointRepository = yield* ProjectionCheckpointRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
  const pendingTurnStartByThreadId = new Map<
    string,
    {
      readonly messageId: NonNullable<ProjectionThreadTurn["userMessageId"]>;
      readonly createdAt: string;
    }
  >();

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModel: event.payload.defaultModel,
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
            ...(event.payload.defaultModel !== undefined
              ? { defaultModel: event.payload.defaultModel }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
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

  const applyThreadsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            model: event.payload.model,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
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
        case "thread.activity-appended": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
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
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.session.activeTurnId,
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

  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "thread.message-sent") {
        return;
      }
      const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
        threadId: event.payload.threadId,
      });
      const existingMessage = existingRows.find((row) => row.messageId === event.payload.messageId);
      const nextText =
        existingMessage && event.payload.streaming
          ? `${existingMessage.text}${event.payload.text}`
          : event.payload.text;
      yield* projectionThreadMessageRepository.upsert({
        messageId: event.payload.messageId,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        role: event.payload.role,
        text: nextText,
        isStreaming: event.payload.streaming,
        createdAt: existingMessage?.createdAt ?? event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      });
    });

  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "thread.activity-appended") {
        return;
      }
      yield* projectionThreadActivityRepository.upsert({
        activityId: event.payload.activity.id,
        threadId: event.payload.threadId,
        turnId: event.payload.activity.turnId,
        tone: event.payload.activity.tone,
        kind: event.payload.activity.kind,
        summary: event.payload.activity.summary,
        payload: event.payload.activity.payload,
        createdAt: event.payload.activity.createdAt,
      });
    });

  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerSessionId: event.payload.session.providerSessionId,
        providerThreadId: event.payload.session.providerThreadId,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          pendingTurnStartByThreadId.set(event.payload.threadId, {
            messageId: event.payload.messageId,
            createdAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            return;
          }

          const existingTurn = yield* projectionThreadTurnRepository.getByTurnId({ turnId });
          const pendingTurnStart = pendingTurnStartByThreadId.get(event.payload.threadId);
          if (Option.isSome(existingTurn)) {
            yield* projectionThreadTurnRepository.upsert({
              ...existingTurn.value,
              status: existingTurn.value.status === "completed" ? "completed" : "running",
              userMessageId: existingTurn.value.userMessageId ?? (pendingTurnStart?.messageId ?? null),
              startedAt: existingTurn.value.startedAt,
            });
          } else {
            const existingThreadTurns = yield* projectionThreadTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* projectionThreadTurnRepository.upsert({
              turnId,
              threadId: event.payload.threadId,
              turnCount: nextTurnCount(existingThreadTurns),
              status: "running",
              userMessageId: pendingTurnStart?.messageId ?? null,
              assistantMessageId: null,
              startedAt: pendingTurnStart?.createdAt ?? event.occurredAt,
              completedAt: null,
            });
          }

          pendingTurnStartByThreadId.delete(event.payload.threadId);
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionThreadTurnRepository.getByTurnId({
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionThreadTurnRepository.upsert({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              status: event.payload.streaming
                ? existingTurn.value.status
                : existingTurn.value.status === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.status === "error"
                    ? "error"
                    : "completed",
              completedAt: event.payload.streaming
                ? existingTurn.value.completedAt
                : (existingTurn.value.completedAt ?? event.payload.updatedAt),
            });
            return;
          }
          const existingThreadTurns = yield* projectionThreadTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadTurnRepository.upsert({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            turnCount: nextTurnCount(existingThreadTurns),
            status: event.payload.streaming ? "running" : "completed",
            userMessageId: null,
            assistantMessageId: event.payload.messageId,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : event.payload.updatedAt,
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionThreadTurnRepository.getByTurnId({
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionThreadTurnRepository.upsert({
              ...existingTurn.value,
              status: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
            });
            return;
          }
          const existingThreadTurns = yield* projectionThreadTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* projectionThreadTurnRepository.upsert({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            turnCount: nextTurnCount(existingThreadTurns),
            status: "interrupted",
            userMessageId: null,
            assistantMessageId: null,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionThreadTurnRepository.getByTurnId({
            turnId: event.payload.turnId,
          });
          const nextStatus = event.payload.status === "error" ? "error" : "completed";
          if (Option.isSome(existingTurn)) {
            yield* projectionThreadTurnRepository.upsert({
              ...existingTurn.value,
              turnCount: event.payload.checkpointTurnCount,
              status: nextStatus,
              assistantMessageId: event.payload.assistantMessageId,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionThreadTurnRepository.upsert({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            turnCount: event.payload.checkpointTurnCount,
            status: nextStatus,
            userMessageId: null,
            assistantMessageId: event.payload.assistantMessageId,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionThreadTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) => turn.turnCount <= event.payload.turnCount,
          );
          yield* projectionThreadTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptTurns, projectionThreadTurnRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-diff-completed":
          yield* projectionCheckpointRepository.upsert({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            status: event.payload.status,
            files: event.payload.files,
            assistantMessageId: event.payload.assistantMessageId,
            completedAt: event.payload.completedAt,
          });
          return;

        case "thread.reverted": {
          const existingCheckpoints = yield* projectionCheckpointRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptCheckpoints = existingCheckpoints.filter(
            (checkpoint) => checkpoint.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionCheckpointRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptCheckpoints, projectionCheckpointRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
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
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      apply: applyThreadActivitiesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
      apply: applyThreadSessionsProjection,
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
      name: ORCHESTRATION_PROJECTOR_NAMES.threads,
      apply: applyThreadsProjection,
    },
  ];

  const runProjectorForEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
    sql.withTransaction(
      projector.apply(event).pipe(
        Effect.flatMap(() =>
          projectionStateRepository.upsert({
            projector: projector.name,
            lastAppliedSequence: event.sequence,
            updatedAt: event.occurredAt,
          }),
        ),
      ),
    );

  const bootstrapProjector = (projector: ProjectorDefinition) =>
    projectionStateRepository
      .getByProjector({
        projector: projector.name,
      })
      .pipe(
        Effect.flatMap((stateRow) =>
          Stream.runForEach(
            eventStore.readFromSequence(
              Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
            ),
            (event) => runProjectorForEvent(projector, event),
          ),
        ),
      );

  const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
    Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
      concurrency: 1,
    }).pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
    projectors,
    bootstrapProjector,
    {
      concurrency: 1,
    },
  ).pipe(
    Effect.asVoid,
    Effect.tap(() =>
      Effect.log("orchestration projection pipeline bootstrapped").pipe(
        Effect.annotateLogs({ projectors: projectors.length }),
      ),
    ),
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
    ),
  );

  return {
    bootstrap,
    projectEvent,
  } satisfies OrchestrationProjectionPipelineShape;
});

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline,
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionThreadTurnRepositoryLive),
  Layer.provideMerge(ProjectionCheckpointRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
