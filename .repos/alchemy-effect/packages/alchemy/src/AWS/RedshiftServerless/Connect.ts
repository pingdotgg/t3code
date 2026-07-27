import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  connectEnvPrefix as makeConnectEnvPrefix,
  type SqlConnectionInfo,
} from "../Connection/internal.ts";
import type { Workgroup } from "./Workgroup.ts";

/**
 * Connection descriptor for a Redshift Serverless workgroup. Extends the
 * shared SQL shape with the temporary credential's expiration so callers
 * can reason about token lifetime (credentials are minted fresh on every
 * resolution of the runtime effect, so per-execution pools never outlive
 * them).
 */
export interface WorkgroupConnectionInfo extends SqlConnectionInfo {
  /**
   * When the temporary database credentials expire (15-60 minutes from
   * minting, per {@link ConnectOptions.duration}).
   */
  expiration: Date | undefined;
}

export interface ConnectOptions {
  /**
   * Database to connect to.
   * @default "dev"
   */
  database?: string;
  /**
   * How long the temporary credentials remain valid, e.g. `"15 minutes"` or
   * `Duration.minutes(30)` (a bare number is milliseconds). Rounded to whole
   * seconds on the wire; must land between 900 and 3600 seconds.
   * @default 900 seconds
   */
  duration?: Duration.Input;
}

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * workgroup endpoint on the host Function, derived from the workgroup's
 * logical ID. A workgroup with logical ID `Analytics` yields
 * `REDSHIFT_SERVERLESS_ANALYTICS` and the variables
 * `REDSHIFT_SERVERLESS_ANALYTICS_HOST` /
 * `REDSHIFT_SERVERLESS_ANALYTICS_PORT`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("REDSHIFT_SERVERLESS", logicalId);

/**
 * Runtime binding that resolves pgwire connection settings for a Redshift
 * Serverless {@link Workgroup} using IAM-minted temporary database
 * credentials.
 *
 * At deploy time it attaches the `redshift-serverless:GetCredentials` IAM
 * policy on the workgroup ARN and publishes the workgroup endpoint as
 * environment variables. At runtime it calls
 * `redshift-serverless:GetCredentials` to mint short-lived credentials and
 * returns a typed {@link WorkgroupConnectionInfo} whose `url` feeds
 * `Drizzle.Postgres` directly.
 *
 * The Redshift Data API ({@link RedshiftData.Statements}) remains the
 * recommended default — it needs no driver, no VPC reach, and no credential
 * plumbing. Use `Connect` when you want a real pgwire connection (e.g.
 * Drizzle). Redshift speaks the postgres wire protocol on port 5439 —
 * configure Drizzle with `prepare: false` and avoid `RETURNING` (Redshift
 * does not support either). The host Function must be able to reach the
 * workgroup endpoint (attach it to the workgroup's VPC, or make the
 * workgroup `publiclyAccessible`). Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ConnectHttp)`.
 *
 * @binding
 * @section Connecting to a Workgroup
 * @example Resolve Connection Info inside a Function
 * ```typescript
 * const connect = yield* RedshiftServerless.Connect(workgroup);
 * // inside a handler — mints fresh temporary credentials:
 * const { host, port, username, password, url } = yield* connect;
 * ```
 *
 * @example Drizzle over the Connection URL
 * ```typescript
 * const connect = yield* RedshiftServerless.Connect(workgroup, {
 *   database: "analytics",
 * });
 * const db = yield* Drizzle.Postgres(
 *   Effect.map(connect, (info) => info.url),
 *   { prepare: false },
 * );
 * ```
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.RedshiftServerless.Connect",
  (
    workgroup: Workgroup,
    options?: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<
      WorkgroupConnectionInfo,
      serverless.GetCredentialsError,
      RuntimeContext
    >
  >
> {}
export const Connect = Binding.Service<Connect>(
  "AWS.RedshiftServerless.Connect",
);
