import { NonNegativeInt } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
  GetProjectionStateInput,
  ProjectionState,
} from "../Services/ProjectionState.ts";

const MinLastAppliedSequenceRowSchema = Schema.Struct({
  minLastAppliedSequence: Schema.NullOr(NonNegativeInt),
});

const makeProjectionStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionStateRow = SqlSchema.void({
    Request: ProjectionState,
    execute: (row) =>
      sql`
        INSERT INTO projection_state (
          projector,
          last_applied_sequence,
          updated_at
        )
        VALUES (
          ${row.projector},
          ${row.lastAppliedSequence},
          ${row.updatedAt}
        )
        ON CONFLICT (projector)
        DO UPDATE SET
          last_applied_sequence = excluded.last_applied_sequence,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionStateRow = SqlSchema.findOneOption({
    Request: GetProjectionStateInput,
    Result: ProjectionState,
    execute: ({ projector }) =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        WHERE projector = ${projector}
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionState,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        ORDER BY projector ASC
      `,
  });

  const readMinLastAppliedSequence = SqlSchema.findOne({
    Request: Schema.Void,
    Result: MinLastAppliedSequenceRowSchema,
    execute: () =>
      sql`
        SELECT
          MIN(last_applied_sequence) AS "minLastAppliedSequence"
        FROM projection_state
      `,
  });

  const upsert: ProjectionStateRepositoryShape["upsert"] = (row) =>
    upsertProjectionStateRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.upsert:query")),
    );

  const getByProjector: ProjectionStateRepositoryShape["getByProjector"] = (input) =>
    getProjectionStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.getByProjector:query")),
    );

  const listAll: ProjectionStateRepositoryShape["listAll"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.listAll:query")),
    );

  const minLastAppliedSequence: ProjectionStateRepositoryShape["minLastAppliedSequence"] = () =>
    readMinLastAppliedSequence(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionStateRepository.minLastAppliedSequence:query"),
      ),
      Effect.map((row) => row.minLastAppliedSequence),
    );

  return {
    upsert,
    getByProjector,
    listAll,
    minLastAppliedSequence,
  } satisfies ProjectionStateRepositoryShape;
});

export const ProjectionStateRepositoryLive = Layer.effect(
  ProjectionStateRepository,
  makeProjectionStateRepository,
);
