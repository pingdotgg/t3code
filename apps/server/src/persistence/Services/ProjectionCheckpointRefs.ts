/**
 * ProjectionCheckpointRefsRepository - Projection repository for per-root
 * checkpoint refs (multi-repo, D2).
 *
 * Each checkpoint (identified by `(threadId, checkpointTurnCount)`) captures one
 * git ref per repo root it spans. This child table records those rows so a
 * checkpoint is self-describing about which roots it captured — diff and restore
 * fan out over exactly these rows rather than re-deriving roots from the project.
 *
 * @module ProjectionCheckpointRefsRepository
 */
import { CheckpointRef, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

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

/**
 * ProjectionCheckpointRefsRepositoryShape - Service API for per-root checkpoint refs.
 */
export interface ProjectionCheckpointRefsRepositoryShape {
  /**
   * Replace the full set of per-root refs for a checkpoint.
   *
   * Deletes any existing rows for `(threadId, checkpointTurnCount)` and inserts
   * the supplied rows, transactionally. An empty `refs` array clears the set.
   */
  readonly replaceForCheckpoint: (
    input: ReplaceCheckpointRefsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List the per-root refs for a checkpoint, ordered by repo root.
   */
  readonly listByCheckpoint: (
    input: ListCheckpointRefsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpointRef>, ProjectionRepositoryError>;

  /**
   * Delete all checkpoint refs for a thread (thread teardown / full revert).
   */
  readonly deleteByThreadId: (
    input: DeleteCheckpointRefsByThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionCheckpointRefsRepository - Service tag for per-root checkpoint ref persistence.
 */
export class ProjectionCheckpointRefsRepository extends Context.Service<
  ProjectionCheckpointRefsRepository,
  ProjectionCheckpointRefsRepositoryShape
>()("t3/persistence/Services/ProjectionCheckpointRefs/ProjectionCheckpointRefsRepository") {}
