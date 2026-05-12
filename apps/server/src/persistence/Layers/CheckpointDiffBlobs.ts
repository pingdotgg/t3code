import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointDiffBlob,
  CheckpointDiffBlobRepository,
  type CheckpointDiffBlobRepositoryShape,
  DeleteCheckpointDiffBlobsByThreadIdInput,
  GetCheckpointDiffBlobInput,
} from "../Services/CheckpointDiffBlobs.ts";

const makeCheckpointDiffBlobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertCheckpointDiffBlob = SqlSchema.void({
    Request: CheckpointDiffBlob,
    execute: (row) =>
      sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id,
          from_turn_count,
          to_turn_count,
          diff,
          created_at
        )
        VALUES (
          ${row.threadId},
          ${row.fromTurnCount},
          ${row.toTurnCount},
          ${row.diff},
          ${row.createdAt}
        )
        ON CONFLICT (thread_id, from_turn_count, to_turn_count)
        DO UPDATE SET
          diff = excluded.diff,
          created_at = excluded.created_at
      `,
  });

  const getCheckpointDiffBlob = SqlSchema.findOneOption({
    Request: GetCheckpointDiffBlobInput,
    Result: CheckpointDiffBlob,
    execute: ({ threadId, fromTurnCount, toTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          from_turn_count AS "fromTurnCount",
          to_turn_count AS "toTurnCount",
          diff,
          created_at AS "createdAt"
        FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
          AND from_turn_count = ${fromTurnCount}
          AND to_turn_count = ${toTurnCount}
      `,
  });

  const deleteCheckpointDiffBlobsByThreadId = SqlSchema.void({
    Request: DeleteCheckpointDiffBlobsByThreadIdInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: CheckpointDiffBlobRepositoryShape["upsert"] = (row) =>
    upsertCheckpointDiffBlob(row).pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointDiffBlobRepository.upsert:query")),
    );

  const get: CheckpointDiffBlobRepositoryShape["get"] = (input) =>
    getCheckpointDiffBlob(input).pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointDiffBlobRepository.get:query")),
    );

  const deleteByThreadId: CheckpointDiffBlobRepositoryShape["deleteByThreadId"] = (input) =>
    deleteCheckpointDiffBlobsByThreadId(input).pipe(
      Effect.mapError(toPersistenceSqlError("CheckpointDiffBlobRepository.deleteByThreadId:query")),
    );

  return {
    upsert,
    get,
    deleteByThreadId,
  } satisfies CheckpointDiffBlobRepositoryShape;
});

export const CheckpointDiffBlobRepositoryLive = Layer.effect(
  CheckpointDiffBlobRepository,
  makeCheckpointDiffBlobRepository,
);
