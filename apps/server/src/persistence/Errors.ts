import { Schema, SchemaIssue } from "effect";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export class PersistenceSerializationError extends Schema.TaggedErrorClass<PersistenceSerializationError>()(
  "PersistenceSerializationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Serialization error in ${this.operation}: ${this.detail}`;
  }
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      detail: `Failed to execute ${operation}`,
      cause,
    });
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

export function toPersistenceSerializationError(operation: string) {
  return (cause: unknown): PersistenceSerializationError =>
    new PersistenceSerializationError({
      operation,
      detail: `Failed to execute ${operation}`,
      cause,
    });
}

// ===============================
// Project Repository Errors
// ===============================

export class ProjectValidationError extends Schema.TaggedErrorClass<ProjectValidationError>()(
  "ProjectValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Project validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProjectPathMissingError extends Schema.TaggedErrorClass<ProjectPathMissingError>()(
  "ProjectPathMissingError",
  {
    cwd: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Project path does not exist: ${this.cwd}`;
  }
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Project not found: ${this.projectId}`;
  }
}

// ===============================
// Checkpoint Repository Errors
// ===============================

export class CheckpointRepositoryValidationError extends Schema.TaggedErrorClass<CheckpointRepositoryValidationError>()(
  "CheckpointRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class CheckpointRepositoryPersistenceError extends Schema.TaggedErrorClass<CheckpointRepositoryPersistenceError>()(
  "CheckpointRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProjectRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PersistenceSerializationError
  | ProjectValidationError
  | ProjectPathMissingError
  | ProjectNotFoundError;

export type OrchestrationEventStoreError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PersistenceSerializationError;

export type CheckpointRepositoryError =
  | CheckpointRepositoryValidationError
  | CheckpointRepositoryPersistenceError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;
