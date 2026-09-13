import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { MySQL } from "./MySQL.ts";

/**
 * Bind a {@link MySQL} service to a Railway {@link Service} and obtain
 * the Effect-native connection string for `Drizzle.MySQL` /
 * `SQL.MySQL`.
 *
 * `ConnectMySQL` is the Context tag, the type, and the callable —
 * `yield* Railway.ConnectMySQL(Db)`. Provide {@link ConnectMySQLHttp}.
 *
 * **Example:** Bind MySQL in a Service
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/MySQL";
 *
 * const conn = yield* Railway.ConnectMySQL(Db);
 * const db = yield* Drizzle.MySQL(conn.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.execute("select 1 as ok", "objects");
 * });
 * ```
 *
 * ### Variable references
 * `ConnectMySQL` packs a typed private URI onto the Service. To store
 * Railway's template instead of a resolved URI (IaC `db.env.MYSQL_URL`),
 * pass `Railway.ref(Db, "MYSQL_URL")` as a {@link Variable} `value` or
 * `Service.env` entry.
 *
 * **Example:** Railway.ref
 * ```typescript
 * const db = yield* Railway.MySQL("Db", { project: site });
 * yield* Railway.Variable("MysqlUrl", {
 *   project: site,
 *   service: api,
 *   name: "MYSQL_URL",
 *   value: Railway.ref(db, "MYSQL_URL"),
 * });
 * ```
 *
 * @binding
 * @product Railway
 * @category Storage & Databases
 */
export interface ConnectMySQL extends Binding.Service<
  ConnectMySQL,
  "Railway.ConnectMySQL",
  (mysql: MySQL) => Effect.Effect<ConnectMySQLClient>
> {}

export const ConnectMySQL = Binding.Service<ConnectMySQL>(
  "Railway.ConnectMySQL",
);

export const connectEnvKeys = (mysql: Pick<MySQL, "LogicalId">) => {
  const id = mysql.LogicalId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return {
    pooled: `RAILWAY_MYSQL_${id}_POOLED`,
    direct: `RAILWAY_MYSQL_${id}_DIRECT`,
  };
};

export class MySQLUrlMissing extends Data.TaggedError(
  "Railway.MySQLUrlMissing",
)<{
  name: string;
}> {}

export interface ConnectMySQLClient {
  /**
   * Private (`{name}.railway.internal`) connection string. Pass this to
   * {@link Drizzle.MySQL} or `SQL.MySQL` from a {@link Service}.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    MySQLUrlMissing,
    RuntimeContext
  >;
  /**
   * Same private URI — Railway MySQL has no proxy-pooler split. Kept so
   * callers matching the `ConnectPostgres` shape keep working.
   */
  directConnectionString: Effect.Effect<
    Redacted.Redacted<string>,
    MySQLUrlMissing,
    RuntimeContext
  >;
}
