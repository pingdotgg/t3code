import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadWorkUnitsInput,
  ListProjectionThreadWorkUnitsInput,
  ProjectionThreadWorkUnit,
  ProjectionThreadWorkUnitRepository,
  type ProjectionThreadWorkUnitRepositoryShape,
} from "../Services/ProjectionThreadWorkUnits.ts";

const ProjectionThreadWorkUnitDbRowSchema = ProjectionThreadWorkUnit.mapFields(
  Struct.assign({
    providerRefs: Schema.NullOr(
      Schema.fromJsonString(ProjectionThreadWorkUnit.fields.providerRefs),
    ),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadWorkUnitRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadWorkUnitRow = SqlSchema.void({
    Request: ProjectionThreadWorkUnit,
    execute: (row) => sql`
      INSERT INTO projection_thread_work_units (
        work_unit_id,
        thread_id,
        turn_id,
        parent_work_unit_id,
        kind,
        state,
        title,
        detail,
        spawned_by_activity_id,
        provider_refs_json,
        started_at,
        updated_at,
        completed_at
      )
      VALUES (
        ${row.workUnitId},
        ${row.threadId},
        ${row.turnId},
        ${row.parentWorkUnitId},
        ${row.kind},
        ${row.state},
        ${row.title},
        ${row.detail},
        ${row.spawnedByActivityId},
        ${row.providerRefs ? JSON.stringify(row.providerRefs) : null},
        ${row.startedAt},
        ${row.updatedAt},
        ${row.completedAt}
      )
      ON CONFLICT (work_unit_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        parent_work_unit_id = excluded.parent_work_unit_id,
        kind = excluded.kind,
        state = excluded.state,
        title = excluded.title,
        detail = excluded.detail,
        spawned_by_activity_id = excluded.spawned_by_activity_id,
        provider_refs_json = excluded.provider_refs_json,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `,
  });

  const listProjectionThreadWorkUnitRows = SqlSchema.findAll({
    Request: ListProjectionThreadWorkUnitsInput,
    Result: ProjectionThreadWorkUnitDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        work_unit_id AS "workUnitId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        parent_work_unit_id AS "parentWorkUnitId",
        kind,
        state,
        title,
        detail,
        spawned_by_activity_id AS "spawnedByActivityId",
        provider_refs_json AS "providerRefs",
        started_at AS "startedAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM projection_thread_work_units
      WHERE thread_id = ${threadId}
      ORDER BY started_at ASC, work_unit_id ASC
    `,
  });

  const deleteProjectionThreadWorkUnitRows = SqlSchema.void({
    Request: DeleteProjectionThreadWorkUnitsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_work_units
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadWorkUnitRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadWorkUnitRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadWorkUnitRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadWorkUnitRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadWorkUnitRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadWorkUnitRepository.listByThreadId:query",
          "ProjectionThreadWorkUnitRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          workUnitId: row.workUnitId,
          threadId: row.threadId,
          turnId: row.turnId,
          parentWorkUnitId: row.parentWorkUnitId,
          kind: row.kind,
          state: row.state,
          title: row.title,
          detail: row.detail,
          spawnedByActivityId: row.spawnedByActivityId,
          ...(row.providerRefs !== null ? { providerRefs: row.providerRefs } : {}),
          startedAt: row.startedAt,
          updatedAt: row.updatedAt,
          completedAt: row.completedAt,
        })),
      ),
    );

  const deleteByThreadId: ProjectionThreadWorkUnitRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadWorkUnitRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadWorkUnitRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadWorkUnitRepositoryShape;
});

export const ProjectionThreadWorkUnitRepositoryLive = Layer.effect(
  ProjectionThreadWorkUnitRepository,
  makeProjectionThreadWorkUnitRepository,
);
