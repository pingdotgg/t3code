/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnCount: number;
}

export interface EnsureRootCheckpointInput {
  readonly cwd: string;
  readonly threadId: string;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnCount: number;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
}

export interface PruneAfterTurnInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly maxTurnCount: number;
}

export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint for a thread at a turn count.
   */
  readonly captureCheckpoint: (input: CaptureCheckpointInput) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpoint: (input: RestoreCheckpointInput) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Ensure a turn-0 checkpoint exists for a thread.
   */
  readonly ensureRootCheckpoint: (
    input: EnsureRootCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint turn counts.
   */
  readonly diffCheckpoints: (input: DiffCheckpointsInput) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Delete checkpoints newer than the provided turn count.
   */
  readonly pruneAfterTurn: (input: PruneAfterTurnInput) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<
  CheckpointStore,
  CheckpointStoreShape
>()("checkpointing/CheckpointStore") {}
