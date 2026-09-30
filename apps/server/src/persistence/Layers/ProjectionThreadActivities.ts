import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { EventId, IsoDateTime, NonNegativeInt, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import { compactActivityPayload } from "../activityPayloadBlob.ts";

import {
  DeleteProjectionThreadActivitiesByTurnIdsInput,
  DeleteProjectionThreadActivitiesInput,
  HasProjectionThreadActivityKindForTurnInput,
  ListProjectionThreadActivitiesInput,
  ListProjectionThreadUserInputActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
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

  const upsertActivityPayloadBlob = (input: {
    readonly activityId: string;
    readonly dataJson: string;
    readonly sizeBytes: number;
    readonly createdAt: string;
  }) =>
    sql`
      INSERT INTO activity_payload_blobs (
        activity_id,
        data_json,
        size_bytes,
        created_at,
        updated_at
      )
      VALUES (
        ${input.activityId},
        ${input.dataJson},
        ${input.sizeBytes},
        ${input.createdAt},
        ${input.createdAt}
      )
      ON CONFLICT (activity_id) DO NOTHING
    `;

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          CASE
            WHEN blobs.data_json IS NULL THEN activities.payload_json
            ELSE json_set(activities.payload_json, '$.data', json(blobs.data_json))
          END AS "payload",
          activities.sequence,
          activities.created_at AS "createdAt"
        FROM projection_thread_activities AS activities
        LEFT JOIN activity_payload_blobs AS blobs
          ON blobs.activity_id = activities.activity_id
        WHERE activities.thread_id = ${threadId}
        ORDER BY
          CASE WHEN activities.sequence IS NULL THEN 0 ELSE 1 END ASC,
          activities.sequence ASC,
          activities.created_at ASC,
          activities.activity_id ASC
      `,
  });

  const getProjectionThreadActivityRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ProjectionThreadActivity.fields.threadId,
      activityId: EventId,
    }),
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, activityId }) =>
      sql`
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          CASE
            WHEN blobs.data_json IS NULL THEN activities.payload_json
            ELSE json_set(activities.payload_json, '$.data', json(blobs.data_json))
          END AS "payload",
          activities.sequence,
          activities.created_at AS "createdAt"
        FROM projection_thread_activities AS activities
        LEFT JOIN activity_payload_blobs AS blobs
          ON blobs.activity_id = activities.activity_id
        WHERE activities.thread_id = ${threadId}
          AND activities.activity_id = ${activityId}
        LIMIT 1
      `,
  });

  const ProjectionThreadUserInputActivityDbRowSchema = Schema.Struct({
    activityId: EventId,
    kind: Schema.String,
    payload: Schema.fromJsonString(Schema.Unknown),
    createdAt: IsoDateTime,
  });

  const listProjectionThreadUserInputActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadUserInputActivitiesInput,
    Result: ProjectionThreadUserInputActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          kind,
          payload_json AS "payload",
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind IN (
            'user-input.requested',
            'user-input.resolved',
            'provider.user-input.respond.failed'
          )
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

  const deleteProjectionThreadActivityRowsByTurnIds = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesByTurnIdsInput,
    execute: ({ threadId, turnIds }) =>
      turnIds.length === 0
        ? sql`DELETE FROM projection_thread_activities WHERE 1 = 0`
        : sql`
          DELETE FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND turn_id IN ${sql.in(turnIds)}
        `,
  });

  const listProjectionThreadActivityTurnIds = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: Schema.Struct({ turnId: TurnId }),
    execute: ({ threadId }) =>
      sql`
        SELECT DISTINCT turn_id AS "turnId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY turn_id ASC
      `,
  });

  const hasProjectionThreadActivityKindForTurn = SqlSchema.findOne({
    Request: HasProjectionThreadActivityKindForTurnInput,
    Result: Schema.Struct({ found: Schema.Number }),
    execute: ({ threadId, turnId, kind }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND kind = ${kind}
        ) AS found
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) => {
    const compacted = compactActivityPayload(row.kind, row.payload);
    const storedRow = { ...row, payload: compacted.payload };
    const activityDataJson = compacted.dataJson;
    const persist =
      activityDataJson === null
        ? upsertProjectionThreadActivityRow(storedRow)
        : sql.withTransaction(
            Effect.gen(function* () {
              yield* upsertActivityPayloadBlob({
                activityId: row.activityId,
                dataJson: activityDataJson,
                sizeBytes: compacted.sizeBytes,
                createdAt: row.createdAt,
              });
              yield* upsertProjectionThreadActivityRow(storedRow);
            }),
          );
    return persist.pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );
  };

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

  const getById: ProjectionThreadActivityRepositoryShape["getById"] = (input) =>
    getProjectionThreadActivityRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.getById:query",
          "ProjectionThreadActivityRepository.getById:decodeRow",
        ),
      ),
      Effect.map(
        Option.map((row) => ({
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

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByTurnIds: ProjectionThreadActivityRepositoryShape["deleteByTurnIds"] = (input) =>
    deleteProjectionThreadActivityRowsByTurnIds(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByTurnIds:query"),
      ),
    );

  const listTurnIdsByThreadId: ProjectionThreadActivityRepositoryShape["listTurnIdsByThreadId"] = (
    input,
  ) =>
    listProjectionThreadActivityTurnIds(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.listTurnIdsByThreadId:query"),
      ),
      Effect.map((rows) => rows.map((row) => row.turnId)),
    );

  const listUserInputLifecycleByThreadId: ProjectionThreadActivityRepositoryShape["listUserInputLifecycleByThreadId"] =
    (input) =>
      listProjectionThreadUserInputActivityRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:query",
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:decodeRows",
          ),
        ),
      );

  const hasKindForTurn: ProjectionThreadActivityRepositoryShape["hasKindForTurn"] = (input) =>
    hasProjectionThreadActivityKindForTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.hasKindForTurn:query",
          "ProjectionThreadActivityRepository.hasKindForTurn:decodeRow",
        ),
      ),
      Effect.map((row) => row.found === 1),
    );

  return {
    upsert,
    listByThreadId,
    getById,
    listTurnIdsByThreadId,
    deleteByThreadId,
    deleteByTurnIds,
    listUserInputLifecycleByThreadId,
    hasKindForTurn,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
