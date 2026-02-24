import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivityDbRowSchema,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${row.payload},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              created_at = excluded.created_at
          `,
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, activity_id ASC
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadActivity>>),
    );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
