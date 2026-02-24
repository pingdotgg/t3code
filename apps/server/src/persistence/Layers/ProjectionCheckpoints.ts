import { OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  DeleteByThreadIdInput,
  GetByThreadAndTurnCountInput,
  ListByThreadIdInput,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  type ProjectionCheckpointRepositoryShape,
} from "../Services/ProjectionCheckpoints.ts";

const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionCheckpointRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionCheckpointRow = SqlSchema.void({
    Request: ProjectionCheckpointDbRowSchema,
    execute: (row) =>
      sql`
            INSERT INTO projection_checkpoints (
              thread_id,
              turn_id,
              checkpoint_turn_count,
              checkpoint_ref,
              status,
              files_json,
              assistant_message_id,
              completed_at
            )
            VALUES (
              ${row.threadId},
              ${row.turnId},
              ${row.checkpointTurnCount},
              ${row.checkpointRef},
              ${row.status},
              ${row.files},
              ${row.assistantMessageId},
              ${row.completedAt}
            )
            ON CONFLICT (thread_id, checkpoint_turn_count)
            DO UPDATE SET
              turn_id = excluded.turn_id,
              checkpoint_ref = excluded.checkpoint_ref,
              status = excluded.status,
              files_json = excluded.files_json,
              assistant_message_id = excluded.assistant_message_id,
              completed_at = excluded.completed_at
          `,
  });

  const listProjectionCheckpointRows = SqlSchema.findAll({
    Request: ListByThreadIdInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          status,
          files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_checkpoints
        WHERE thread_id = ${threadId}
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getProjectionCheckpointRow = SqlSchema.findOneOption({
    Request: GetByThreadAndTurnCountInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          status,
          files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_checkpoints
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
      `,
  });

  const deleteProjectionCheckpointRows = SqlSchema.void({
    Request: DeleteByThreadIdInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_checkpoints
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionCheckpointRepositoryShape["upsert"] = (row) =>
    upsertProjectionCheckpointRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.upsert:query",
          "ProjectionCheckpointRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionCheckpointRepositoryShape["listByThreadId"] = (input) =>
    listProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.listByThreadId:query",
          "ProjectionCheckpointRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpoint>>),
    );

  const getByThreadAndTurnCount: ProjectionCheckpointRepositoryShape["getByThreadAndTurnCount"] = (
    input,
  ) =>
    getProjectionCheckpointRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:query",
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionCheckpoint>)),
        }),
      ),
    );

  const deleteByThreadId: ProjectionCheckpointRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getByThreadAndTurnCount,
    deleteByThreadId,
  } satisfies ProjectionCheckpointRepositoryShape;
});

export const ProjectionCheckpointRepositoryLive = Layer.effect(
  ProjectionCheckpointRepository,
  makeProjectionCheckpointRepository,
);
