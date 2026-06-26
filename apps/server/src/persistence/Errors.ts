import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

function formatSchemaIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
    .join(".");
}

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`;
    case "Pointer": {
      const inner = summarizeSchemaIssue(issue.issue);
      const path = formatSchemaIssuePath(issue.path);
      return path.length > 0 ? `${path}:${inner}` : inner;
    }
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(",")})`;
    default:
      return issue._tag;
  }
}

// ===============================
// Core Persistence Errors
// ===============================

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
  Schema.Struct({ pairingLinkId: Schema.String }),
  Schema.Struct({ threadId: Schema.String }),
]);
export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type;

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      detail: `Failed to execute ${operation}`,
      cause,
    });
}

export function toPersistenceDecodeError(operation: string) {
  return (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause);
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

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
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
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
