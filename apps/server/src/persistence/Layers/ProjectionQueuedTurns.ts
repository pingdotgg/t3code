import { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionQueuedTurn,
  ProjectionQueuedTurnIdInput,
  ProjectionQueuedTurnRepository,
  type ProjectionQueuedTurnRepositoryShape,
  ProjectionQueuedTurnsByThreadInput,
} from "../Services/ProjectionQueuedTurns.ts";

const ProjectionQueuedTurnDbRowSchema = ProjectionQueuedTurn.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);

function toProjectionQueuedTurn(
  row: Schema.Schema.Type<typeof ProjectionQueuedTurnDbRowSchema>,
): ProjectionQueuedTurn {
  return {
    ...row,
    attachments: [...row.attachments],
  };
}

const makeProjectionQueuedTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionQueuedTurn,
    execute: (row) => sql`
      INSERT INTO projection_queued_turns (
        queued_turn_id,
        thread_id,
        message_id,
        text,
        attachments_json,
        model_selection_json,
        title_seed,
        runtime_mode,
        interaction_mode,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        created_at,
        updated_at,
        failed_at,
        failure_message
      )
      VALUES (
        ${row.queuedTurnId},
        ${row.threadId},
        ${row.messageId},
        ${row.text},
        ${JSON.stringify(row.attachments)},
        ${row.modelSelection === null ? null : JSON.stringify(row.modelSelection)},
        ${row.titleSeed},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.sourceProposedPlanThreadId},
        ${row.sourceProposedPlanId},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.failedAt},
        ${row.failureMessage}
      )
      ON CONFLICT (queued_turn_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        text = excluded.text,
        attachments_json = excluded.attachments_json,
        model_selection_json = excluded.model_selection_json,
        title_seed = excluded.title_seed,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
        source_proposed_plan_id = excluded.source_proposed_plan_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        failed_at = excluded.failed_at,
        failure_message = excluded.failure_message
    `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: ProjectionQueuedTurnIdInput,
    Result: ProjectionQueuedTurnDbRowSchema,
    execute: ({ queuedTurnId }) => sql`
      SELECT
        queued_turn_id AS "queuedTurnId",
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        title_seed AS "titleSeed",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        failed_at AS "failedAt",
        failure_message AS "failureMessage"
      FROM projection_queued_turns
      WHERE queued_turn_id = ${queuedTurnId}
      LIMIT 1
    `,
  });

  const listRowsByThreadId = SqlSchema.findAll({
    Request: ProjectionQueuedTurnsByThreadInput,
    Result: ProjectionQueuedTurnDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        queued_turn_id AS "queuedTurnId",
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        title_seed AS "titleSeed",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        failed_at AS "failedAt",
        failure_message AS "failureMessage"
      FROM projection_queued_turns
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, queued_turn_id ASC
    `,
  });

  const deleteRowById = SqlSchema.void({
    Request: ProjectionQueuedTurnIdInput,
    execute: ({ queuedTurnId }) => sql`
      DELETE FROM projection_queued_turns
      WHERE queued_turn_id = ${queuedTurnId}
    `,
  });

  const deleteRowsByThreadId = SqlSchema.void({
    Request: ProjectionQueuedTurnsByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_queued_turns
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionQueuedTurnRepository.upsert:query")),
      ),
    getById: (input) =>
      getRowById(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionQueuedTurnRepository.getById:query")),
        Effect.map(Option.map(toProjectionQueuedTurn)),
      ),
    listByThreadId: (input) =>
      listRowsByThreadId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionQueuedTurnRepository.listByThreadId:query"),
        ),
        Effect.map((rows) => rows.map(toProjectionQueuedTurn)),
      ),
    deleteById: (input) =>
      deleteRowById(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionQueuedTurnRepository.deleteById:query")),
      ),
    deleteByThreadId: (input) =>
      deleteRowsByThreadId(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionQueuedTurnRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionQueuedTurnRepositoryShape;
});

export const ProjectionQueuedTurnRepositoryLive = Layer.effect(
  ProjectionQueuedTurnRepository,
  makeProjectionQueuedTurnRepository,
);
