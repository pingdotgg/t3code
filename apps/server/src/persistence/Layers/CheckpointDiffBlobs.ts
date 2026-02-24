import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  CheckpointDiffBlobRepository,
  CheckpointDiffBlob,
  GetCheckpointDiffBlobInput,
  type CheckpointDiffBlobRepositoryShape,
} from "../Services/CheckpointDiffBlobs.ts";

const makeCheckpointDiffBlobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertDiffBlobRow = SqlSchema.void({
    Request: CheckpointDiffBlob,
    execute: (blob) =>
      sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id,
          from_turn_count,
          to_turn_count,
          diff,
          created_at
        )
        VALUES (
          ${blob.threadId},
          ${blob.fromTurnCount},
          ${blob.toTurnCount},
          ${blob.diff},
          ${blob.createdAt}
        )
        ON CONFLICT (thread_id, from_turn_count, to_turn_count)
        DO UPDATE SET
          diff = excluded.diff,
          created_at = excluded.created_at
      `,
  });

  const getDiffBlobRow = SqlSchema.findOneOption({
    Request: GetCheckpointDiffBlobInput,
    Result: CheckpointDiffBlob,
    execute: (request) =>
      sql`
        SELECT
          thread_id AS "threadId",
          from_turn_count AS "fromTurnCount",
          to_turn_count AS "toTurnCount",
          diff,
          created_at AS "createdAt"
        FROM checkpoint_diff_blobs
        WHERE thread_id = ${request.threadId}
          AND from_turn_count = ${request.fromTurnCount}
          AND to_turn_count = ${request.toTurnCount}
      `,
  });

  const upsert: CheckpointDiffBlobRepositoryShape["upsert"] = (blob) =>
    upsertDiffBlobRow(blob).pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointDiffBlobRepository.upsert:query")),
    );

  const get: CheckpointDiffBlobRepositoryShape["get"] = (input) =>
    getDiffBlobRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointDiffBlobRepository.get:query")),
    );

  return {
    upsert,
    get,
  } satisfies CheckpointDiffBlobRepositoryShape;
});

export const CheckpointDiffBlobRepositoryLive = Layer.effect(
  CheckpointDiffBlobRepository,
  makeCheckpointDiffBlobRepository,
);
