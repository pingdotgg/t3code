import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  connectEnvPrefix as makeConnectEnvPrefix,
  type SqlConnectionInfo,
} from "../Connection/internal.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Connection descriptor for a provisioned Redshift cluster. Extends the
 * shared SQL shape with the temporary credential's expiration so callers
 * can reason about token lifetime (credentials are minted fresh on every
 * resolution of the runtime effect, so per-execution pools never outlive
 * them).
 */
export interface ClusterConnectionInfo extends SqlConnectionInfo {
  /**
   * When the temporary database credentials expire (15-60 minutes from
   * minting, per {@link ConnectOptions.duration}).
   */
  expiration: Date | undefined;
}

export interface ConnectOptions {
  /**
   * Database to connect to.
   * @default the cluster's initial database (`dbName` attribute)
   */
  database?: string;
  /**
   * Database user to mint temporary credentials for via
   * `redshift:GetClusterCredentials`. When omitted, credentials are minted
   * with `redshift:GetClusterCredentialsWithIAM` instead — the database
   * user is mapped 1:1 to the Function's IAM identity.
   */
  dbUser?: string;
  /**
   * Create the database user if it does not exist. Only used with
   * {@link ConnectOptions.dbUser}; adds `redshift:CreateClusterUser` to the
   * host's policy.
   * @default false
   */
  autoCreate?: boolean;
  /**
   * Database groups the user joins for the session. Only used with
   * {@link ConnectOptions.dbUser}; adds `redshift:JoinGroup` on each group
   * to the host's policy.
   */
  dbGroups?: string[];
  /**
   * How long the temporary credentials remain valid, e.g. `"15 minutes"` or
   * `Duration.minutes(30)` (a bare number is milliseconds). Rounded to whole
   * seconds on the wire; must land between 900 and 3600 seconds.
   * @default 900 seconds
   */
  duration?: Duration.Input;
  /**
   * Whether to require TLS on the connection.
   * @default true
   */
  ssl?: boolean;
}

/**
 * Errors the runtime credential mint can produce (`GetClusterCredentials`
 * and `GetClusterCredentialsWithIAM` share the same union).
 */
export type ConnectError =
  | redshift.GetClusterCredentialsError
  | redshift.GetClusterCredentialsWithIAMError;

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `Analytics` yields `REDSHIFT_ANALYTICS` and
 * the variables `REDSHIFT_ANALYTICS_HOST` / `REDSHIFT_ANALYTICS_PORT`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("REDSHIFT", logicalId);

/**
 * Runtime binding that resolves pgwire connection settings for a
 * provisioned Redshift {@link Cluster} using IAM-minted temporary database
 * credentials.
 *
 * At deploy time it attaches the `redshift:GetClusterCredentials[WithIAM]`
 * IAM policy (scoped to the cluster's `dbname`/`dbuser` ARNs) and publishes
 * the cluster endpoint as environment variables. At runtime it calls the
 * corresponding SDK operation to mint short-lived credentials and returns a
 * typed {@link ClusterConnectionInfo} whose `url` feeds `Drizzle.Postgres`
 * directly.
 *
 * The Redshift Data API ({@link RedshiftData.Statements}) remains the
 * recommended default — it needs no driver, no VPC reach, and no credential
 * plumbing. Use `Connect` when you want a real pgwire connection (e.g.
 * Drizzle). Redshift speaks the postgres wire protocol on port 5439 —
 * configure Drizzle with `prepare: false` and avoid `RETURNING` (Redshift
 * does not support either). The host Function must be able to reach the
 * cluster endpoint (attach it to the cluster's VPC, or make the cluster
 * `publiclyAccessible`). Provide the implementation with
 * `Effect.provide(AWS.Redshift.ConnectHttp)`.
 *
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve Connection Info inside a Function (IAM identity)
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster);
 * // inside a handler — mints fresh temporary credentials:
 * const { host, port, username, password, url } = yield* connect;
 * ```
 *
 * @example Connect as a Named Database User
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster, {
 *   dbUser: "etl",
 *   autoCreate: true,
 *   dbGroups: ["analysts"],
 *   database: "analytics",
 * });
 * ```
 *
 * @example Drizzle over the Connection URL
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster);
 * const db = yield* Drizzle.Postgres(
 *   Effect.map(connect, (info) => info.url),
 *   { prepare: false },
 * );
 * ```
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.Redshift.Connect",
  (
    cluster: Cluster,
    options?: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<ClusterConnectionInfo, ConnectError, RuntimeContext>
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.Redshift.Connect");
