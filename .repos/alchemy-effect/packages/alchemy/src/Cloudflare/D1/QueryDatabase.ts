import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

/**
 * Bind a {@link Database} to a Worker and obtain the Effect-native D1
 * connection client (`prepare`, `exec`, `batch`, `raw`).
 *
 * `QueryDatabase` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.D1.QueryDatabase(db)`.
 *
 * @example Querying a database inside a Worker
 * ```typescript
 * const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 * const rows = yield* db.prepare("SELECT * FROM users").all();
 * ```
 *
 * @binding
 * @product D1
 * @category Storage & Databases
 */
export interface QueryDatabase extends Binding.Service<
  QueryDatabase,
  "Cloudflare.D1.QueryDatabase",
  (database: Database) => Effect.Effect<QueryDatabaseClient>
> {}

export const QueryDatabase = Binding.Service<QueryDatabase>(
  "Cloudflare.D1.QueryDatabase",
);

/**
 * Effect-native wrapper around a Cloudflare D1 prepared statement.
 *
 * Construction (`prepare`) and binding (`bind`) are synchronous —
 * they're plan builders and don't touch D1. Only the executors
 * (`all`, `first`, `run`, `raw`) round-trip to the database, and
 * those return Effects so they participate in the Effect runtime.
 */
export class PreparedStatement {
  /** @internal */
  constructor(
    private readonly query: string,
    private readonly binds: ReadonlyArray<unknown>,
    private readonly rawEff: Effect.Effect<runtime.D1Database>,
  ) {}

  /**
   * Return a new prepared statement bound to `values`. Subsequent
   * calls replace the previous binding, matching the underlying
   * Cloudflare runtime semantics.
   */
  bind(...values: unknown[]): PreparedStatement {
    return new PreparedStatement(this.query, values, this.rawEff);
  }

  /** Run the query and return all matching rows. */
  all<T = unknown>(): Effect.Effect<
    runtime.D1Result<T>,
    never,
    RuntimeContext
  > {
    return this.withRuntime((stmt) => stmt.all<T>());
  }

  /** Run the query and return the first row, or `null` if no rows. */
  first<T = unknown>(): Effect.Effect<T | null, never, RuntimeContext>;
  first<T = unknown>(
    column: string,
  ): Effect.Effect<T | null, never, RuntimeContext>;
  first<T = unknown>(
    column?: string,
  ): Effect.Effect<T | null, never, RuntimeContext> {
    return this.withRuntime((stmt) =>
      column !== undefined ? stmt.first<T>(column) : stmt.first<T>(),
    );
  }

  /** Run the query as a mutation; returns row metadata. */
  run<T = unknown>(): Effect.Effect<
    runtime.D1Result<T>,
    never,
    RuntimeContext
  > {
    return this.withRuntime((stmt) => stmt.run<T>());
  }

  /** Run the query and return rows as flat arrays. */
  raw<T = unknown[]>(): Effect.Effect<T[], never, RuntimeContext>;
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Effect.Effect<[string[], ...T[]], never, RuntimeContext>;
  raw<T = unknown[]>(options?: {
    columnNames: true;
  }): Effect.Effect<T[] | [string[], ...T[]], never, RuntimeContext> {
    return this.withRuntime((stmt) =>
      options
        ? stmt.raw<T>(options)
        : (stmt.raw<T>() as Promise<T[] | [string[], ...T[]]>),
    );
  }

  /**
   * Materialize the underlying Cloudflare prepared statement against
   * a concrete D1 binding. Used by `QueryDatabaseClient.batch` to
   * collect statements for a single transactional call.
   *
   * @internal
   */
  _build(raw: runtime.D1Database): runtime.D1PreparedStatement {
    const stmt = raw.prepare(this.query);
    return this.binds.length > 0 ? stmt.bind(...this.binds) : stmt;
  }

  private withRuntime<A>(
    fn: (stmt: runtime.D1PreparedStatement) => Promise<A>,
  ): Effect.Effect<A, never, RuntimeContext> {
    return Effect.flatMap(this.rawEff, (raw) =>
      Effect.promise(() => fn(this._build(raw))),
    ) as Effect.Effect<A, never, RuntimeContext>;
  }
}

export interface QueryDatabaseClient {
  /**
   * An Effect that resolves to the raw underlying Cloudflare D1Database binding.
   * Use this when you need direct access for libraries like Better Auth.
   */
  raw: Effect.Effect<runtime.D1Database, never, RuntimeContext>;
  /**
   * Prepare a SQL statement. Returns synchronously — the network
   * round-trip happens when you yield one of the statement's
   * executors (`all`, `first`, `run`, `raw`).
   */
  prepare: (query: string) => PreparedStatement;
  /**
   * Execute raw SQL without prepared statements.
   */
  exec: (
    query: string,
  ) => Effect.Effect<runtime.D1ExecResult, never, RuntimeContext>;
  /**
   * Send multiple prepared statements in a single call.
   * Statements execute sequentially and are rolled back on failure.
   */
  batch: <T = unknown>(
    statements: PreparedStatement[],
  ) => Effect.Effect<runtime.D1Result<T>[], never, RuntimeContext>;
}
