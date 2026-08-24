import type { CredentialsError } from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SqlConnectionInfo } from "../Connection/internal.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { Cluster } from "./Cluster.ts";

export interface ConnectOptions {
  /**
   * Connect as the built-in `admin` role. Grants `dsql:DbConnectAdmin` on the
   * cluster (instead of `dsql:DbConnect`) and signs the auth token for the
   * `DbConnectAdmin` action.
   * @default false
   */
  admin?: boolean;
  /**
   * Database role to connect as when `admin` is not set. Must be a Postgres
   * role in the cluster that was granted to an IAM identity via
   * `AWS IAM GRANT`.
   */
  username?: string;
  /**
   * Database to connect to.
   * @default "postgres"
   */
  database?: string;
}

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `AppDb` yields `DSQL_APPDB` and the variable
 * `DSQL_APPDB_HOST`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("DSQL", logicalId);

/**
 * Runtime binding that resolves connection settings for an Aurora DSQL
 * cluster using IAM database authentication.
 *
 * DSQL clusters expose a **public** Postgres-wire endpoint
 * (`<clusterId>.dsql.<region>.on.aws:5432`) and authenticate exclusively
 * with short-lived IAM auth tokens — there is no password secret and no VPC
 * requirement. The deploy half grants `dsql:DbConnect` (or
 * `dsql:DbConnectAdmin` with `admin: true`) on the cluster to the host
 * Function; the runtime half mints a presigned token client-side (a pure
 * SigV4 computation, no API call) and returns a {@link SqlConnectionInfo}
 * whose `url` feeds `Drizzle.Postgres` / any Postgres client directly.
 *
 * Token freshness is structural: yielding the returned connection effect
 * re-mints the token, and execution-scoped pools (`Drizzle.Postgres`)
 * rebuild per execution — a ~15-minute token can never outlive its pool.
 *
 * @section Connecting to a Cluster
 * @example Resolve Connection Info inside a Function
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, { admin: true });
 * // inside a handler — each yield mints a fresh auth token:
 * const { host, port, username, password, url } = yield* conn;
 * ```
 *
 * @example Drizzle over DSQL
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, { admin: true });
 * const db = yield* Drizzle.Postgres(conn.pipe(Effect.map((info) => info.url)));
 * // inside a handler:
 * const rows = yield* db.select().from(Widgets);
 * ```
 *
 * @example Connect as a Custom Database Role
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, {
 *   username: "app",
 *   database: "postgres",
 * });
 * ```
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.DSQL.Connect",
  (
    cluster: Cluster,
    options?: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<SqlConnectionInfo, CredentialsError, RuntimeContext>
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.DSQL.Connect");
