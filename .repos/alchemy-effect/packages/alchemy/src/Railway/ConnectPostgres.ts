import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Postgres } from "./Postgres.ts";

/**
 * Bind a {@link Postgres} database to a Railway {@link Service} or
 * {@link Function} and obtain the Effect-native connection string for
 * `Drizzle.Postgres` / `SQL.Postgres`.
 *
 * `ConnectPostgres` is the Context tag, the type, and the callable —
 * `yield* Railway.ConnectPostgres(Db)`. Provide {@link ConnectPostgresHttp}.
 *
 * **Example:** Bind Postgres in a Function
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Postgres";
 *
 * export default class Query extends Railway.Function<Query>()(
 *   "Query",
 *   { project: Site, main: import.meta.url, build: { install: ["pg"] } },
 *   Effect.gen(function* () {
 *     const conn = yield* Railway.ConnectPostgres(Db);
 *     const db = yield* Drizzle.Postgres(conn.connectionString);
 *     return {
 *       fetch: db.execute("select 1 as ok").pipe(
 *         Effect.flatMap(HttpServerResponse.json),
 *       ),
 *     };
 *   }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
 * ) {}
 * ```
 *
 * ### Variable references
 * `ConnectPostgres` packs a typed private URI onto the host. To store
 * Railway's template instead of a resolved URI (IaC
 * `db.env.DATABASE_URL`), pass `Railway.ref(Db, "DATABASE_URL")` as a
 * {@link Variable} `value` or `Service.env` entry. Railway interpolates
 * `${{Db.DATABASE_URL}}` at build/runtime.
 *
 * **Example:** Railway.ref
 * ```typescript
 * const db = yield* Railway.Postgres("Db", { project: site });
 * yield* Railway.Variable("DatabaseUrl", {
 *   project: site,
 *   service: api,
 *   name: "DATABASE_URL",
 *   value: Railway.ref(db, "DATABASE_URL"),
 * });
 * ```
 *
 * @binding
 * @product Railway
 * @category Storage & Databases
 */
export interface ConnectPostgres extends Binding.Service<
  ConnectPostgres,
  "Railway.ConnectPostgres",
  (postgres: Postgres) => Effect.Effect<ConnectPostgresClient>
> {}

export const ConnectPostgres = Binding.Service<ConnectPostgres>(
  "Railway.ConnectPostgres",
);

export const DATABASE_URL_SECRET = "DATABASE_URL";
export const DATABASE_PUBLIC_URL_SECRET = "DATABASE_PUBLIC_URL";

export const connectEnvKeys = (postgres: Pick<Postgres, "LogicalId">) => {
  const id = postgres.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    pooled: `RAILWAY_POSTGRES_${id}_POOLED`,
    direct: `RAILWAY_POSTGRES_${id}_DIRECT`,
  };
};

export class PostgresUrlMissing extends Data.TaggedError(
  "Railway.PostgresUrlMissing",
)<{
  name: string;
}> {}

export interface ConnectPostgresClient {
  /**
   * Private (`{name}.railway.internal`) connection string. Pass this to
   * {@link Drizzle.Postgres} or `SQL.Postgres` from a {@link Service}.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Same private URI — Railway Postgres has no PgBouncer split. Kept so
   * callers matching the Fly `ConnectPostgres` shape keep working.
   */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
}
