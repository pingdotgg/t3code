import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import { ChatAttachment, MessageOrigin, OrchestrationMessageContext } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadMessagesByIdsInput,
  GetLatestUserMessageAtInput,
  GetProjectionThreadMessageInput,
  ListProjectionThreadMessagePagesInput,
  ProjectionThreadMessageAttachmentRef,
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRevertKey,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    origin: Schema.NullOr(Schema.fromJsonString(MessageOrigin)),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    ...(row.sequence !== null && row.sequence !== undefined ? { sequence: row.sequence } : {}),
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.origin !== null ? { origin: row.origin } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextOriginJson = row.origin !== undefined ? JSON.stringify(row.origin) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          sequence,
          turn_id,
          role,
          text,
          attachments_json,
          origin_json,
          context_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.sequence ?? null},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextOriginJson},
            (
              SELECT origin_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextContextJson},
            (
              SELECT context_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          sequence = COALESCE(excluded.sequence, projection_thread_messages.sequence),
          turn_id = COALESCE(excluded.turn_id, projection_thread_messages.turn_id),
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          origin_json = COALESCE(
            excluded.origin_json,
            projection_thread_messages.origin_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          sequence,
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          sequence,
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  // History reads filter and cap in SQL before any payload is decoded:
  // only rows after the cursor are selected, and never more than the limit.
  const listProjectionThreadMessagePageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagePagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, afterCreatedAt, afterMessageId, limit }) =>
      afterCreatedAt !== undefined && afterMessageId !== undefined
        ? sql`
          SELECT
            message_id AS "messageId",
            thread_id AS "threadId",
            sequence,
            turn_id AS "turnId",
            role,
            text,
            attachments_json AS "attachments",
            origin_json AS "origin",
            context_json AS "context",
            is_streaming AS "isStreaming",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND (created_at, message_id) > (${afterCreatedAt}, ${afterMessageId})
          ORDER BY created_at ASC, message_id ASC
          LIMIT ${limit}
        `
        : sql`
          SELECT
            message_id AS "messageId",
            thread_id AS "threadId",
            sequence,
            turn_id AS "turnId",
            role,
            text,
            attachments_json AS "attachments",
            origin_json AS "origin",
            context_json AS "context",
            is_streaming AS "isStreaming",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
          ORDER BY created_at ASC, message_id ASC
          LIMIT ${limit}
        `,
  });

  // Revert trimming only inspects identity/ordering columns: text,  // attachments, and origins are never selected or JSON-decoded.
  const listProjectionThreadMessageRevertKeyRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageRevertKey,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role,
          created_at AS "createdAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const ProjectionThreadMessageAttachmentRefDbRowSchema =
    ProjectionThreadMessageAttachmentRef.mapFields(
      Struct.assign({
        attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
      }),
    );

  // Attachment reconciliation only needs attachment references: message text
  // and origins are never selected or decoded.
  const listProjectionThreadMessageAttachmentRefRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageAttachmentRefDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          attachments_json AS "attachments"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOne({
    Request: GetLatestUserMessageAtInput,
    Result: Schema.Struct({ latestUserMessageAt: Schema.NullOr(Schema.String) }),
    execute: ({ threadId }) =>
      sql`
        SELECT
          MAX(created_at) AS "latestUserMessageAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadMessageRowsByIds = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesByIdsInput,
    execute: ({ threadId, messageIds }) =>
      messageIds.length === 0
        ? sql`DELETE FROM projection_thread_messages WHERE 1 = 0`
        : sql`
          DELETE FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND message_id IN ${sql.in(messageIds)}
        `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const listMessagesPage: ProjectionThreadMessageRepositoryShape["listMessagesPage"] = (input) =>
    listProjectionThreadMessagePageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listMessagesPage:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const listRevertKeysByThreadId: ProjectionThreadMessageRepositoryShape["listRevertKeysByThreadId"] =
    (input) =>
      listProjectionThreadMessageRevertKeyRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadMessageRepository.listRevertKeysByThreadId:query"),
        ),
      );

  const listAttachmentRefsByThreadId: ProjectionThreadMessageRepositoryShape["listAttachmentRefsByThreadId"] =
    (input) =>
      listProjectionThreadMessageAttachmentRefRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.listAttachmentRefsByThreadId:query",
          ),
        ),
      );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByMessageIds: ProjectionThreadMessageRepositoryShape["deleteByMessageIds"] = (
    input,
  ) =>
    deleteProjectionThreadMessageRowsByIds(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByMessageIds:query"),
      ),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map((row) => row.latestUserMessageAt),
    );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    listMessagesPage,
    listRevertKeysByThreadId,
    listAttachmentRefsByThreadId,
    deleteByThreadId,
    deleteByMessageIds,
    getLatestUserMessageAt,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
