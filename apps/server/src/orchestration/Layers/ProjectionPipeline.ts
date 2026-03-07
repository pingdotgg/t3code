import {
  ApprovalRequestId,
  type ChatAttachment,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
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
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn(
  (input: {
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) => Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn(function* (sideEffects: AttachmentSideEffects) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = path.join(serverConfig.stateDir, "attachments");

  yield* Effect.forEach(
    sideEffects.deletedThreadIds,
    (threadId) =>
      Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
            threadId,
          });
          return;
        }
        const entries = yield* fileSystem
          .readDirectory(attachmentsRootDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
              if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
                return;
              }
              const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
              if (!attachmentId) {
                return;
              }
              const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
              if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
                return;
              }
              yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
                force: true,
              });
            }),
          { concurrency: 1 },
        );
      }),
    { concurrency: 1 },
  );

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) => {
      if (sideEffects.deletedThreadIds.has(threadId)) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
          return;
        }
        const entries = yield* fileSystem
          .readDirectory(attachmentsRootDir, { recursive: false })
          .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
        yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
              if (relativePath.length === 0 || relativePath.includes("/")) {
                return;
              }
              const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
              if (!attachmentId) {
                return;
              }
              const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
              if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
                return;
              }

              const absolutePath = path.join(attachmentsRootDir, relativePath);
              const fileInfo = yield* fileSystem
                .stat(absolutePath)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              if (!fileInfo || fileInfo.type !== "File") {
                return;
              }

              if (!keptThreadRelativePaths.has(relativePath)) {
                yield* fileSystem.remove(absolutePath, { force: true });
              }
            }),
          { concurrency: 1 },
        );
      });
    },
    { concurrency: 1 },
  );

});

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event, _attachmentSideEffects) =>
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

  const applyThreadsProjection: ProjectorDefinition["apply"] = (event, attachmentSideEffects) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            model: event.payload.model,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
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
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
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
        case "thread.proposed-plan-upserted":
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

  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = (
    event,
    attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const existingMessage = existingRows.find(
            (row) => row.messageId === event.payload.messageId,
          );
          const nextText =
            existingMessage && event.payload.streaming
              ? `${existingMessage.text}${event.payload.text}`
              : existingMessage && event.payload.text.length === 0
                ? existingMessage.text
                : event.payload.text;
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : existingMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: existingMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

  const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
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

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      if (event.type !== "thread.session-set") {
        return;
      }
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
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
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
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
              state: event.payload.streaming
                ? existingTurn.value.state
                : existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed",
              completedAt: event.payload.streaming
                ? existingTurn.value.completedAt
                : (existingTurn.value.completedAt ?? event.payload.updatedAt),
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming ? "running" : "completed",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.streaming ? null : event.payload.updatedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
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
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
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
              assistantMessageId: event.payload.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
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
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
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

  const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
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
    Effect.gen(function* () {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

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
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
    projectors,
    bootstrapProjector,
    { concurrency: 1 },
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ServerConfig, serverConfig),
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
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
