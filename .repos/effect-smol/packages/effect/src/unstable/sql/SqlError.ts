/**
 * Structured SQL failures for unstable SQL clients and driver integrations.
 *
 * This module provides the top-level `SqlError` wrapper, the concrete
 * `SqlErrorReason` variants used by adapters, schemas for encoding or decoding
 * those errors, guards for recognizing them, and a SQLite classifier for native
 * driver causes. The model keeps query mistakes, authentication and
 * authorization failures, constraint violations, connection failures, lock
 * waits, deadlocks, serialization conflicts, statement timeouts, and unknown
 * failures distinguishable in the Effect error channel.
 *
 * **Mental model**
 *
 * `SqlError` wraps exactly one reason. Its `message`, `cause`, and
 * `isRetryable` values are delegated to that reason, so recovery code can branch
 * on either the reason tag or the retryability flag without losing the original
 * native cause. Reasons are intentionally driver-neutral; adapters translate
 * database-specific error codes into this shared vocabulary.
 *
 * **Common tasks**
 *
 * Construct a reason when adapting a driver failure, wrap it in `SqlError` for
 * client APIs, use `isSqlError` or `isSqlErrorReason` at boundaries that receive
 * unknown failures, and use `classifySqliteError` when mapping SQLite `code` or
 * `errno` values.
 *
 * **Gotchas**
 *
 * Preserve the native `cause` and `operation` metadata when constructing these
 * errors; they are often the only way to diagnose dialect-specific failures.
 * Retryable reasons represent transient infrastructure or concurrency problems,
 * while syntax, credential, permission, and constraint failures generally need a
 * changed query, configuration, or data set. SQLite unique violations include a
 * best-effort constraint name when one can be extracted.
 *
 * @since 4.0.0
 */
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/sql/SqlError" as const
const ReasonTypeId = "~effect/sql/SqlError/Reason" as const

const ReasonFields = {
  cause: Schema.Defect,
  message: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.String)
}

/**
 * SQL error reason for connection or open failures; marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>("effect/sql/SqlError/ConnectionError")(
  "ConnectionError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * SQL error reason for authentication failures such as invalid credentials; not
 * marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>(
  "effect/sql/SqlError/AuthenticationError"
)("AuthenticationError", ReasonFields) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * SQL error reason for authorization or permission failures; not marked
 * retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>(
  "effect/sql/SqlError/AuthorizationError"
)("AuthorizationError", ReasonFields) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * SQL error reason for invalid SQL syntax; not marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class SqlSyntaxError extends Schema.TaggedErrorClass<SqlSyntaxError>("effect/sql/SqlError/SqlSyntaxError")(
  "SqlSyntaxError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

const UniqueViolationFields = {
  ...ReasonFields,
  constraint: Schema.String
}

/**
 * SQL error reason for a unique constraint violation, including the violated
 * constraint identifier; not marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class UniqueViolation extends Schema.TaggedErrorClass<UniqueViolation>("effect/sql/SqlError/UniqueViolation")(
  "UniqueViolation",
  UniqueViolationFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * SQL error reason for a non-unique constraint violation; not marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class ConstraintError extends Schema.TaggedErrorClass<ConstraintError>("effect/sql/SqlError/ConstraintError")(
  "ConstraintError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * SQL error reason for a database deadlock; marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class DeadlockError extends Schema.TaggedErrorClass<DeadlockError>("effect/sql/SqlError/DeadlockError")(
  "DeadlockError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * SQL error reason for a transaction serialization or isolation conflict;
 * marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class SerializationError extends Schema.TaggedErrorClass<SerializationError>(
  "effect/sql/SqlError/SerializationError"
)("SerializationError", ReasonFields) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * SQL error reason for timing out while waiting on a database lock; marked
 * retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>("effect/sql/SqlError/LockTimeoutError")(
  "LockTimeoutError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * SQL error reason for a statement or query timeout; marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class StatementTimeoutError extends Schema.TaggedErrorClass<StatementTimeoutError>(
  "effect/sql/SqlError/StatementTimeoutError"
)("StatementTimeoutError", ReasonFields) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return true
  }
}

/**
 * SQL error reason for an unclassified database failure; not marked retryable.
 *
 * @category errors
 * @since 4.0.0
 */
