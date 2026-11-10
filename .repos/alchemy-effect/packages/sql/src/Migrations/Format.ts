import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * `googlesql` is Cloud Spanner's GoogleSQL dialect. Spanner's PostgreSQL
 * dialect is `postgres` with `migrationTableId: "spanner"` and
 * `defaultSchema: "public"`.
 */
export type MigrationDialect = "postgres" | "mysql" | "sqlite" | "googlesql";

/**
 * A single migration read from disk, normalized across directory layouts.
 */
export interface MigrationRecord {
  /**
   * The bookkeeping key used for applied-detection. Layout-dependent: the
   * directory name for drizzle-kit/Prisma-layout dirs
   * (`20260721033159_init`), the relative file path for flat dirs
   * (`0001_users.sql`).
   */
  name: string;
  /** sha256 hex of the raw file content. */
  hash: string;
  /**
   * Millis derived from a 14-digit `YYYYMMDDHHMMSS` prefix when present.
   */
  createdAtMillis: number | undefined;
  /** Raw file content. */
  sql: string;
  /** Individual statements (split on `--> statement-breakpoint`). */
  statements: string[];
}

/**
 * The minimal query surface the migration flow needs from its target
 * database. Each database resource adapts its native access path (the D1
 * HTTP API, a `pg.Client` over a Planetscale temp role, a `mysql2`
 * connection, the local workerd D1 tunnel) into this shape once.
 */
export interface SqlExecutor {
  readonly dialect: MigrationDialect;
  /**
   * PostgreSQL targets without SERIAL key bookkeeping rows by UUID:
   * `uuid` generates a native uuid, `spanner` a varchar from
   * `spanner.generate_uuid()` (Spanner has neither SERIAL nor a uuid type).
   */
  readonly migrationTableId?: "uuid" | "spanner";
  /**
   * Schema to introspect when the target has no `current_schema()`
   * (Spanner's PostgreSQL dialect).
   */
  readonly defaultSchema?: string;
  /** False when DDL cannot commit atomically with history conversion. */
  readonly transactionalDdl?: boolean;
  /** Override atomic batches for targets requiring durable statement progress. */
  readonly applyMigration?: (
    record: MigrationRecord,
    bookkeeping: string,
  ) => Effect.Effect<void, MigrationError>;
  /**
   * Run a single query and return its rows as objects. `params` bind as
   * `?`/`$n` placeholders; adapters without native parameter support inline
   * them as SQL literals (see `inlineSqlParams`).
   */
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<Array<Record<string, unknown>>, MigrationError>;
  /**
   * Execute one or more statements as a unit — a transaction where the
   * target supports one (pg/mysql), a single batched query on D1 (which has
   * no transactions over HTTP).
   */
  readonly batch: (statements: ReadonlyArray<string>) => Effect.Effect<void, MigrationError>;
}

/** A migration failed to read, convert, or apply. */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  message: string;
  cause?: unknown;
  /**
   * The request may never have reached the database (a 5xx, a timeout, a
   * reset socket). A failed batch marked transient is resent if the
   * applied-migrations table shows it did not land.
   */
  transient?: boolean;
}> {}

/**
 * The migrations directory uses drizzle-kit's pre-v1 layout
 * (`meta/_journal.json`). The fix is upstream: `drizzle-kit up`.
 */
export class DrizzleV0LayoutError extends Data.TaggedError("DrizzleV0LayoutError")<{
  dir: string;
  message: string;
}> {}

/**
 * A row recorded in an applied-migrations table (ours, or a foreign one
 * being converted) matches no local migration file. Guessing would corrupt
 * history, so this is a hard error — migrations were applied to the
 * database that the local environment does not have.
 */
export class MigrationHistoryConflictError extends Data.TaggedError(
  "MigrationHistoryConflictError",
)<{
  table: string;
  unmatched: ReadonlyArray<string>;
  message: string;
}> {}

/**
 * Already-applied migration files were edited or removed. History is
 * forward-only: add a new migration instead of rewriting files that have
 * already run. PlanetScale development branches replace rather than
 * raising this; production branches (and in-place apply on any target)
 * fail with it.
 */
export class RewrittenMigrationHistoryError extends Data.TaggedError(
  "RewrittenMigrationHistoryError",
)<{
  changed: ReadonlyArray<string>;
  removed: ReadonlyArray<string>;
  message: string;
}> {}

/** Human-readable `changed X; removed Y` fragment for rewritten-history errors. */
export const describeRewrittenHistory = (options: {
  changed: ReadonlyArray<string>;
  removed: ReadonlyArray<string>;
}): string =>
  [
    options.changed.length > 0 ? `changed ${options.changed.join(", ")}` : undefined,
    options.removed.length > 0 ? `removed ${options.removed.join(", ")}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");

export type MigrationApplyError =
  | MigrationError
  | MigrationHistoryConflictError
  | RewrittenMigrationHistoryError;
