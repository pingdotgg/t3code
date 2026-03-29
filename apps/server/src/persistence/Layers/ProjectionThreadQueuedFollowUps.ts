import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import {
  ChatAttachment,
  ModelSelection,
  OrchestrationQueuedTerminalContext,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadQueuedFollowUpsInput,
  GetProjectionThreadQueuedFollowUpInput,
  ListProjectionThreadQueuedFollowUpsInput,
  ProjectionThreadQueuedFollowUp,
  ProjectionThreadQueuedFollowUpRepository,
  type ProjectionThreadQueuedFollowUpRepositoryShape,
} from "../Services/ProjectionThreadQueuedFollowUps.ts";

const ProjectionThreadQueuedFollowUpDbRowSchema = ProjectionThreadQueuedFollowUp.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    terminalContexts: Schema.fromJsonString(Schema.Array(OrchestrationQueuedTerminalContext)),
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);

const makeProjectionThreadQueuedFollowUpRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listQueuedFollowUpRows = SqlSchema.findAll({
    Request: ListProjectionThreadQueuedFollowUpsInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          follow_up_id AS "followUpId",
          thread_id AS "threadId",
          queue_position AS "queuePosition",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          prompt,
          attachments_json AS "attachments",
          terminal_contexts_json AS "terminalContexts",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          last_send_error AS "lastSendError"
        FROM projection_thread_queued_follow_ups
        WHERE thread_id = ${threadId}
        ORDER BY queue_position ASC, created_at ASC, follow_up_id ASC
      `,
  });

  const getQueuedFollowUpRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadQueuedFollowUpInput,
    Result: ProjectionThreadQueuedFollowUpDbRowSchema,
    execute: ({ followUpId }) =>
      sql`
        SELECT
          follow_up_id AS "followUpId",
          thread_id AS "threadId",
          queue_position AS "queuePosition",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          prompt,
          attachments_json AS "attachments",
          terminal_contexts_json AS "terminalContexts",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          last_send_error AS "lastSendError"
        FROM projection_thread_queued_follow_ups
        WHERE follow_up_id = ${followUpId}
      `,
  });

  const deleteQueuedFollowUpsByThreadId = SqlSchema.void({
    Request: DeleteProjectionThreadQueuedFollowUpsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_queued_follow_ups
        WHERE thread_id = ${threadId}
      `,
  });

  const insertQueuedFollowUpRow = SqlSchema.void({
    Request: ProjectionThreadQueuedFollowUp,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_queued_follow_ups (
          follow_up_id,
          thread_id,
          queue_position,
          created_at,
          updated_at,
          prompt,
          attachments_json,
          terminal_contexts_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          last_send_error
        )
        VALUES (
          ${row.followUpId},
          ${row.threadId},
          ${row.queuePosition},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.prompt},
          ${JSON.stringify(row.attachments)},
          ${JSON.stringify(row.terminalContexts)},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.lastSendError}
        )
      `,
  });

  const listByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["listByThreadId"] = (input) =>
    listQueuedFollowUpRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.listByThreadId:query"),
      ),
    );

  const getById: ProjectionThreadQueuedFollowUpRepositoryShape["getById"] = (input) =>
    getQueuedFollowUpRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.getById:query"),
      ),
    );

  const replaceByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["replaceByThreadId"] = (
    input,
  ) =>
    Effect.gen(function* () {
      yield* deleteQueuedFollowUpsByThreadId({ threadId: input.threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadQueuedFollowUpRepository.replaceByThreadId:delete",
          ),
        ),
      );
      yield* Effect.forEach(input.followUps, (followUp) =>
        insertQueuedFollowUpRow(followUp).pipe(
          Effect.mapError(
            toPersistenceSqlError(
              "ProjectionThreadQueuedFollowUpRepository.replaceByThreadId:insert",
            ),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const deleteByThreadId: ProjectionThreadQueuedFollowUpRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteQueuedFollowUpsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadQueuedFollowUpRepository.deleteByThreadId:query"),
      ),
    );

  return {
    listByThreadId,
    getById,
    replaceByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadQueuedFollowUpRepositoryShape;
});

export const ProjectionThreadQueuedFollowUpRepositoryLive = Layer.effect(
  ProjectionThreadQueuedFollowUpRepository,
  makeProjectionThreadQueuedFollowUpRepository,
);
