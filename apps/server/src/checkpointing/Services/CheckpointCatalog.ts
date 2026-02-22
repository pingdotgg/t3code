/**
 * CheckpointCatalog - Metadata repository for checkpoints.
 *
 * Stores user-facing checkpoint metadata used by list/revert APIs. It does not
 * touch the filesystem or hidden Git refs; `CheckpointStore` owns that state.
 * It also does not drive provider conversation rollback.
 *
 * @module CheckpointCatalog
 */
import type { ProviderCheckpoint } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointCatalogError } from "../Errors.ts";

export interface UpsertCheckpointInput {
  readonly providerSessionId: string;
  readonly threadId: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly label: string;
  readonly preview?: string;
  readonly createdAt: string;
}

export interface ListSessionCheckpointsInput {
  readonly providerSessionId: string;
}

export interface GetCheckpointInput {
  readonly providerSessionId: string;
  readonly turnCount: number;
}

export interface DeleteAfterTurnInput {
  readonly providerSessionId: string;
  readonly maxTurnCount: number;
}

export interface DeleteAllForSessionInput {
  readonly providerSessionId: string;
}

export interface CheckpointCatalogShape {
  /**
   * Insert or update one checkpoint metadata row.
   */
  readonly upsertCheckpoint: (input: UpsertCheckpointInput) => Effect.Effect<void, CheckpointCatalogError>;

  /**
   * List checkpoints for a provider session.
   */
  readonly listCheckpoints: (
    input: ListSessionCheckpointsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderCheckpoint>, CheckpointCatalogError>;

  /**
   * Read one checkpoint by turn count.
   */
  readonly getCheckpoint: (
    input: GetCheckpointInput,
  ) => Effect.Effect<Option.Option<ProviderCheckpoint>, CheckpointCatalogError>;

  /**
   * Delete checkpoint metadata newer than the provided turn count.
   */
  readonly deleteAfterTurn: (input: DeleteAfterTurnInput) => Effect.Effect<void, CheckpointCatalogError>;

  /**
   * Delete all checkpoint metadata for a provider session.
   */
  readonly deleteAllForSession: (
    input: DeleteAllForSessionInput,
  ) => Effect.Effect<void, CheckpointCatalogError>;
}

/**
 * CheckpointCatalog - Service tag for checkpoint metadata persistence.
 */
export class CheckpointCatalog extends ServiceMap.Service<
  CheckpointCatalog,
  CheckpointCatalogShape
>()("checkpointing/CheckpointCatalog") {}
