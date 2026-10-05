// Runtime error taxonomy for the Prisma ORM v8 Effect client. Worker-safe:
// imports nothing beyond effect, and detects Prisma's error shapes
// structurally (via their stable `kind` / `code` / `sqlState` discriminants)
// so this module never has to value-import the optional peer.
//
// Granularity policy: a dedicated tag wherever the discriminant is STABLE
// and handling genuinely branches — the SQL-standard integrity-violation
// SQLSTATEs (23xxx) and Prisma's error categories (`ORM.*`,
// `RUNTIME.*`, ...). Individual codes stay a typed `code` field rather than
// one class per code: the code set churns per RC, while categories and
// SQLSTATEs do not.
import * as Data from "effect/Data";

/**
 * Prisma structured error codes observed in 8.0.0-rc.8 — an OPEN union
 * (`string` stays assignable) so new RC codes never break, while known ones
 * autocomplete.
 */
export type ErrorCode =
  | "ORM.TABLE_UNKNOWN"
  | "ORM.COLUMN_UNKNOWN"
  | "ORM.RELATION_UNKNOWN"
  | "ORM.INCLUDE_INVALID"
  | "ORM.AGGREGATE_UNSUPPORTED"
  | "ORM.MUTATION_ROW_MISSING"
  | "ORM.CAPABILITY_MISSING"
  | "RUNTIME.ENCODE_FAILED"
  | "RUNTIME.DECODE_FAILED"
  | "RUNTIME.ABORTED"
  | "RUNTIME.CODEC_MISSING"
  | "RUNTIME.PREPARE_UNUSED_PARAM"
  | "RUNTIME.PREPARE_BIND_ON_ADHOC"
  | "RUNTIME.TRANSACTION_CLOSED"
  | "RUNTIME.TRANSACTION_COMMIT_FAILED"
  | "RUNTIME.TRANSACTION_ROLLBACK_FAILED"
  | "RUNTIME.BINDING_INVALID"
  | "RUNTIME.BINDING_MISSING"
  | "BUDGET.ROWS_EXCEEDED"
  | "DRIVER.NOT_CONNECTED"
  | "DRIVER.ALREADY_CONNECTED"
  | "DRIVER.PREPARE_FAILED"
  | "CONTRACT.MARKER_MISSING"
  | "CONTRACT.MARKER_MISMATCH"
  | "CONTRACT.VERIFY_FAILED"
  | (string & {});

interface QueryErrorFields {
  message: string;
  sqlState?: string | undefined;
  constraint?: string | undefined;
  table?: string | undefined;
  column?: string | undefined;
  detail?: string | undefined;
  cause: unknown;
}

// ── integrity violations (SQL-standard SQLSTATE class 23) ─────────────
// The driver normalizes target codes onto SQLSTATE, so these tags are
// stable across databases and RCs.

/**
 * Unique or primary-key conflict (SQLSTATE `23505`) — the "email already
 * registered" case:
 *
 * ```typescript
 * Effect.catchTag("Prisma.UniqueViolationError", () =>
 *   Effect.succeed("already registered"),
 * )
 * ```
 */
export class UniqueViolationError extends Data.TaggedError(
  "Prisma.UniqueViolationError",
)<QueryErrorFields> {}

/** Foreign-key violation (SQLSTATE `23503`) — a referenced row is missing. */
export class ForeignKeyViolationError extends Data.TaggedError(
  "Prisma.ForeignKeyViolationError",
)<QueryErrorFields> {}

/** NOT NULL violation (SQLSTATE `23502`). */
export class NotNullViolationError extends Data.TaggedError(
  "Prisma.NotNullViolationError",
)<QueryErrorFields> {}

/** CHECK constraint violation (SQLSTATE `23514`). */
export class CheckViolationError extends Data.TaggedError(
  "Prisma.CheckViolationError",
)<QueryErrorFields> {}

/** Every integrity-constraint tag (SQLSTATE class 23). */
export type ConstraintViolationError =
  | UniqueViolationError
  | ForeignKeyViolationError
  | NotNullViolationError
  | CheckViolationError;

// ── other SQL / connection failures ───────────────────────────────────

