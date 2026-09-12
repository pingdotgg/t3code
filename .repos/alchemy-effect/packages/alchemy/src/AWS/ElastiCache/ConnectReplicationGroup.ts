import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { ReplicationGroup } from "./ReplicationGroup.ts";

export interface ReplicationGroupConnectionInfo {
  host: string;
  port: number;
  readerHost: string | undefined;
  readerPort: number | undefined;
  tls: boolean;
}

export interface ConnectReplicationGroupOptions {
  subnetIds?: Input<SubnetId[]>;
  securityGroupIds?: Input<SecurityGroupId[]>;
}

export const replicationGroupConnectEnvPrefix = (logicalId: string) =>
  makeConnectEnvPrefix("ELASTICACHE", logicalId);

/**
 * Runtime binding for a provisioned Valkey or Redis OSS replication group.
 *
 * At deploy time it publishes the primary endpoint and TLS setting as
 * `ELASTICACHE_{LOGICAL_ID}_{HOST,PORT,TLS}` variables on the host Function.
 * When replicas exist, it also publishes the reader endpoint. Passing VPC
 * options attaches the host Lambda to the cache network. ElastiCache data
 * plane access is controlled by security groups, not IAM.
 *
 * ### Connecting from a Lambda
 * **Example:** Use the primary endpoint with iovalkey
 * ```typescript
 * const connect = yield* AWS.ElastiCache.ConnectReplicationGroup(cache, {
 *   subnetIds: privateSubnetIds,
 *   securityGroupIds: [functionSecurityGroup.groupId],
 * });
 *
 * // inside the handler:
 * const { host, port, tls } = yield* connect;
 * const client = new Valkey({ host, port, ...(tls ? { tls: {} } : {}) });
 * ```
 *
 * @binding
 */
export interface ConnectReplicationGroup extends Binding.Service<
  ConnectReplicationGroup,
  "AWS.ElastiCache.ConnectReplicationGroup",
  (
    group: ReplicationGroup,
    options?: ConnectReplicationGroupOptions,
  ) => Effect.Effect<
    Effect.Effect<ReplicationGroupConnectionInfo, never, RuntimeContext>
  >
> {}
export const ConnectReplicationGroup = Binding.Service<ConnectReplicationGroup>(
  "AWS.ElastiCache.ConnectReplicationGroup",
);
