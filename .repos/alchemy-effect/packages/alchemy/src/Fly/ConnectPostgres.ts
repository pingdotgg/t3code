import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Postgres } from "./Postgres.ts";

/**
 * Bind a {@link Postgres} cluster to a Fly {@link Service} and obtain
 * the Effect-native connection strings for `Drizzle.Postgres` /
 * `SQL.Postgres`.
 *
 * `ConnectPostgres` is the Context tag, the type, and the callable —
 * `yield* Fly.ConnectPostgres(Db)`. Provide {@link ConnectPostgresHttp}.
 *
 * **Example:** Bind Postgres in a Service
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Postgres";
 *
 * const conn = yield* Fly.ConnectPostgres(Db);
 * const db = yield* Drizzle.Postgres(conn.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * @binding
 */
export interface ConnectPostgres extends Binding.Service<
  ConnectPostgres,
  "Fly.ConnectPostgres",
  (postgres: Postgres) => Effect.Effect<ConnectPostgresClient>
> {}

export const ConnectPostgres = Binding.Service<ConnectPostgres>(
  "Fly.ConnectPostgres",
);

export const connectEnvKeys = (postgres: Pick<Postgres, "LogicalId">) => {
  const id = postgres.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    pooled: `FLY_POSTGRES_${id}_POOLED`,
    direct: `FLY_POSTGRES_${id}_DIRECT`,
  };
};

export class PostgresUrlMissing extends Data.TaggedError(
  "Fly.PostgresUrlMissing",
)<{
  name: string;
}> {}

export interface ConnectPostgresClient {
  /**
   * Pooled PgBouncer connection string. Pass this to
   * {@link Drizzle.Postgres} or `SQL.Postgres`.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
  /**
   * Direct (non-PgBouncer) connection string. Use this for session-scoped
   * features (advisory locks, `LISTEN/NOTIFY`) when you are not going
   * through the pooled URL.
   */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    PostgresUrlMissing,
    RuntimeContext
  >;
}
