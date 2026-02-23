/**
 * CheckpointRepository - Repository interface for checkpoint metadata persistence.
 *
 * Stores and queries checkpoint metadata and checkpoint Git refs keyed by
 * thread + turn count. It does not read/write Git refs itself and it
 * does not coordinate provider rollback workflows.
 *
 * @module CheckpointRepository
 */
import type { ProviderCheckpoint } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointRepositoryError } from "../Errors.ts";

export interface UpsertCheckpointInput {
  readonly providerSessionId?: string;
  readonly threadId: string;
  readonly checkpointId: string;
  readonly checkpointRef: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly label: string;
  readonly preview?: string;
  readonly createdAt: string;
}

export interface CheckpointRepositoryEntry extends ProviderCheckpoint {
  readonly threadId: string;
  readonly checkpointRef: string;
  readonly createdAt: string;
}

export interface ListThreadCheckpointsInput {
  readonly threadId: string;
}

export interface GetCheckpointInput {
  readonly threadId: string;
  readonly turnCount: number;
}

export interface DeleteAfterTurnInput {
  readonly threadId: string;
  readonly maxTurnCount: number;
}

export interface DeleteAllForThreadInput {
  readonly threadId: string;
}

export interface CheckpointRepositoryShape {
  /**
   * Insert or update one checkpoint metadata row.
   */
  readonly upsertCheckpoint: (
    input: UpsertCheckpointInput,
  ) => Effect.Effect<void, CheckpointRepositoryError>;

  /**
   * List user-facing checkpoints for a thread.
   */
  readonly listCheckpoints: (
    input: ListThreadCheckpointsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderCheckpoint>, CheckpointRepositoryError>;

  /**
   * Read one checkpoint record (including checkpoint ref) by turn count.
   */
  readonly getCheckpoint: (
    input: GetCheckpointInput,
  ) => Effect.Effect<Option.Option<CheckpointRepositoryEntry>, CheckpointRepositoryError>;

  /**
   * Delete checkpoint metadata newer than the provided turn count.
   */
  readonly deleteAfterTurn: (
    input: DeleteAfterTurnInput,
  ) => Effect.Effect<void, CheckpointRepositoryError>;

  /**
   * Delete all checkpoint metadata for a thread.
   */
  readonly deleteAllForThread: (
    input: DeleteAllForThreadInput,
  ) => Effect.Effect<void, CheckpointRepositoryError>;
}

/**
 * CheckpointRepository - Service tag for checkpoint metadata persistence.
 */
export class CheckpointRepository extends ServiceMap.Service<
  CheckpointRepository,
  CheckpointRepositoryShape
>()("persistence/CheckpointRepository") {}
