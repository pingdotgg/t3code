import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SQLite } from "./SQLite.ts";
import type { SQLiteConnection } from "./SQLiteConnection.ts";
import { parseError } from "./SQLiteError.ts";
import type { SQLiteStatement } from "./SQLiteStatement.ts";

/**
 * Layer that provides the SQLite service using Bun's native SQLite.
 */
export const BunSQLite: Layer.Layer<SQLite> = Layer.sync(SQLite, () => ({
  open: (path: string) =>
    Effect.gen(function* () {
      const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
      const db = new Database(path);
      // Enable WAL mode for better concurrent read performance
      db.run("PRAGMA journal_mode = WAL;");
      // Wait up to 30 seconds when database is locked before returning SQLITE_BUSY
      db.run("PRAGMA busy_timeout = 30000;");
      return fromDatabase(db);
    }),
}));

/**
 * Create a SQLiteConnection from a Bun SQLite Database.
 */
export const fromDatabase = (db: Database): SQLiteConnection => ({
  prepare: <R>(sql: string) =>
    Effect.try({
      try: () => wrapStatement<R>(db.prepare(sql)),
      catch: (e) =>
        parseError(extractErrorCode(e), `Failed to prepare statement: ${e}`, e),
    }),

  exec: (sql: string) =>
    Effect.try({
      try: () => {
        db.exec(sql);
      },
      catch: (e) =>
        parseError(extractErrorCode(e), `Failed to execute SQL: ${e}`, e),
    }),

  transaction: <A, E>(
    fn: (conn: SQLiteConnection) => Effect.Effect<A, E, never>,
  ) => {
    // For Bun's synchronous SQLite, we can use the same connection
    // since everything runs synchronously within the transaction
    const conn = fromDatabase(db);
    return Effect.flatMap(
      Effect.try({
        try: () => db.transaction(() => Effect.runSync(fn(conn))),
        catch: (e) =>
          parseError(
            extractErrorCode(e),
            `Failed to create transaction: ${e}`,
            e,
          ),
      }),
      (txFn) =>
        Effect.try({
          try: () => txFn(),
          catch: (e) =>
            parseError(extractErrorCode(e), `Transaction failed:`, e),
        }),
    );
  },

  batch: (statements: Array<{ sql: string; params?: unknown[] }>) =>
    Effect.try({
      try: () => {
        // Use Bun's transaction for atomic batch execution
        db.transaction(() => {
          for (const stmt of statements) {
            const prepared = db.prepare(stmt.sql);
            prepared.run(...((stmt.params ?? []) as SQLQueryBindings[]));
          }
        })();
      },
      catch: (e) =>
        parseError(extractErrorCode(e), `Batch execution failed: ${e}`, e),
    }),
});

/**
 * Wrap a Bun SQLite Statement in the SqlStatement interface.
 */
const wrapStatement = <R>(stmt: Statement): SQLiteStatement<R> => ({
  all: <T = R>(...params: unknown[]) =>
    Effect.try({
      try: () => stmt.all(...params) as T[],
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to execute statement.all: ${e}`,
          e,
        ),
    }),

  get: <T = R>(...params: unknown[]) =>
    Effect.try({
      try: () => stmt.get(...params) as T | undefined,
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to execute statement.get: ${e}`,
          e,
        ),
    }),

  run: (...params: unknown[]) =>
    Effect.try({
      try: () => {
        stmt.run(...params);
      },
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to execute statement.run: ${e}`,
          e,
        ),
    }),
});

/**
 * Extract error code from Bun's SQLiteError.
 */
const extractErrorCode = (e: unknown): string | undefined => {
  const bunError = e as { code?: string };
  return bunError?.code;
};
