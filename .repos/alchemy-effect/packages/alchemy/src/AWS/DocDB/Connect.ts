import type * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import type * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import type { DBCluster } from "./DBCluster.ts";

/**
 * Connection descriptor for a DocumentDB cluster's MongoDB-compatible data
 * plane. The `url` field is a ready-to-use `mongodb://` connection string —
 * it feeds the {@link mongo} Effect client (or any MongoDB driver) directly.
 */
export interface MongoConnectionInfo {
  /** Writer (cluster) endpoint hostname. */
  host: string;
  /** Listener port (27017 by default). */
  port: number;
  /** Database name, when one was requested. */
  database?: string;
  /** Login user resolved from the secret. */
  username?: string;
  /** Login password resolved from the secret. */
  password?: Redacted.Redacted<string>;
  /** Whether the connection uses TLS (DocumentDB clusters default to on). */
  tls: boolean;
  /**
   * `mongodb://` connection URL carrying the DocumentDB-recommended options
   * (`replicaSet=rs0`, `readPreference=secondaryPreferred`,
   * `retryWrites=false`). `Redacted` because it embeds the password.
   *
   * DocumentDB certificates chain to the private Amazon RDS CA that Node's
   * trust store doesn't carry, so the URL sets
   * `tlsAllowInvalidCertificates=true` (TLS encryption on, identity
   * verification off — libpq `require` semantics, matching
   * `AWS.RDS.Connect`). Pass the RDS CA bundle to {@link mongo}'s `ca`
   * option to restore full verification.
   */
  url: Redacted.Redacted<string>;
}

/**
 * Environment variable prefix under which the connect binding publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `Docs` yields `DOCDB_DOCS` and the variables
 * `DOCDB_DOCS_HOST` and `DOCDB_DOCS_PORT`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("DOCDB", logicalId);

export interface ConnectOptions {
  /**
   * Secrets Manager secret holding `{ username, password }` for the
   * MongoDB-protocol login. Defaults to the cluster's managed master user
   * secret (`manageMasterUserPassword: true`).
   *
   * DocumentDB authenticates over the MongoDB wire protocol (SCRAM) —
   * database users and roles (`read`, `readWrite`, `dbAdmin`, …) are created
   * *inside* the database with `db.createUser(...)`, not through IAM. IAM
   * only governs the management plane, so unlike Aurora there is no
   * `auth: "iam"` mode.
   */
  secret?: Secret;
  /** Database to select in the connection URL and {@link mongo} client. */
  database?: string;
  /** Override the cluster's listener port. */
  port?: number;
  /**
   * Whether the connection uses TLS. Must match the cluster's `tls`
   * parameter (on by default for DocumentDB).
   * @default true
   */
  tls?: boolean;
  /**
   * Subnets the host Function should be attached to so it can open a socket
   * to the cluster — DocumentDB is VPC-only. Wired through the host's `vpc`
   * binding channel, equivalent to setting the Function's `vpc` prop.
   */
  subnetIds?: Input<SubnetId[]>;
  /**
   * Security groups for the host Function's VPC attachment. The referenced
   * groups must be allowed ingress on the cluster port by the cluster's
   * security groups.
   */
  securityGroupIds?: Input<SecurityGroupId[]>;
}

/**
 * Runtime binding that resolves MongoDB connection settings for a DocumentDB
 * {@link DBCluster} from a Secrets Manager secret (the cluster's managed
 * master user secret by default).
 *
 * Binding it yields an Effect (not a callable) that resolves a
 * {@link MongoConnectionInfo} — host, port, credentials, and a ready-to-use
 * `mongodb://` URL — fresh on every execution. No socket is opened; feed the
 * result into {@link mongo} (the bundled Effect client over the `mongodb`
 * driver) or any MongoDB driver. The deploy half grants
 * `secretsmanager:GetSecretValue` on the secret and publishes the endpoint
 * as environment variables. Provide the implementation with
 * `Effect.provide(AWS.DocDB.ConnectHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Query DocumentDB from a Function
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     // init — bind the cluster's managed master secret; grants
 *     // secretsmanager:GetSecretValue and attaches the function to the
 *     // cluster's VPC subnets/security groups
 *     const connect = yield* AWS.DocDB.Connect(cluster, {
 *       database: "app",
 *       subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *       securityGroupIds: [appSecurityGroup.groupId],
 *     });
 *     // init — build the Effect mongo client (one connection per execution)
 *     const db = yield* AWS.DocDB.mongo(connect);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { use } = yield* db;
 *         const orders = yield* use((db) =>
 *           db.collection("orders").find({ open: true }).toArray(),
 *         );
 *         return yield* HttpServerResponse.json({ count: orders.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.DocDB.ConnectHttp)),
 * );
 * ```
 *
 * @example Resolve Raw Connection Info
 * ```typescript
 * // init
 * const connect = yield* AWS.DocDB.Connect(cluster, { database: "app" });
 *
 * // runtime — host/port/credentials plus a ready-to-use mongodb:// URL
 * const info = yield* connect;
 * ```
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.DocDB.Connect",
  (
    cluster: DBCluster,
    options?: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<
      MongoConnectionInfo,
      secretsmanager.GetSecretValueError,
      RuntimeContext
    >
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.DocDB.Connect");

export interface MongoConnectionUrlOptions {
  host: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string | Redacted.Redacted<string>;
  /** Appends the DocumentDB TLS options when `true`. */
  tls?: boolean;
  /** Extra query parameters to append verbatim. */
  params?: Record<string, string>;
}

/**
 * Format a `mongodb://` connection URL with the DocumentDB-recommended
 * options (`replicaSet=rs0`, `readPreference=secondaryPreferred`,
 * `retryWrites=false`). Username and password are percent-encoded; the
 * result is `Redacted` because it embeds the password.
 */
export const formatMongoConnectionUrl = (
  options: MongoConnectionUrlOptions,
): Redacted.Redacted<string> => {
  const password =
    options.password === undefined
      ? undefined
      : typeof options.password === "string"
        ? options.password
        : Redacted.value(options.password);
  const auth =
    options.username !== undefined
      ? password !== undefined
        ? `${encodeURIComponent(options.username)}:${encodeURIComponent(password)}@`
        : `${encodeURIComponent(options.username)}@`
      : "";
  const port = options.port !== undefined ? `:${options.port}` : "";
  const database =
    options.database !== undefined
      ? `/${encodeURIComponent(options.database)}`
      : "/";
  const query = new URLSearchParams({
    replicaSet: "rs0",
    readPreference: "secondaryPreferred",
    retryWrites: "false",
    ...options.params,
  });
  if (options.tls === true) {
    query.set("tls", "true");
    // DocumentDB certs chain to the private Amazon RDS CA — keep TLS on with
    // identity verification off unless the caller supplies the CA bundle
    // (see `mongo`'s `ca` option, which restores full verification).
    if (!query.has("tlsCAFile")) {
      query.set("tlsAllowInvalidCertificates", "true");
    }
  }
  return Redacted.make(
    `mongodb://${auth}${options.host}${port}${database}?${query.toString()}`,
  );
};
