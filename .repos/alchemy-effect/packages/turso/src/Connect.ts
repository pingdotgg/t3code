import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { Database } from "./Database.ts";
import { DatabaseToken, type TokenAuthorization } from "./DatabaseToken.ts";

/**
 * libSQL connection accessors for one Turso database. Resolving them does
 * not open a connection; pass the client to `SQL.LibSQL` or
 * `Drizzle.LibSQL`, or read `url` / `authToken` for `@libsql/client`.
 */
export interface ConnectClient {
  /** libSQL URL of the database (`libsql://<hostname>`). */
  url: Effect.Effect<string, never, RuntimeContext>;
  /** SQL auth token for the database. */
  authToken: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
}

export interface ConnectOptions {
  /**
   * Access level of the token minted for this host.
   * @default "full-access"
   */
  authorization?: TokenAuthorization;
}

/**
 * Connect to a Turso database from a Worker, Lambda, or other host. The
 * host gets the database's URL and its own {@link DatabaseToken}. Your
 * Turso API token stays on your machine.
 *
 * ### Querying a Database
 * **Example:** Effect SQL over a Turso database
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Turso.Connect(Db);
 *   const sql = yield* SQL.LibSQL(conn);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       return yield* HttpServerResponse.json(yield* sql`SELECT 1 AS value`);
 *     }),
 *   };
 * }).pipe(Effect.provide(Turso.ConnectHttp));
 * ```
 *
 * **Example:** Drizzle over a Turso database
 * ```typescript
 * const conn = yield* Turso.Connect(Db);
 * const db = yield* Drizzle.LibSQL(conn, { relations });
 * ```
 *
 * **Example:** AWS Lambda (install the native libSQL client)
 * ```typescript
 * export default class Api extends Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, build: { install: ["@libsql/client"] } },
 *   Effect.gen(function* () {
 *     const sql = yield* SQL.LibSQL(yield* Turso.Connect(Db));
 *     // ...
 *   }).pipe(Effect.provide(Turso.ConnectHttp)),
 * ) {}
 * ```
 *
 * **Example:** Read-only access
 * ```typescript
 * const conn = yield* Turso.Connect(Db, { authorization: "read-only" });
 * ```
 *
 * @binding
 * @product Database
 */
export interface Connect extends Binding.Service<
  Connect,
  "Turso.Connect",
  (database: Database, options?: ConnectOptions) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("Turso.Connect");

/**
 * Host-independent implementation: the URL and a per-host token are bound
 * as environment values, so it works on any Platform host.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const Token = yield* DatabaseToken;
    return Effect.fn(function* (database: Database, options?: ConnectOptions) {
      const host = yield* Binding.Host;
      const authorization = options?.authorization ?? "full-access";
      const token = yield* Token(
        `${host?.LogicalId ?? ""}${database.LogicalId}${authorization === "read-only" ? "ReadOnly" : ""}Token`,
        { database: database.name, authorization },
      );
      return {
        url: yield* database.url,
        authToken: yield* token.token,
      } satisfies ConnectClient;
    });
  }),
);
