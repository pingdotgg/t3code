import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Connection descriptor for an MSK {@link ServerlessCluster}. Alchemy does
 * not bundle a Kafka client — pass these settings to the Kafka client of
 * your choice (`kafkajs` + `aws-msk-iam-sasl-signer-js`, `@confluentinc/kafka-javascript`, ...),
 * which speaks the Kafka wire protocol against the cluster's SASL/IAM
 * bootstrap endpoint.
 */
export interface ClusterConnectionInfo {
  /**
   * Comma-separated SASL/IAM bootstrap broker string
   * (`boot-….kafka-serverless.….amazonaws.com:9098`).
   */
  bootstrapServers: string;
  /** Bootstrap brokers as individual `host:port` entries (kafkajs `brokers`). */
  brokers: string[];
  /** ARN of the cluster (MSK IAM SASL signers take the cluster's region). */
  clusterArn: string;
  /**
   * SASL mechanism the endpoint requires — always IAM (`AWS_MSK_IAM` over
   * TLS) for MSK Serverless.
   */
  authentication: "iam";
}

/**
 * Environment variable prefix under which the connect bindings publish the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `Events` yields `MSK_EVENTS` and the
 * variables `MSK_EVENTS_BROKERS` and `MSK_EVENTS_ARN`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("MSK", logicalId);

/**
 * Read-only (consumer) runtime access to an MSK {@link ServerlessCluster}'s
 * data plane.
 *
 * Grants the MSK IAM-auth actions a Kafka consumer needs
 * (`kafka-cluster:Connect` on the cluster, `kafka-cluster:ReadData` +
 * `kafka-cluster:DescribeTopic` on the cluster's topics, and
 * `kafka-cluster:DescribeGroup` + `kafka-cluster:AlterGroup` on its consumer
 * groups), publishes the SASL/IAM bootstrap endpoint as environment
 * variables on the host Function, and resolves a typed
 * {@link ClusterConnectionInfo} at runtime.
 *
 * The Kafka data plane is VPC-only — the host Function must be attached to
 * the cluster's VPC and allowed ingress on port 9098 by the cluster's
 * security groups. Provide the implementation with
 * `Effect.provide(AWS.Kafka.ConnectReadHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve Consumer Connection Info inside a Function
 * ```typescript
 * const connect = yield* Kafka.ConnectRead(cluster);
 * // inside a handler:
 * const { brokers, authentication } = yield* connect;
 * ```
 */
export interface ConnectRead extends Binding.Service<
  ConnectRead,
  "AWS.Kafka.ConnectRead",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>
  >
> {}
export const ConnectRead = Binding.Service<ConnectRead>(
  "AWS.Kafka.ConnectRead",
);

/**
 * Write-only (producer) runtime access to an MSK {@link ServerlessCluster}'s
 * data plane.
 *
 * Grants the MSK IAM-auth actions a Kafka producer needs
 * (`kafka-cluster:Connect` + `kafka-cluster:WriteDataIdempotently` on the
 * cluster, `kafka-cluster:WriteData` + `kafka-cluster:DescribeTopic` on the
 * cluster's topics, and the transactional-id actions for transactional
 * producers), publishes the SASL/IAM bootstrap endpoint as environment
 * variables on the host Function, and resolves a typed
 * {@link ClusterConnectionInfo} at runtime.
 *
 * The Kafka data plane is VPC-only — the host Function must be attached to
 * the cluster's VPC and allowed ingress on port 9098 by the cluster's
 * security groups. Provide the implementation with
 * `Effect.provide(AWS.Kafka.ConnectWriteHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve Producer Connection Info inside a Function
 * ```typescript
 * const connect = yield* Kafka.ConnectWrite(cluster);
 * // inside a handler:
 * const { bootstrapServers } = yield* connect;
 * ```
 */
export interface ConnectWrite extends Binding.Service<
  ConnectWrite,
  "AWS.Kafka.ConnectWrite",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>
  >
> {}
export const ConnectWrite = Binding.Service<ConnectWrite>(
  "AWS.Kafka.ConnectWrite",
);

/**
 * Full read-write runtime access to an MSK {@link ServerlessCluster}'s data
 * plane.
 *
 * Grants both the consumer- and producer-side MSK IAM-auth actions on the
 * cluster, its topics, its consumer groups, and its transactional ids,
 * publishes the SASL/IAM bootstrap endpoint as environment variables on the
 * host Function, and resolves a typed {@link ClusterConnectionInfo} at
 * runtime.
 *
 * The Kafka data plane is VPC-only — the host Function must be attached to
 * the cluster's VPC and allowed ingress on port 9098 by the cluster's
 * security groups. Provide the implementation with
 * `Effect.provide(AWS.Kafka.ConnectReadWriteHttp)`.
 * @binding
 * @section Connecting to a Cluster
 * @example Resolve Connection Info inside a Function
 * ```typescript
 * const connect = yield* Kafka.ConnectReadWrite(cluster);
 * // inside a handler:
 * const { bootstrapServers, brokers, clusterArn } = yield* connect;
 * ```
 */
export interface ConnectReadWrite extends Binding.Service<
  ConnectReadWrite,
  "AWS.Kafka.ConnectReadWrite",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>
  >
> {}
export const ConnectReadWrite = Binding.Service<ConnectReadWrite>(
  "AWS.Kafka.ConnectReadWrite",
);
