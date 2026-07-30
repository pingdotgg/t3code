import type { Client, InArgs, ResultSet, Row } from "@libsql/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SQLite } from "./SQLite.ts";
import type { SQLiteConnection } from "./SQLiteConnection.ts";
import { parseError } from "./SQLiteError.ts";
import type { SQLiteStatement } from "./SQLiteStatement.ts";

/**
 * Layer that provides the SQLite service using libsql.
 *
 * Note: This layer requires the @libsql/client package to be installed.
 * Install with: bun add @libsql/client
 */
export const libSQL: Layer.Layer<SQLite> = Layer.sync(SQLite, () => ({
  open: (path: string) =>
    Effect.tryPromise({
      try: async () => {
        const { createClient } = await import("@libsql/client");
        const url = path.startsWith("file:") ? path : `file:${path}`;
        const client = createClient({ url });
        // Enable WAL mode for better concurrent read performance
        await client.execute("PRAGMA journal_mode = WAL;");
        // Wait up to 30 seconds when database is locked before returning SQLITE_BUSY
        await client.execute("PRAGMA busy_timeout = 30000;");
        return fromClient(client);
      },
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to open libsql database: ${e}`,
          e,
        ),
    }),
}));

/**
 * Create a SQLiteConnection from a libsql Client.
 *
 * @param executor - The executor to use for operations. In a transaction context,
 *                   this should be the transaction object to avoid deadlocks.
 */
export const fromClient = (
  client: Client,
  executor: { execute: Client["execute"] } = client,
): SQLiteConnection => ({
  prepare: <R>(sql: string) => Effect.succeed(wrapStatement<R>(executor, sql)),

  exec: (sql: string) =>
    Effect.tryPromise({
      try: () => executor.execute(sql),
      catch: (e) =>
        parseError(extractErrorCode(e), `Failed to execute SQL: ${e}`, e),
    }),

  transaction: <A, E>(
    fn: (conn: SQLiteConnection) => Effect.Effect<A, E, never>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const tx = await client.transaction("write");
        try {
          // Create a connection that uses the transaction for all operations
          const txConn = fromClient(client, tx);
          const result = await Effect.runPromise(fn(txConn));
          await tx.commit();
          return result;
        } catch (e) {
          await tx.rollback();
          throw e;
        }
      },
      catch: (e) =>
        parseError(extractErrorCode(e), `Transaction failed: ${e}`, e),
    }) as Effect.Effect<
      A,
      E | import("./SQLiteError.ts").SQLiteErrorType,
      never
    >,

  batch: (statements: Array<{ sql: string; params?: unknown[] }>) =>
    Effect.tryPromise({
      try: async () => {
        // Use client.batch directly - it creates its own atomic transaction
        await client.batch(
          statements.map((stmt) => ({
            sql: stmt.sql,
            args: (stmt.params ?? []) as InArgs,
          })),
          "write",
        );
      },
      catch: (e) =>
        parseError(extractErrorCode(e), `Batch execution failed: ${e}`, e),
    }),
});

/**
 * Wrap a libsql statement in the SQLiteStatement interface.
 *
 * Unlike bun:sqlite, libsql doesn't have a prepared statement object.
 * Instead, we store the SQL and execute it with parameters each time.
 *
 * @param executor - The executor to use (Client or Transaction)
 * @param sql - The SQL query string
 */
const wrapStatement = <R>(
  executor: { execute: Client["execute"] },
  sql: string,
): SQLiteStatement<R> => ({
  all: <T = R>(...params: unknown[]) =>
    Effect.tryPromise({
      try: async () => {
        const result = await executor.execute({
          sql,
          args: params as InArgs,
        });
        return resultSetToRows<T>(result);
      },
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to execute statement.all: ${e}`,
          e,
        ),
    }),

  get: <T = R>(...params: unknown[]) =>
    Effect.tryPromise({
      try: async () => {
        const result = await executor.execute({
          sql,
          args: params as InArgs,
        });
        const rows = resultSetToRows<T>(result);
        return rows[0];
      },
      catch: (e) =>
        parseError(
          extractErrorCode(e),
          `Failed to execute statement.get: ${e}`,
          e,
        ),
    }),

  run: (...params: unknown[]) =>
    Effect.tryPromise({
      try: async () => {
        await executor.execute({
          sql,
          args: params as InArgs,
        });
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
 * Extract error code from libsql's LibsqlError.
 * Prefers extendedCode if available for more specific error types.
 */
const extractErrorCode = (e: any): string | undefined => {
  const libsqlError = e as { code?: string; extendedCode?: string };
  const code = libsqlError?.extendedCode ?? libsqlError?.code;
  if (code) {
    return code;
  }
  // Match and parse the tag after "LibsqlError:"
  const match = e.message.match(/LibsqlError:\s*([A-Z_]+):/);
  const tag = match ? match[1] : undefined;
  if (tag) {
    return tag;
  }
  return tag;
};

/**
 * Convert a libsql ResultSet to an array of row objects.
 */
function resultSetToRows<T>(result: ResultSet): T[] {
  const columns = result.columns;
  return result.rows.map((row: Row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj as T;
  });
}
