import { Schema, SchemaIssue } from "effect";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
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
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      detail: describeCause(cause) ?? `Failed to execute ${operation}`,
      cause,
    });
}

function describeCause(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined;
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    const innerMessage = inner instanceof Error ? inner.message : undefined;
    return innerMessage && innerMessage !== cause.message
      ? `${cause.message} (cause: ${innerMessage})`
      : cause.message;
  }
  if (typeof cause === "object") {
    const candidate = cause as { message?: unknown; _tag?: unknown; detail?: unknown };
    const parts = [candidate._tag, candidate.detail ?? candidate.message].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (parts.length > 0) return parts.join(": ");
    try {
      return JSON.stringify(cause);
    } catch {
      return undefined;
    }
  }
  return undefined;
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
      issue: describeCause(cause) ?? `Failed to execute ${operation}`,
      cause,
    });
}

const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

export const isPersistenceError = (u: unknown) =>
  isPersistenceSqlError(u) || isPersistenceDecodeError(u);

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Unknown),
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
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
