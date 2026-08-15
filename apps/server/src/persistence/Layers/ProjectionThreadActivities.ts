import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  ProjectionTaskLiveness,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
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
    Request: ProjectionThreadActivity,
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
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
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
              sequence = excluded.sequence,
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
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
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

  const listLatestTaskLivenessRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTaskLiveness,
    execute: () =>
      sql`
        WITH ranked_task_activity AS (
          SELECT
            activity.thread_id AS "threadId",
            json_extract(activity.payload_json, '$.taskId') AS "taskId",
            CASE
              WHEN json_type(activity.payload_json, '$.taskType') = 'text'
              THEN json_extract(activity.payload_json, '$.taskType')
              ELSE NULL
            END AS "taskType",
            CASE
              WHEN json_type(activity.payload_json, '$.status') = 'text'
              THEN json_extract(activity.payload_json, '$.status')
              ELSE NULL
            END AS "status",
            CASE
              WHEN json_type(activity.payload_json, '$.agentId') = 'text'
              THEN json_extract(activity.payload_json, '$.agentId')
              ELSE NULL
            END AS "agentId",
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY
                activity.thread_id,
                json_extract(activity.payload_json, '$.taskId')
              ORDER BY
                CASE WHEN activity.sequence IS NULL THEN 0 ELSE 1 END DESC,
                activity.sequence DESC,
                activity.created_at DESC,
                activity.activity_id DESC
            ) AS task_rank
          FROM projection_thread_activities AS activity
          INNER JOIN projection_threads AS thread
            ON thread.thread_id = activity.thread_id
          WHERE
            thread.deleted_at IS NULL
            AND thread.archived_at IS NULL
            AND activity.kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
            AND json_type(activity.payload_json, '$.taskId') = 'text'
            AND COALESCE(json_extract(activity.payload_json, '$.usageSnapshot'), 0) != 1
        )
        SELECT
          "threadId",
          "taskId",
          "taskType",
          "status",
          "agentId",
          kind
        FROM ranked_task_activity
        WHERE task_rank = 1
        ORDER BY "threadId" ASC, "taskId" ASC
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
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          createdAt: row.createdAt,
        })),
      ),
    );

  const listLatestTaskLiveness: ProjectionThreadActivityRepositoryShape["listLatestTaskLiveness"] =
    () =>
      listLatestTaskLivenessRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listLatestTaskLiveness:query",
            "ProjectionThreadActivityRepository.listLatestTaskLiveness:decodeRows",
          ),
        ),
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
    listLatestTaskLiveness,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
