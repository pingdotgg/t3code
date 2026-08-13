import { CheckpointRef, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionCheckpointRef = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  repoRoot: Schema.String,
  checkpointRef: CheckpointRef,
});
export type ProjectionCheckpointRef = typeof ProjectionCheckpointRef.Type;

export const ReplaceCheckpointRefsInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  refs: Schema.Array(
    Schema.Struct({
      repoRoot: Schema.String,
      checkpointRef: CheckpointRef,
    }),
  ),
});
export type ReplaceCheckpointRefsInput = typeof ReplaceCheckpointRefsInput.Type;

export const ListCheckpointRefsInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export type ListCheckpointRefsInput = typeof ListCheckpointRefsInput.Type;

export const DeleteCheckpointRefsByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteCheckpointRefsByThreadIdInput = typeof DeleteCheckpointRefsByThreadIdInput.Type;

export class ProjectionCheckpointRefsRepository extends Context.Service<
  ProjectionCheckpointRefsRepository,
  {
    readonly replaceForCheckpoint: (
      input: ReplaceCheckpointRefsInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listByCheckpoint: (
      input: ListCheckpointRefsInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionCheckpointRef>, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: DeleteCheckpointRefsByThreadIdInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionCheckpointRefs/ProjectionCheckpointRefsRepository") {}

export const make = Effect.gen(function* () {
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

  const replaceForCheckpoint: ProjectionCheckpointRefsRepository["Service"]["replaceForCheckpoint"] =
    (input) =>
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

  const listByCheckpoint: ProjectionCheckpointRefsRepository["Service"]["listByCheckpoint"] = (
    input,
  ) =>
    listCheckpointRefRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRefsRepository.listByCheckpoint:query"),
      ),
    );

  const deleteByThreadId: ProjectionCheckpointRefsRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteCheckpointRefRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRefsRepository.deleteByThreadId:query"),
      ),
    );

  return ProjectionCheckpointRefsRepository.of({
    replaceForCheckpoint,
    listByCheckpoint,
    deleteByThreadId,
  });
});

export const layer = Layer.effect(ProjectionCheckpointRefsRepository, make);
