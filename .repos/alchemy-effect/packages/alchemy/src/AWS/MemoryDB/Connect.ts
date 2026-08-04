import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { Cluster } from "./Cluster.ts";
import type { User } from "./User.ts";

/**
 * Connection descriptor for a MemoryDB cluster. Alchemy does not bundle a
 * valkey/redis client — pass these settings to the cluster-mode client of
 * your choice (`iovalkey`, `ioredis`, ...).
 */
export interface ClusterConnectionInfo {
  /** Cluster (configuration) endpoint hostname. */
  host: string;
  /** Cluster endpoint port (6379 by default). */
  port: number;
  /**
   * Whether the cluster requires TLS connections (MemoryDB clusters default
   * to in-transit encryption on).
   */
  tls: boolean;
}

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `SessionStore` yields `MEMORYDB_SESSIONSTORE`
 * and the variables `MEMORYDB_SESSIONSTORE_HOST`,
 * `MEMORYDB_SESSIONSTORE_PORT`, and `MEMORYDB_SESSIONSTORE_TLS`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("MEMORYDB", logicalId);

export interface ConnectOptions {
  /**
   * MemoryDB {@link User}s the host authenticates as via IAM authentication
   * (`authenticationMode: { type: "iam" }`). Each listed user's ARN is added
   * to the `memorydb:Connect` grant — IAM auth authorizes against both the
   * cluster and the user. Password-authenticated users need no IAM grant;
   * omit this option and supply the password to your client instead.
   */
  users?: User[];
  /**
   * Subnets the host Function should be attached to so it can open a socket
   * to the cluster — MemoryDB is VPC-only. Wired through the host's `vpc`
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
 * Runtime binding that resolves connection settings for a MemoryDB
 * {@link Cluster}.
 *
 * At deploy time it publishes the cluster endpoint as
 * `MEMORYDB_{LOGICAL_ID}_{HOST,PORT,TLS}` environment variables on the host
 * Function and grants `memorydb:Connect` on the cluster (plus any IAM-auth
 * {@link User}s passed via `options.users`); at runtime it resolves the same
 * values into a typed {@link ClusterConnectionInfo}. Network access is
 * governed by VPC security groups — the host Function must:
 *
 * 1. be attached to the cluster's VPC (`vpc: { subnetIds, securityGroupIds }`
 *    or the binding's `subnetIds`/`securityGroupIds` options), and
 * 2. have a security group allowed ingress on the cluster's port by one of
 *    the cluster's `securityGroupIds`.
 *
 * Provide the implementation with `Effect.provide(AWS.MemoryDB.ConnectHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve Connection Info inside a Function
 * ```typescript
 * // init — publishes env vars, grants memorydb:Connect, attaches the VPC
 * const connect = yield* AWS.MemoryDB.Connect(cluster, {
 *   users: [appUser],
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [appSecurityGroup.groupId],
 * });
 *
 * // inside a handler:
 * const { host, port, tls } = yield* connect;
 * ```
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.MemoryDB.Connect",
  (
    cluster: Cluster,
    options?: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>
  >
> {}
export const Connect = Binding.Service<Connect>("AWS.MemoryDB.Connect");
