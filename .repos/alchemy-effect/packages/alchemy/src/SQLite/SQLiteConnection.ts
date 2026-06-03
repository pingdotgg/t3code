import type * as Effect from "effect/Effect";
import type { SQLiteErrorType } from "./SQLiteError.ts";
import type { SQLiteStatement } from "./SQLiteStatement.ts";

/**
 * SQL database connection interface abstraction.
 *
 * This interface decouples from specific SQLite implementations (Bun, better-sqlite3, etc.)
 * and uses Effects for all operations to support async interfaces in the future.
 */
export interface SQLiteConnection {
  /**
   * Prepare a SQL statement for execution.
   */
  prepare<R = unknown>(
    sql: string,
  ): Effect.Effect<SQLiteStatement<R>, SQLiteErrorType>;

  /**
   * Execute raw SQL statements (e.g., for DDL operations).
   */
  exec(sql: string): Effect.Effect<void, SQLiteErrorType>;

  /**
   * Execute a function within a transaction.
   * If the effect fails, the transaction is rolled back.
   * If the effect succeeds, the transaction is committed.
   *
   * The callback receives a connection that should be used for all operations
   * within the transaction to avoid deadlocks with async implementations.
   *
   * Note: For synchronous implementations (like Bun SQLite), the effect
   * must have no requirements (R = never). Async implementations may
   * support effects with requirements.
   */
  transaction<A, E>(
    fn: (conn: SQLiteConnection) => Effect.Effect<A, E, never>,
  ): Effect.Effect<A, E | SQLiteErrorType, never>;

  /**
   * Execute a batch of SQL statements atomically.
   *
   * The batch is executed in its own logical database connection and the statements
   * are wrapped in a transaction. This ensures that the batch is applied atomically:
   * either all or no changes are applied.
   *
   * If any of the statements in the batch fails with an error, the batch is aborted,
   * the transaction is rolled back and the effect fails.
   *
   * @param statements - Array of SQL statements with their parameters
   */
  batch(
    statements: Array<{ sql: string; params?: unknown[] }>,
  ): Effect.Effect<void, SQLiteErrorType>;
}