/**
 * Any other SQL statement failure (syntax, permissions, serialization,
 * ...). `sqlState` carries the driver-normalized SQLSTATE for finer
 * refinement.
 */
export class QueryError extends Data.TaggedError(
  "Prisma.QueryError",
)<QueryErrorFields> {}

/**
 * A connection-level failure (refused, reset, timed out). `transient`
 * carries the driver's own judgment of retryability:
 *
 * ```typescript
 * Effect.retry(effect, {
 *   while: (e) => e._tag === "Prisma.ConnectionError" && e.transient === true,
 *   times: 3,
 * })
 * ```
 */
export class ConnectionError extends Data.TaggedError(
  "Prisma.ConnectionError",
)<{
  message: string;
  transient?: boolean | undefined;
  cause: unknown;
}> {}

// ── Prisma pipeline categories ────────────────────────────────────────

/**
 * ORM-lane misuse or validation failure (`ORM.*` codes: unknown
 * table/column/relation, invalid include, unsupported aggregate, ...).
 * Almost always a programming bug — don't retry.
 */
export class OrmError extends Data.TaggedError("Prisma.OrmError")<{
  code: ErrorCode;
  message: string;
  cause: unknown;
}> {}

/**
 * Execution-pipeline failure (`RUNTIME.*`, `DRIVER.*`, `BUDGET.*`,
 * `CONTRACT.*`, `PLAN.*`, `LINT.*`, `MIGRATION.*` codes: encode/decode,
 * codec registry, transaction lifecycle, row budgets, marker
 * verification, ...). `code` pins the exact failure.
 */
export class RuntimeError extends Data.TaggedError("Prisma.RuntimeError")<{
  code: ErrorCode;
  message: string;
  cause: unknown;
}> {}

/** A failure Prisma did not classify at all (no kind, no code). */
export class UnknownError extends Data.TaggedError("Prisma.UnknownError")<{
  code?: ErrorCode | undefined;
  message: string;
  cause: unknown;
}> {}

/**
 * Deliberate transaction rollback. Yield `tx.rollback()` inside
 * `db.transaction` to abort: the transaction rolls back and this error
 * surfaces in the caller's error channel, catchable with
 * `Effect.catchTag("Prisma.RollbackError", ...)`.
 */
export class RollbackError extends Data.TaggedError(
  "Prisma.RollbackError",
)<{}> {}

/** Everything a Prisma query can fail with. */
export type ClientError =
  | ConstraintViolationError
  | QueryError
  | ConnectionError
  | OrmError
  | RuntimeError
  | UnknownError;

const field = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The single funnel converting Prisma's thrown errors into the typed
 * taxonomy. Detection uses stable discriminants: `kind: 'sql_query' |
 * 'sql_connection'` on driver errors (with SQLSTATE refining the class-23
 * integrity violations onto their own tags), and the `CATEGORY.NAME`
 * structured `code` on ORM/pipeline errors.
 */
export const wrapPrismaError = (cause: unknown): ClientError => {
  const kind = field(cause, "kind");
  if (kind === "sql_query") {
    const fields: QueryErrorFields = {
      message: message(cause),
      sqlState: field(cause, "sqlState"),
      constraint: field(cause, "constraint"),
      table: field(cause, "table"),
      column: field(cause, "column"),
      detail: field(cause, "detail"),
      cause,
    };
    switch (fields.sqlState) {
      case "23505":
        return new UniqueViolationError(fields);
      case "23503":
        return new ForeignKeyViolationError(fields);
      case "23502":
        return new NotNullViolationError(fields);
      case "23514":
        return new CheckViolationError(fields);
      default:
        return new QueryError(fields);
    }
  }
  if (kind === "sql_connection") {
    const transient = (cause as { transient?: unknown }).transient;
    return new ConnectionError({
      message: message(cause),
      transient: typeof transient === "boolean" ? transient : undefined,
      cause,
    });
  }
  const code = field(cause, "code");
  if (code !== undefined) {
    return code.startsWith("ORM.")
      ? new OrmError({ code, message: message(cause), cause })
      : new RuntimeError({ code, message: message(cause), cause });
  }
  return new UnknownError({
    code: undefined,
    message: message(cause),
    cause,
  });
};
