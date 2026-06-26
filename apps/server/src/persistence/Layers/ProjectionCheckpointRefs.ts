import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteCheckpointRefsByThreadIdInput,
  ListCheckpointRefsInput,
  ProjectionCheckpointRef,
  ProjectionCheckpointRefsRepository,
  type ProjectionCheckpointRefsRepositoryShape,
} from "../Services/ProjectionCheckpointRefs.ts";

const makeProjectionCheckpointRefsRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const deleteForCheckpoint = SqlSchema.void({
    Request: ListCheckpointRefsInput,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        DELETE FROM projection_checkpoint_refs
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
      `,
  });

  const insertCheckpointRefRow = SqlSchema.void({
    Request: ProjectionCheckpointRef,
    execute: (row) =>
      sql`
        INSERT INTO projection_checkpoint_refs (
          thread_id,
          checkpoint_turn_count,
          repo_root,
          checkpoint_ref
        )
        VALUES (
          ${row.threadId},
          ${row.checkpointTurnCount},
          ${row.repoRoot},
          ${row.checkpointRef}
        )
        ON CONFLICT (thread_id, checkpoint_turn_count, repo_root)
        DO UPDATE SET checkpoint_ref = excluded.checkpoint_ref
      `,
  });

  const listCheckpointRefRows = SqlSchema.findAll({
    Request: ListCheckpointRefsInput,
    Result: ProjectionCheckpointRef,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          checkpoint_turn_count AS "checkpointTurnCount",
          repo_root AS "repoRoot",
          checkpoint_ref AS "checkpointRef"
        FROM projection_checkpoint_refs
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
        ORDER BY repo_root ASC
      `,
  });

  const deleteCheckpointRefRowsByThread = SqlSchema.void({
    Request: DeleteCheckpointRefsByThreadIdInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_checkpoint_refs
        WHERE thread_id = ${threadId}
      `,
  });

  const replaceForCheckpoint: ProjectionCheckpointRefsRepositoryShape["replaceForCheckpoint"] = (
    input,
  ) =>
    sql
      .withTransaction(
        deleteForCheckpoint({
          threadId: input.threadId,
          checkpointTurnCount: input.checkpointTurnCount,
        }).pipe(
          Effect.flatMap(() =>
            Effect.forEach(
              input.refs,
              (ref) =>
                insertCheckpointRefRow({
                  threadId: input.threadId,
                  checkpointTurnCount: input.checkpointTurnCount,
                  repoRoot: ref.repoRoot,
                  checkpointRef: ref.checkpointRef,
                }),
              { discard: true },
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionCheckpointRefsRepository.replaceForCheckpoint:query"),
        ),
      );

  const listByCheckpoint: ProjectionCheckpointRefsRepositoryShape["listByCheckpoint"] = (input) =>
    listCheckpointRefRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRefsRepository.listByCheckpoint:query"),
      ),
    );

  const deleteByThreadId: ProjectionCheckpointRefsRepositoryShape["deleteByThreadId"] = (input) =>
    deleteCheckpointRefRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRefsRepository.deleteByThreadId:query"),
      ),
    );

  return {
    replaceForCheckpoint,
    listByCheckpoint,
    deleteByThreadId,
  } satisfies ProjectionCheckpointRefsRepositoryShape;
});

export const ProjectionCheckpointRefsRepositoryLive = Layer.effect(
  ProjectionCheckpointRefsRepository,
  makeProjectionCheckpointRefsRepository,
);
