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
        WITH task_activity AS (
          SELECT
            activity.thread_id AS thread_id,
            json_extract(activity.payload_json, '$.taskId') AS task_id,
            CASE
              WHEN json_type(activity.payload_json, '$.taskType') = 'text'
              THEN json_extract(activity.payload_json, '$.taskType')
              ELSE NULL
            END AS task_type,
            CASE
              WHEN json_type(activity.payload_json, '$.status') = 'text'
              THEN json_extract(activity.payload_json, '$.status')
              ELSE NULL
            END AS task_status,
            CASE
              WHEN json_type(activity.payload_json, '$.agentId') = 'text'
              THEN json_extract(activity.payload_json, '$.agentId')
              ELSE NULL
            END AS agent_id,
            activity.kind,
            activity.sequence,
            activity.created_at,
            activity.activity_id
          FROM projection_thread_activities AS activity
          INNER JOIN projection_threads AS thread
            ON thread.thread_id = activity.thread_id
          WHERE
            thread.deleted_at IS NULL
            AND thread.archived_at IS NULL
            AND activity.kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
            AND json_type(activity.payload_json, '$.taskId') = 'text'
            AND COALESCE(json_extract(activity.payload_json, '$.usageSnapshot'), 0) != 1
        ),
        ranked_task_activity AS (
          SELECT
            task.*,
            ROW_NUMBER() OVER (
              PARTITION BY
                task.thread_id,
                task.task_id
              ORDER BY
                task.created_at DESC,
                CASE WHEN task.sequence IS NULL THEN 0 ELSE 1 END DESC,
                task.sequence DESC,
                task.activity_id DESC
            ) AS task_rank
          FROM task_activity AS task
        )
        SELECT
          latest.thread_id AS "threadId",
          latest.task_id AS "taskId",
          (
            SELECT known.task_type
            FROM task_activity AS known
            WHERE known.thread_id = latest.thread_id
              AND known.task_id = latest.task_id
              AND known.task_type IS NOT NULL
            ORDER BY
              known.created_at DESC,
              CASE WHEN known.sequence IS NULL THEN 0 ELSE 1 END DESC,
              known.sequence DESC,
              known.activity_id DESC
            LIMIT 1
          ) AS "taskType",
          (
            SELECT known.task_status
            FROM task_activity AS known
            WHERE known.thread_id = latest.thread_id
              AND known.task_id = latest.task_id
              AND known.task_status IS NOT NULL
            ORDER BY
              known.created_at DESC,
              CASE WHEN known.sequence IS NULL THEN 0 ELSE 1 END DESC,
              known.sequence DESC,
              known.activity_id DESC
            LIMIT 1
          ) AS "status",
          (
            SELECT known.agent_id
            FROM task_activity AS known
            WHERE known.thread_id = latest.thread_id
              AND known.task_id = latest.task_id
              AND known.agent_id IS NOT NULL
            ORDER BY
              known.created_at DESC,
              CASE WHEN known.sequence IS NULL THEN 0 ELSE 1 END DESC,
              known.sequence DESC,
              known.activity_id DESC
            LIMIT 1
          ) AS "agentId",
          latest.kind
        FROM ranked_task_activity AS latest
        WHERE latest.task_rank = 1
        ORDER BY latest.thread_id ASC, latest.task_id ASC
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
