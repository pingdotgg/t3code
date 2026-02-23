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
  readonly checkpointRef: string;
}

export interface EnsureRootCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: string;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: string;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: string;
  readonly toCheckpointRef: string;
  readonly fallbackFromToHead?: boolean;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<string>;
}

export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Ensure a root checkpoint ref exists.
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
   * Compute patch diff between two checkpoint refs.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "checkpointing/CheckpointStore",
) {}
