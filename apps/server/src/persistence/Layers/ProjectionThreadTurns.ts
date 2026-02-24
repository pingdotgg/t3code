import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadTurn,
  ProjectionThreadTurnRepository,
  type ProjectionThreadTurnRepositoryShape,
  DeleteProjectionThreadTurnsInput,
  GetProjectionThreadTurnInput,
  ListProjectionThreadTurnsInput,
} from "../Services/ProjectionThreadTurns.ts";

const makeProjectionThreadTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadTurnRow = SqlSchema.void({
    Request: ProjectionThreadTurn,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_turns (
          turn_id,
          thread_id,
          turn_count,
          status,
          user_message_id,
          assistant_message_id,
          started_at,
          completed_at
        )
        VALUES (
          ${row.turnId},
          ${row.threadId},
          ${row.turnCount},
          ${row.status},
          ${row.userMessageId},
          ${row.assistantMessageId},
          ${row.startedAt},
          ${row.completedAt}
        )
        ON CONFLICT (turn_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_count = excluded.turn_count,
          status = excluded.status,
          user_message_id = excluded.user_message_id,
          assistant_message_id = excluded.assistant_message_id,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
      `,
  });

  const listProjectionThreadTurnRows = SqlSchema.findAll({
    Request: ListProjectionThreadTurnsInput,
    Result: ProjectionThreadTurn,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turn_id AS "turnId",
          thread_id AS "threadId",
          turn_count AS "turnCount",
          status,
          user_message_id AS "userMessageId",
          assistant_message_id AS "assistantMessageId",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_thread_turns
        WHERE thread_id = ${threadId}
        ORDER BY turn_count ASC
      `,
  });

  const getProjectionThreadTurnRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadTurnInput,
    Result: ProjectionThreadTurn,
    execute: ({ turnId }) =>
      sql`
        SELECT
          turn_id AS "turnId",
          thread_id AS "threadId",
          turn_count AS "turnCount",
          status,
          user_message_id AS "userMessageId",
          assistant_message_id AS "assistantMessageId",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_thread_turns
        WHERE turn_id = ${turnId}
      `,
  });

  const deleteProjectionThreadTurnRows = SqlSchema.void({
    Request: DeleteProjectionThreadTurnsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadTurnRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadTurnRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTurnRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadTurnRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTurnRepository.listByThreadId:query")),
    );

  const getByTurnId: ProjectionThreadTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionThreadTurnRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadTurnRepository.getByTurnId:query")),
    );

  const deleteByThreadId: ProjectionThreadTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadTurnRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadTurnRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getByTurnId,
    deleteByThreadId,
  } satisfies ProjectionThreadTurnRepositoryShape;
});

export const ProjectionThreadTurnRepositoryLive = Layer.effect(
  ProjectionThreadTurnRepository,
  makeProjectionThreadTurnRepository,
);