export class UnknownError extends Schema.TaggedErrorClass<UnknownError>("effect/sql/SqlError/UnknownError")(
  "UnknownError",
  ReasonFields
) {
  /**
   * Marks this value as a structured SQL error reason for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ReasonTypeId] = ReasonTypeId

  /**
   * Indicates whether retrying the failed SQL operation may succeed.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * Union of structured SQL error reasons, each carrying the original cause plus
 * optional message and operation metadata.
 *
 * @category errors
 * @since 4.0.0
 */
export type SqlErrorReason =
  | ConnectionError
  | AuthenticationError
  | AuthorizationError
  | SqlSyntaxError
  | UniqueViolation
  | ConstraintError
  | DeadlockError
  | SerializationError
  | LockTimeoutError
  | StatementTimeoutError
  | UnknownError

/**
 * Schema for encoding and decoding SQL error reasons.
 *
 * @category schemas
 * @since 4.0.0
 */
export const SqlErrorReason: Schema.Union<[
  typeof ConnectionError,
  typeof AuthenticationError,
  typeof AuthorizationError,
  typeof SqlSyntaxError,
  typeof UniqueViolation,
  typeof ConstraintError,
  typeof DeadlockError,
  typeof SerializationError,
  typeof LockTimeoutError,
  typeof StatementTimeoutError,
  typeof UnknownError
]> = Schema.Union([
  ConnectionError,
  AuthenticationError,
  AuthorizationError,
  SqlSyntaxError,
  UniqueViolation,
  ConstraintError,
  DeadlockError,
  SerializationError,
  LockTimeoutError,
  StatementTimeoutError,
  UnknownError
])

/**
 * Error wrapper for SQL failures whose `message`, `cause`, and `isRetryable`
 * values are derived from its `SqlErrorReason`.
 *
 * @category errors
 * @since 4.0.0
 */
export class SqlError extends Schema.TaggedErrorClass<SqlError>("effect/sql/SqlError")("SqlError", {
  reason: SqlErrorReason
}) {
  /**
   * Marks this value as the top-level SQL error wrapper for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Exposes the structured SQL reason as the JavaScript error cause.
   *
   * @since 4.0.0
   */
  override readonly cause = this.reason

  /**
   * Uses the reason message when present, otherwise falls back to the reason tag.
   *
   * @since 4.0.0
   */
  override get message(): string {
    return this.reason.message || this.reason._tag
  }

  /**
   * Delegates retryability to the underlying SQL error reason.
   *
   * @since 4.0.0
   */
  get isRetryable(): boolean {
    return this.reason.isRetryable
  }
}

/**
 * Returns `true` when a value is a `SqlError`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSqlError = (u: unknown): u is SqlError => Predicate.hasProperty(u, TypeId)

/**
 * Returns `true` when a value is a `SqlErrorReason`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSqlErrorReason = (u: unknown): u is SqlErrorReason => Predicate.hasProperty(u, ReasonTypeId)

type SqliteClassifyOptions = {
  readonly message?: string | undefined
  readonly operation?: string | undefined
}

const sqliteCodeFromCause = (cause: unknown): string | number | undefined => {
  if (!Predicate.hasProperty(cause, "code")) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" || typeof code === "number" ? code : undefined
}

const sqliteNumericCodeFromCause = (cause: unknown): number | undefined => {
  const code = sqliteCodeFromCause(cause)
  if (typeof code === "number") {
    return code
  }
  if (!Predicate.hasProperty(cause, "errno")) {
    return undefined
  }
  const errno = cause.errno
  return typeof errno === "number" ? errno : undefined
}

const matchesSqliteNumericCode = (cause: unknown, expected: number): boolean => {
  const code = sqliteCodeFromCause(cause)
  if (code === expected) {
    return true
  }
  if (!Predicate.hasProperty(cause, "errno")) {
    return false
  }
  return cause.errno === expected
}

const matchesSqliteCode = (code: string, expected: string): boolean =>
  code === expected || code.startsWith(expected + "_")

const UNKNOWN_CONSTRAINT = "unknown"
const SQLITE_CONSTRAINT_UNIQUE = "SQLITE_CONSTRAINT_UNIQUE"
const SQLITE_CONSTRAINT_UNIQUE_CODE = 2067

const normalizeConstraintIdentifier = (identifier: unknown): string => {
  if (typeof identifier !== "string") {
    return UNKNOWN_CONSTRAINT
  }
  const trimmed = identifier.trim()
  return trimmed.length === 0 ? UNKNOWN_CONSTRAINT : trimmed
}

const sqliteUniqueConstraintFromCause = (cause: unknown): string => {
  if (Predicate.hasProperty(cause, "constraint")) {
    return normalizeConstraintIdentifier(cause.constraint)
  }
  if (!Predicate.hasProperty(cause, "message")) {
    return UNKNOWN_CONSTRAINT
  }
  const message = cause.message
  if (typeof message !== "string") {
    return UNKNOWN_CONSTRAINT
  }
  const prefix = "UNIQUE constraint failed:"
  const index = message.indexOf(prefix)
  return index === -1 ? UNKNOWN_CONSTRAINT : normalizeConstraintIdentifier(message.slice(index + prefix.length))
}

/**
 * Classifies a native SQLite error cause into a `SqlErrorReason` using its
 * `code` or `errno`, with optional message and operation metadata.
 *
 * @category converting
 * @since 4.0.0
 */
export const classifySqliteError = (
  cause: unknown,
  { message, operation }: SqliteClassifyOptions = {}
): SqlErrorReason => {
  const props = {
    cause,
    message,
    operation
  }
  const code = sqliteCodeFromCause(cause)
  const numericCode = sqliteNumericCodeFromCause(cause)

  if (code === SQLITE_CONSTRAINT_UNIQUE || matchesSqliteNumericCode(cause, SQLITE_CONSTRAINT_UNIQUE_CODE)) {
    return new UniqueViolation({ ...props, constraint: sqliteUniqueConstraintFromCause(cause) })
  }

  if (typeof code === "string") {
    if (matchesSqliteCode(code, "SQLITE_AUTH")) {
      return new AuthenticationError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_PERM")) {
      return new AuthorizationError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_CONSTRAINT")) {
      return new ConstraintError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_BUSY") || matchesSqliteCode(code, "SQLITE_LOCKED")) {
      return new LockTimeoutError(props)
    }
    if (matchesSqliteCode(code, "SQLITE_CANTOPEN")) {
      return new ConnectionError(props)
    }
  }

  if (typeof numericCode === "number") {
    const code = numericCode & 0xff
    switch (code) {
      case 23:
        return new AuthenticationError(props)
      case 3:
        return new AuthorizationError(props)
      case 19:
        return new ConstraintError(props)
      case 5:
      case 6:
        return new LockTimeoutError(props)
      case 14:
        return new ConnectionError(props)
      default:
        return new UnknownError(props)
    }
  }

  return new UnknownError(props)
}

/**
 * Error raised when an ordered batched SQL resolver receives a different number
 * of result rows than requests.
 *
 * @category errors
 * @since 4.0.0
 */
export class ResultLengthMismatch
  extends Schema.TaggedErrorClass<ResultLengthMismatch>("effect/sql/ResultLengthMismatch")("ResultLengthMismatch", {
    expected: Schema.Number,
    actual: Schema.Number
  })
{
  /**
   * Explains the mismatch between expected and actual batched SQL result counts.
   *
   * @since 4.0.0
   */
  override get message() {
    return `Expected ${this.expected} results but got ${this.actual}`
  }
}
