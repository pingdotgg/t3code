import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { ProjectionsReadCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectionTurns from "../../persistence/Services/ProjectionTurns.ts";
import * as ProjectionThreadMessages from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as ProjectionThreadActivities from "../../persistence/Services/ProjectionThreadActivities.ts";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2_000;

const boundedLimit = (limit: number | undefined) =>
  Math.max(0, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));

function toMessage(row: ProjectionThreadMessages.ProjectionThreadMessage): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.attachments === undefined ? {} : { attachments: row.attachments }),
    turnId: row.turnId,
    streaming: row.isStreaming,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toActivity(
  row: ProjectionThreadActivities.ProjectionThreadActivity,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.sequence === undefined ? {} : { sequence: row.sequence }),
    createdAt: row.createdAt,
  };
}

export function makeProjectionsReadCapability(input: {
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly turns: ProjectionTurns.ProjectionTurnRepository["Service"];
  readonly messages: ProjectionThreadMessages.ProjectionThreadMessageRepository["Service"];
  readonly activities: ProjectionThreadActivities.ProjectionThreadActivityRepository["Service"];
}): ProjectionsReadCapability {
  return {
    getThreadShellById: (threadId) =>
      input.snapshots.getThreadShellById(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (thread) => thread,
          }),
        ),
      ),
    getThreadDetailById: (threadId) =>
      input.snapshots.getThreadDetailById(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (thread) => thread,
          }),
        ),
      ),
    listTurnsByThreadId: ({ threadId, limit }) =>
      input.turns
        .listByThreadId({ threadId })
        .pipe(Effect.map((rows) => rows.slice(0, boundedLimit(limit)))),
    listMessagesByThreadId: ({ threadId, limit }) =>
      input.messages
        .listByThreadId({ threadId })
        .pipe(Effect.map((rows) => rows.slice(0, boundedLimit(limit)).map(toMessage))),
    getMessageById: (messageId) =>
      input.messages.getByMessageId({ messageId }).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: toMessage,
          }),
        ),
      ),
    listActivitiesByThreadId: ({ threadId, limit }) =>
      input.activities
        .listByThreadId({ threadId })
        .pipe(Effect.map((rows) => rows.slice(0, boundedLimit(limit)).map(toActivity))),
  };
}
