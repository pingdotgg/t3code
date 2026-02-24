import { Schema } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "../git/Errors.ts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointRepositoryError - Checkpointing unavailable for cwd/repository.
 */
export class CheckpointRepositoryError extends Schema.TaggedErrorClass<CheckpointRepositoryError>()(
  "CheckpointRepositoryError",
  {
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint repository error for ${this.cwd}: ${this.detail}`;
  }
}

/**
 * CheckpointSessionNotFoundError - Session is missing in checkpoint workflow.
 */
export class CheckpointSessionNotFoundError extends Schema.TaggedErrorClass<CheckpointSessionNotFoundError>()(
  "CheckpointSessionNotFoundError",
  {
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint session not found: ${this.sessionId}`;
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointInvariantError
  | CheckpointUnavailableError
  | CheckpointRepositoryError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointSessionNotFoundError
  | CheckpointInvariantError;
