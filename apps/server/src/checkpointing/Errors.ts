import { Schema } from "effect";

/**
 * CheckpointValidationError - Invalid checkpoint API input.
 */
export class CheckpointValidationError extends Schema.TaggedErrorClass<CheckpointValidationError>()(
  "CheckpointValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * CheckpointGitCommandError - Git command execution failed in checkpoint store.
 */
export class CheckpointGitCommandError extends Schema.TaggedErrorClass<CheckpointGitCommandError>()(
  "CheckpointGitCommandError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

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
 * CheckpointCatalogPersistenceError - Metadata persistence/read failure.
 */
export class CheckpointCatalogPersistenceError extends Schema.TaggedErrorClass<CheckpointCatalogPersistenceError>()(
  "CheckpointCatalogPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint catalog persistence error in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointServiceValidationError - Invalid application-level checkpoint request.
 */
export class CheckpointServiceValidationError extends Schema.TaggedErrorClass<CheckpointServiceValidationError>()(
  "CheckpointServiceValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint service validation failed in ${this.operation}: ${this.issue}`;
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
  | CheckpointValidationError
  | CheckpointGitCommandError
  | CheckpointUnavailableError
  | CheckpointRepositoryError;

export type CheckpointCatalogError =
  | CheckpointValidationError
  | CheckpointCatalogPersistenceError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | CheckpointCatalogError
  | CheckpointServiceValidationError
  | CheckpointSessionNotFoundError
  | CheckpointInvariantError;
