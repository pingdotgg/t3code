import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  groupArnGlob,
  topicArnGlob,
  transactionalIdArnGlob,
} from "./BindingHttp.ts";
import { connectEnvPrefix } from "./Connect.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Shared scaffolding for the MSK connect bindings.
 *
 * NOT exported from `index.ts` — `ConnectReadHttp.ts` / `ConnectWriteHttp.ts`
 * / `ConnectReadWriteHttp.ts` are thin
 * `Layer.effect(Cap, makeKafkaConnectHttpBinding({ … }))` calls over the
 * builder below. Only the IAM action sets differ per access level.
 */

/** Cluster-level actions every MSK IAM-auth client needs. */
export const KAFKA_CONNECT_ACTIONS = [
  "kafka-cluster:Connect",
  "kafka-cluster:DescribeCluster",
  "kafka-cluster:DescribeClusterDynamicConfiguration",
] as const;

/** Topic-level consumer actions. */
export const KAFKA_READ_TOPIC_ACTIONS = [
  "kafka-cluster:DescribeTopic",
  "kafka-cluster:ReadData",
] as const;

/** Consumer-group actions (join a group, commit offsets). */
export const KAFKA_READ_GROUP_ACTIONS = [
  "kafka-cluster:DescribeGroup",
  "kafka-cluster:AlterGroup",
] as const;

/** Topic-level producer actions. */
export const KAFKA_WRITE_TOPIC_ACTIONS = [
  "kafka-cluster:DescribeTopic",
  "kafka-cluster:WriteData",
] as const;

/** Cluster-level producer actions (idempotent producers). */
export const KAFKA_WRITE_CLUSTER_ACTIONS = [
  "kafka-cluster:WriteDataIdempotently",
] as const;

/** Transactional-id actions (transactional producers). */
export const KAFKA_WRITE_TRANSACTION_ACTIONS = [
  "kafka-cluster:DescribeTransactionalId",
  "kafka-cluster:AlterTransactionalId",
] as const;

/**
 * Build the impl Effect for a connect binding. At deploy time it grants the
 * given action sets on the cluster / topic / group / transactional-id ARN
 * namespaces and publishes the SASL/IAM bootstrap endpoint as
 * `MSK_{LOGICAL_ID}_{BROKERS,ARN}` environment variables on the host
 * Function; at runtime it resolves the same values into a typed connection
 * descriptor.
 */
export const makeKafkaConnectHttpBinding = (options: {
  /** Fully-qualified binding tag, e.g. `AWS.Kafka.ConnectReadWrite`. */
  tag: string;
  /** IAM actions granted on the cluster ARN. */
  clusterActions: readonly string[];
  /** IAM actions granted on the cluster's `topic/…/*` ARNs. */
  topicActions: readonly string[];
  /** IAM actions granted on the cluster's `group/…/*` ARNs. */
  groupActions?: readonly string[];
  /** IAM actions granted on the cluster's `transactional-id/…/*` ARNs. */
  transactionActions?: readonly string[];
}) =>
  Effect.gen(function* () {
    return Effect.fn(function* (cluster: ServerlessCluster) {
      const BootstrapServers = yield* cluster.bootstrapBrokerStringSaslIam;
      const ClusterArn = yield* cluster.clusterArn;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const prefix = connectEnvPrefix(cluster.LogicalId);
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            env: {
              [`${prefix}_BROKERS`]: cluster.bootstrapBrokerStringSaslIam,
              [`${prefix}_ARN`]: cluster.clusterArn,
            },
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.clusterActions],
                Resource: [Output.interpolate`${cluster.clusterArn}`],
              },
              {
                Effect: "Allow",
                Action: [...options.topicActions],
                Resource: [cluster.clusterArn.pipe(Output.map(topicArnGlob))],
              },
              ...(options.groupActions?.length
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.groupActions],
                      Resource: [
                        cluster.clusterArn.pipe(Output.map(groupArnGlob)),
                      ],
                    },
                  ]
                : []),
              ...(options.transactionActions?.length
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.transactionActions],
                      Resource: [
                        cluster.clusterArn.pipe(
                          Output.map(transactionalIdArnGlob),
                        ),
                      ],
                    },
                  ]
                : []),
            ],
          });
        }
      }

      return Effect.gen(function* () {
        const bootstrapServers = yield* BootstrapServers;
        const clusterArn = yield* ClusterArn;
        if (!bootstrapServers) {
          return yield* Effect.die(
            `MSK SASL/IAM bootstrap brokers for '${cluster.LogicalId}' are not available yet`,
          );
        }
        return {
          bootstrapServers,
          brokers: bootstrapServers.split(","),
          clusterArn,
          authentication: "iam" as const,
        };
      });
    });
  });
