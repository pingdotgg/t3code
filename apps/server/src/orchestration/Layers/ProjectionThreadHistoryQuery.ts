import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationThreadHistoryPage,
  PositiveInt,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type OrchestrationThreadHistoryOutline,
  type OrchestrationThreadMessageCursor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ThreadMessagePageLookupInput = Schema.Struct({
  threadId: ThreadId,
  cursorCreatedAt: IsoDateTime,
  cursorMessageId: MessageId,
  fetchLimit: PositiveInt,
});
const ThreadTurnPageLookupInput = Schema.Struct({
  threadId: ThreadId,
  mode: Schema.Literals(["latest", "before", "after", "around"]),
  cursorCreatedAt: Schema.NullOr(IsoDateTime),
  cursorMessageId: Schema.NullOr(MessageId),
  fetchLimit: PositiveInt,
});
const ThreadMessageCursorLookupInput = Schema.Struct({
  threadId: ThreadId,
  cursorCreatedAt: IsoDateTime,
  cursorMessageId: MessageId,
});
const ThreadMessageIdLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
const ThreadHistoryRangeLookupInput = Schema.Struct({
  threadId: ThreadId,
  startCreatedAt: IsoDateTime,
  endCreatedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadMessageCountRowSchema = Schema.Struct({
  count: NonNegativeInt,
});
const ProjectionThreadHistoryLandmarkRowSchema = Schema.Struct({
  messageId: MessageId,
  ordinal: NonNegativeInt,
  messageIndex: NonNegativeInt,
  createdAt: IsoDateTime,
  preview: Schema.String,
  totalUserMessages: NonNegativeInt,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function mapThreadMessageRow(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  const message = {
    id: row.messageId,
    role: row.role,
    text: row.text,
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.attachments === null
    ? message
    : Object.assign(message, { attachments: row.attachments });
}

function mapThreadActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  const activity = {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
  return row.sequence === null ? activity : Object.assign(activity, { sequence: row.sequence });
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlan>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const makeProjectionThreadHistoryQuery = Effect.fn("ProjectionThreadHistoryQuery.make")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const getActiveThread = SqlSchema.findOneOption({
      Request: ThreadIdLookupInput,
      Result: ProjectionThreadIdLookupRowSchema,
      execute: ({ threadId }) =>
        sql`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
    });
    const countMessageRows = SqlSchema.findOne({
      Request: ThreadIdLookupInput,
      Result: ProjectionThreadMessageCountRowSchema,
      execute: ({ threadId }) =>
        sql`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
    });
    const countMessageRowsBefore = SqlSchema.findOne({
      Request: ThreadMessageCursorLookupInput,
      Result: ProjectionThreadMessageCountRowSchema,
      execute: ({ threadId, cursorCreatedAt, cursorMessageId }) =>
        sql`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (created_at, message_id) < (${cursorCreatedAt}, ${cursorMessageId})
      `,
    });
    const countMessageRowsThrough = SqlSchema.findOne({
      Request: ThreadMessageCursorLookupInput,
      Result: ProjectionThreadMessageCountRowSchema,
      execute: ({ threadId, cursorCreatedAt, cursorMessageId }) =>
        sql`
        SELECT COUNT(*) AS count
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (created_at, message_id) <= (${cursorCreatedAt}, ${cursorMessageId})
      `,
    });
    const listMessageRowsAfter = SqlSchema.findAll({
      Request: ThreadMessagePageLookupInput,
      Result: ProjectionThreadMessageDbRowSchema,
      execute: ({ threadId, cursorCreatedAt, cursorMessageId, fetchLimit }) =>
        sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (created_at, message_id) > (${cursorCreatedAt}, ${cursorMessageId})
        ORDER BY created_at ASC, message_id ASC
        LIMIT ${fetchLimit}
      `,
    });
    const listTurnMessageRows = SqlSchema.findAll({
      Request: ThreadTurnPageLookupInput,
      Result: ProjectionThreadMessageDbRowSchema,
      execute: ({ threadId, mode, cursorCreatedAt, cursorMessageId, fetchLimit }) =>
        sql`
        WITH user_messages AS (
          SELECT
            created_at,
            message_id,
            ROW_NUMBER() OVER (ORDER BY created_at ASC, message_id ASC) - 1 AS ordinal,
            COUNT(*) OVER () AS total
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND role = 'user'
        ),
        stats AS (
          SELECT COALESCE(MAX(total), 0) AS total
          FROM user_messages
        ),
        window_start AS (
          SELECT CASE ${mode}
            WHEN 'latest' THEN MAX(0, total - ${fetchLimit})
            WHEN 'before' THEN MAX(
              0,
              (
                SELECT COUNT(*)
                FROM user_messages
                WHERE (created_at, message_id) < (${cursorCreatedAt}, ${cursorMessageId})
              ) - ${fetchLimit}
            )
            WHEN 'after' THEN (
              SELECT COUNT(*)
              FROM user_messages
              WHERE (created_at, message_id) <= (${cursorCreatedAt}, ${cursorMessageId})
            )
            ELSE MAX(
              0,
              MIN(
                COALESCE(
                  (
                    SELECT ordinal
                    FROM user_messages
                    WHERE (created_at, message_id) <= (${cursorCreatedAt}, ${cursorMessageId})
                    ORDER BY created_at DESC, message_id DESC
                    LIMIT 1
                  ),
                  0
                ) - CAST((${fetchLimit} - 1) / 2 AS INTEGER),
                total - ${fetchLimit}
              )
            )
          END AS ordinal,
          total
          FROM stats
        ),
        window AS (
          SELECT
            ordinal AS start_ordinal,
            CASE ${mode}
              WHEN 'before' THEN (
                SELECT COUNT(*)
                FROM user_messages
                WHERE (created_at, message_id) < (${cursorCreatedAt}, ${cursorMessageId})
              )
              ELSE MIN(total, ordinal + ${fetchLimit})
            END AS end_ordinal,
            total
          FROM window_start
        ),
        start_boundary AS (
          SELECT created_at, message_id
          FROM user_messages
          WHERE ordinal = (SELECT start_ordinal FROM window)
        ),
        end_boundary AS (
          SELECT created_at, message_id
          FROM user_messages
          WHERE ordinal = (SELECT end_ordinal FROM window)
        )
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (
            (SELECT total FROM window) = 0
            OR (
              (created_at, message_id) >= (
                SELECT created_at, message_id FROM start_boundary
              )
              AND (
                NOT EXISTS (SELECT 1 FROM end_boundary)
                OR (created_at, message_id) < (
                  SELECT created_at, message_id FROM end_boundary
                )
              )
            )
          )
        ORDER BY created_at ASC, message_id ASC
      `,
    });
    const getMessageRowById = SqlSchema.findOneOption({
      Request: ThreadMessageIdLookupInput,
      Result: ProjectionThreadMessageDbRowSchema,
      execute: ({ threadId, messageId }) =>
        sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        LIMIT 1
      `,
    });
    const listActivityRowsInRange = SqlSchema.findAll({
      Request: ThreadHistoryRangeLookupInput,
      Result: ProjectionThreadActivityDbRowSchema,
      execute: ({ threadId, startCreatedAt, endCreatedAt }) =>
        sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          CASE
            WHEN json_extract(payload_json, '$.itemType') = 'command_execution'
              THEN json_remove(payload_json, '$.data.item.aggregatedOutput')
            ELSE payload_json
          END AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND created_at >= ${startCreatedAt}
          AND (${endCreatedAt} IS NULL OR created_at < ${endCreatedAt})
        ORDER BY sequence ASC, created_at ASC, activity_id ASC
      `,
    });
    const listProposedPlanRowsInRange = SqlSchema.findAll({
      Request: ThreadHistoryRangeLookupInput,
      Result: ProjectionThreadProposedPlan,
      execute: ({ threadId, startCreatedAt, endCreatedAt }) =>
        sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
          AND created_at >= ${startCreatedAt}
          AND (${endCreatedAt} IS NULL OR created_at < ${endCreatedAt})
        ORDER BY created_at ASC, plan_id ASC
      `,
    });
    const listHistoryLandmarkRows = SqlSchema.findAll({
      Request: ThreadIdLookupInput,
      Result: ProjectionThreadHistoryLandmarkRowSchema,
      execute: ({ threadId }) =>
        sql`
        WITH message_order AS (
          SELECT
            message_id,
            role,
            created_at,
            ROW_NUMBER() OVER (ORDER BY created_at ASC, message_id ASC) - 1 AS message_index
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
        ),
        user_messages AS (
          SELECT
            message_id,
            created_at,
            message_index,
            ROW_NUMBER() OVER (ORDER BY created_at ASC, message_id ASC) - 1 AS ordinal,
            COUNT(*) OVER () AS total_user_messages
          FROM message_order
          WHERE role = 'user'
        )
        SELECT
          user_messages.message_id AS "messageId",
          user_messages.ordinal,
          user_messages.message_index AS "messageIndex",
          user_messages.created_at AS "createdAt",
          substr(messages.text, 1, 240) AS preview,
          user_messages.total_user_messages AS "totalUserMessages"
        FROM user_messages
        INNER JOIN projection_thread_messages AS messages
          ON messages.message_id = user_messages.message_id
        ORDER BY user_messages.ordinal ASC
      `,
    });

    const loadRange = Effect.fn("ProjectionThreadHistoryQuery.loadRange")(function* (input: {
      readonly threadId: ThreadId;
      readonly startCreatedAt: string;
      readonly endCreatedAt: string | null;
    }) {
      const [activityRows, proposedPlanRows] = yield* Effect.all([
        listActivityRowsInRange(input),
        listProposedPlanRowsInRange(input),
      ]).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadHistoryQuery.loadRange:query",
            "ProjectionThreadHistoryQuery.loadRange:decodeRows",
          ),
        ),
      );
      return {
        activities: activityRows.map(mapThreadActivityRow),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
      };
    });
    const getTurnPageByCursor = Effect.fn("ProjectionThreadHistoryQuery.getTurnPageByCursor")(
      function* (
        input:
          | {
              readonly threadId: ThreadId;
              readonly mode: "latest";
              readonly cursor: null;
              readonly limit: number;
            }
          | {
              readonly threadId: ThreadId;
              readonly mode: "before" | "after" | "around";
              readonly cursor: OrchestrationThreadMessageCursor;
              readonly limit: number;
            },
      ) {
        const [thread, rows, totalMessageCount] = yield* Effect.all([
          getActiveThread({ threadId: input.threadId }),
          listTurnMessageRows({
            threadId: input.threadId,
            mode: input.mode,
            cursorCreatedAt: input.cursor?.createdAt ?? null,
            cursorMessageId: input.cursor?.messageId ?? null,
            fetchLimit: input.limit,
          }),
          countMessageRows({ threadId: input.threadId }),
        ]).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionThreadHistoryQuery.getTurnPageByCursor:query",
              "ProjectionThreadHistoryQuery.getTurnPageByCursor:decodeRows",
            ),
          ),
        );
        if (Option.isNone(thread)) {
          return Option.none<OrchestrationThreadHistoryPage>();
        }

        const firstRow = rows[0];
        const lastRow = rows.at(-1);
        const startIndex =
          firstRow === undefined
            ? input.cursor === null
              ? totalMessageCount.count
              : (yield* (
                  input.mode === "after"
                    ? countMessageRowsThrough({
                        threadId: input.threadId,
                        cursorCreatedAt: input.cursor.createdAt,
                        cursorMessageId: input.cursor.messageId,
                      })
                    : countMessageRowsBefore({
                        threadId: input.threadId,
                        cursorCreatedAt: input.cursor.createdAt,
                        cursorMessageId: input.cursor.messageId,
                      })
                ).pipe(
                  Effect.mapError(
                    toPersistenceSqlOrDecodeError(
                      "ProjectionThreadHistoryQuery.getTurnPageByCursor:countEmptyPage:query",
                      "ProjectionThreadHistoryQuery.getTurnPageByCursor:countEmptyPage:decodeRow",
                    ),
                  ),
                )).count
            : (yield* countMessageRowsBefore({
                threadId: input.threadId,
                cursorCreatedAt: firstRow.createdAt,
                cursorMessageId: firstRow.messageId,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionThreadHistoryQuery.getTurnPageByCursor:countBefore:query",
                    "ProjectionThreadHistoryQuery.getTurnPageByCursor:countBefore:decodeRow",
                  ),
                ),
              )).count;
        const nextRow =
          lastRow === undefined || input.mode === "latest"
            ? undefined
            : (yield* listMessageRowsAfter({
                threadId: input.threadId,
                cursorCreatedAt: lastRow.createdAt,
                cursorMessageId: lastRow.messageId,
                fetchLimit: 1,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionThreadHistoryQuery.getTurnPageByCursor:nextBoundary:query",
                    "ProjectionThreadHistoryQuery.getTurnPageByCursor:nextBoundary:decodeRow",
                  ),
                ),
              ))[0];
        const endIndex = startIndex + rows.length;
        const historyRange =
          firstRow === undefined
            ? { activities: [], proposedPlans: [] }
            : yield* loadRange({
                threadId: input.threadId,
                startCreatedAt: firstRow.createdAt,
                endCreatedAt:
                  input.mode === "before" ? input.cursor.createdAt : (nextRow?.createdAt ?? null),
              });
        return Option.some({
          messages: rows.map(mapThreadMessageRow),
          activities: historyRange.activities,
          proposedPlans: historyRange.proposedPlans,
          messageHistory: {
            hasMoreBefore: startIndex > 0,
            hasMoreAfter: endIndex < totalMessageCount.count,
            startIndex,
            endIndex,
            totalMessages: totalMessageCount.count,
            cursor:
              firstRow === undefined
                ? null
                : {
                    createdAt: firstRow.createdAt,
                    messageId: firstRow.messageId,
                  },
          },
        });
      },
    );
    const getLatestTurnPage = (input: { readonly threadId: ThreadId; readonly limit: number }) =>
      getTurnPageByCursor({ ...input, mode: "latest", cursor: null });
    const getTurnPage = (input: {
      readonly threadId: ThreadId;
      readonly before: OrchestrationThreadMessageCursor;
      readonly limit: number;
    }) => getTurnPageByCursor({ ...input, mode: "before", cursor: input.before });
    const getTurnPageAfter = (input: {
      readonly threadId: ThreadId;
      readonly after: OrchestrationThreadMessageCursor;
      readonly limit: number;
    }) => getTurnPageByCursor({ ...input, mode: "after", cursor: input.after });
    const getTurnPageAround = Effect.fn("ProjectionThreadHistoryQuery.getTurnPageAround")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly limit: number;
      }) {
        const target = yield* getMessageRowById({
          threadId: input.threadId,
          messageId: input.messageId,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionThreadHistoryQuery.getTurnPageAround:targetQuery",
              "ProjectionThreadHistoryQuery.getTurnPageAround:decodeTarget",
            ),
          ),
        );
        if (Option.isNone(target)) {
          return Option.none<OrchestrationThreadHistoryPage>();
        }
        return yield* getTurnPageByCursor({
          ...input,
          mode: "around",
          cursor: {
            createdAt: target.value.createdAt,
            messageId: target.value.messageId,
          },
        });
      },
    );
    const getHistoryOutline = Effect.fn("ProjectionThreadHistoryQuery.getHistoryOutline")(
      function* (threadId: ThreadId) {
        const [thread, rows] = yield* Effect.all([
          getActiveThread({ threadId }),
          listHistoryLandmarkRows({ threadId }),
        ]).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionThreadHistoryQuery.getHistoryOutline:query",
              "ProjectionThreadHistoryQuery.getHistoryOutline:decodeRows",
            ),
          ),
        );
        if (Option.isNone(thread)) {
          return Option.none<OrchestrationThreadHistoryOutline>();
        }

        return Option.some({
          totalUserMessages: rows[0]?.totalUserMessages ?? 0,
          landmarks: rows.map((row) => ({
            messageId: row.messageId,
            ordinal: row.ordinal,
            messageIndex: row.messageIndex,
            createdAt: row.createdAt,
            preview: row.preview,
          })),
        });
      },
    );

    return {
      getLatestTurnPage,
      getTurnPage,
      getTurnPageAfter,
      getTurnPageAround,
      getHistoryOutline,
    };
  },
);
