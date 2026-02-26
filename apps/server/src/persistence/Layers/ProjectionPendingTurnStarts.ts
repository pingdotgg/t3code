import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionPendingTurnStartInput,
  GetProjectionPendingTurnStartInput,
  ProjectionPendingTurnStart,
  ProjectionPendingTurnStartRepository,
  type ProjectionPendingTurnStartRepositoryShape,
} from "../Services/ProjectionPendingTurnStarts.ts";

const makeProjectionPendingTurnStartRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPendingTurnStartRow = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_pending_turn_starts (
          thread_id,
          message_id,
          created_at
        )
        VALUES (
          ${row.threadId},
          ${row.messageId},
          ${row.createdAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          message_id = excluded.message_id,
          created_at = excluded.created_at
      `,
  });

  const getProjectionPendingTurnStartRow = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          message_id AS "messageId",
          created_at AS "createdAt"
        FROM projection_pending_turn_starts
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionPendingTurnStartRow = SqlSchema.void({
    Request: DeleteProjectionPendingTurnStartInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_pending_turn_starts
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionPendingTurnStartRepositoryShape["upsert"] = (row) =>
    upsertProjectionPendingTurnStartRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPendingTurnStartRepository.upsert:query")),
    );

  const getByThreadId: ProjectionPendingTurnStartRepositoryShape["getByThreadId"] = (input) =>
    getProjectionPendingTurnStartRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingTurnStartRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionPendingTurnStartRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionPendingTurnStartRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingTurnStartRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionPendingTurnStartRepositoryShape;
});

export const ProjectionPendingTurnStartRepositoryLive = Layer.effect(
  ProjectionPendingTurnStartRepository,
  makeProjectionPendingTurnStartRepository,
);
