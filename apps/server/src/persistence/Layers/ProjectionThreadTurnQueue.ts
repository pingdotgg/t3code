import { ModelSelection } from "@forma/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadTurnQueueByThreadInput,
  DeleteProjectionThreadTurnQueueItemInput,
  GetProjectionThreadTurnQueueItemInput,
  ListProjectionThreadTurnQueueByThreadInput,
  ProjectionThreadTurnQueueRepository,
  ProjectionThreadTurnQueueRow,
  type ProjectionThreadTurnQueueRepositoryShape,
} from "../Services/ProjectionThreadTurnQueue.ts";

const ProjectionThreadTurnQueueDbRow = ProjectionThreadTurnQueueRow.mapFields(
  Struct.assign({
    attachmentIds: Schema.fromJsonString(Schema.Array(Schema.String)),
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadTurnQueueRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadTurnQueueRow = SqlSchema.void({
    Request: ProjectionThreadTurnQueueRow,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_turn_queue (
          thread_id,
          message_id,
          text,
          attachment_ids_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          title_seed,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          queued_at,
          enqueue_sequence
        )
        VALUES (
          ${row.threadId},
          ${row.messageId},
          ${row.text},
          ${JSON.stringify(row.attachmentIds)},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.titleSeed},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.queuedAt},
          ${row.enqueueSequence}
        )
        ON CONFLICT (thread_id, message_id)
        DO UPDATE SET
          text = excluded.text,
          attachment_ids_json = excluded.attachment_ids_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          title_seed = excluded.title_seed,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          queued_at = excluded.queued_at,
          enqueue_sequence = excluded.enqueue_sequence
      `,
  });

  const getProjectionThreadTurnQueueRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadTurnQueueItemInput,
    Result: ProjectionThreadTurnQueueDbRow,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachment_ids_json AS "attachmentIds",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          title_seed AS "titleSeed",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          queued_at AS "queuedAt",
          enqueue_sequence AS "enqueueSequence"
        FROM projection_thread_turn_queue
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadTurnQueueRows = SqlSchema.findAll({
    Request: ListProjectionThreadTurnQueueByThreadInput,
    Result: ProjectionThreadTurnQueueDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachment_ids_json AS "attachmentIds",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          title_seed AS "titleSeed",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          queued_at AS "queuedAt",
          enqueue_sequence AS "enqueueSequence"
        FROM projection_thread_turn_queue
        WHERE thread_id = ${threadId}
        ORDER BY enqueue_sequence ASC, queued_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadTurnQueueRow = SqlSchema.void({
    Request: DeleteProjectionThreadTurnQueueItemInput,
    execute: ({ threadId, messageId }) =>
      sql`
        DELETE FROM projection_thread_turn_queue
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
      `,
  });

  const deleteProjectionThreadTurnQueueRowsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadTurnQueueByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_turn_queue
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadTurnQueueRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadTurnQueueRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadTurnQueueRepository.upsert:query",
          "ProjectionThreadTurnQueueRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getById: ProjectionThreadTurnQueueRepositoryShape["getById"] = (input) =>
    getProjectionThreadTurnQueueRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadTurnQueueRepository.getById:query",
          "ProjectionThreadTurnQueueRepository.getById:decodeRow",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadTurnQueueRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadTurnQueueRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadTurnQueueRepository.listByThreadId:query",
          "ProjectionThreadTurnQueueRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteById: ProjectionThreadTurnQueueRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadTurnQueueRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTurnQueueRepository.deleteById:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadTurnQueueRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadTurnQueueRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTurnQueueRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByThreadId,
    deleteById,
    deleteByThreadId,
  } satisfies ProjectionThreadTurnQueueRepositoryShape;
});

export const ProjectionThreadTurnQueueRepositoryLive = Layer.effect(
  ProjectionThreadTurnQueueRepository,
  makeProjectionThreadTurnQueueRepository,
);
