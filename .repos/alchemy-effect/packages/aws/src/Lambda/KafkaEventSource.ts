import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  KafkaEventSource as MSKKafkaEventSource,
  type KafkaEventSourceProps,
  type KafkaEventSourceService,
  type MSKRecord,
} from "../Kafka/ClusterEventSource.ts";
import type { ServerlessCluster } from "../Kafka/ServerlessCluster.ts";
import { EventSourceMapping } from "./EventSourceMapping.ts";
import * as Lambda from "./Function.ts";

export const isMSKEvent = (event: any): event is lambda.MSKEvent =>
  event?.eventSource === "aws:kafka" &&
  typeof event?.records === "object" &&
  event.records !== null;

// The cluster ARN is `arn:...:cluster/name/uuid`. Topic and consumer-group
// resources live under sibling namespaces (`topic/` and `group/`) scoped to the
// same cluster path; MSK IAM auth grants data-plane access via these ARNs.
const topicArnGlob = (clusterArn: string) => `${clusterArn.replace(":cluster/", ":topic/")}/*`;
const groupArnGlob = (clusterArn: string) => `${clusterArn.replace(":cluster/", ":group/")}/*`;
// `arn:{partition}:kafka:{region}:{account}:cluster/...` →
// `arn:{partition}:ec2:{region}:{account}:`
const ec2ArnPrefix = (clusterArn: string) => {
  const [arn, partition, , region, account] = clusterArn.split(":");
  return `${arn}:${partition}:ec2:${region}:${account}:`;
};

/** @binding */
export const KafkaEventSource = Layer.effect(
  MSKKafkaEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.eventSourceHost("AWS.Lambda.KafkaEventSource");
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      cluster: ServerlessCluster,
      props: KafkaEventSourceProps,
      process: (
        stream: Stream.Stream<MSKRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      // Deploy-time: grant the IAM actions MSK IAM authentication requires and
      // create the event-source mapping. Skipped once running inside the
      // deployed Function (the global guard). Namespaced under the host so the
      // mapping's logical identity is stable.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.Lambda.KafkaEventSource(${cluster}))`({
              policyStatements: [
                {
                  // Cluster-level: connect + describe (Lambda poller + IAM auth).
                  Effect: "Allow",
                  Action: [
                    "kafka-cluster:Connect",
                    "kafka-cluster:DescribeCluster",
                    "kafka-cluster:DescribeClusterDynamicConfiguration",
                    "kafka:DescribeClusterV2",
                    "kafka:GetBootstrapBrokers",
                  ],
                  Resource: [cluster.clusterArn],
                },
                {
                  // Topic-level: read records + describe topics.
                  Effect: "Allow",
                  Action: ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData"],
                  Resource: [cluster.clusterArn.pipe(Output.map(topicArnGlob))],
                },
                {
                  // Consumer-group-level: join/commit as a consumer group.
                  Effect: "Allow",
                  Action: ["kafka-cluster:DescribeGroup", "kafka-cluster:AlterGroup"],
                  Resource: [cluster.clusterArn.pipe(Output.map(groupArnGlob))],
                },
                {
                  // The poller reaches the cluster through ENIs in its VPC;
                  // Lambda validates these on the execution role when the
                  // mapping is created. EC2 Describe* actions do not support
                  // resource-level permissions, so scope them to the
                  // cluster's region instead.
                  Effect: "Allow",
                  Action: [
                    "ec2:DescribeNetworkInterfaces",
                    "ec2:DescribeSecurityGroups",
                    "ec2:DescribeSubnets",
                    "ec2:DescribeVpcs",
                  ],
                  Resource: ["*"],
                  Condition: {
                    StringEquals: {
                      "aws:RequestedRegion": cluster.clusterArn.pipe(
                        Output.map((arn) => arn.split(":")[3]!),
                      ),
                    },
                  },
                },
                {
                  // ENIs may only be created in the cluster's subnets with
                  // the cluster's security groups.
                  Effect: "Allow",
                  Action: ["ec2:CreateNetworkInterface"],
                  Resource: Output.all(
                    cluster.clusterArn,
                    cluster.subnetIds,
                    cluster.securityGroupIds,
                  ).pipe(
                    Output.map(([clusterArn, subnetIds, securityGroupIds]) => [
                      `${ec2ArnPrefix(clusterArn)}network-interface/*`,
                      ...subnetIds.map((id) => `${ec2ArnPrefix(clusterArn)}subnet/${id}`),
                      ...securityGroupIds.map(
                        (id) => `${ec2ArnPrefix(clusterArn)}security-group/${id}`,
                      ),
                    ]),
                  ),
                },
                {
                  // ENIs may only be deleted in the cluster's subnets. Creating
                  // the mapping makes Lambda check this permission with no ENI
                  // and no subnet in the request, which fails a
                  // `network-interface/*` resource or a plain `ec2:Subnet`
                  // condition ("Cannot delete ENIs on the subnets and security
                  // groups associated with the event source"). `IfExists`
                  // passes that check while every real delete, which always
                  // carries the ENI's subnet, stays in the cluster's subnets.
                  Effect: "Allow",
                  Action: ["ec2:DeleteNetworkInterface"],
                  Resource: ["*"],
                  Condition: {
                    StringEquals: {
                      "aws:RequestedRegion": cluster.clusterArn.pipe(
                        Output.map((arn) => arn.split(":")[3]!),
                      ),
                    },
                    ArnEqualsIfExists: {
                      "ec2:Subnet": Output.all(cluster.clusterArn, cluster.subnetIds).pipe(
                        Output.map(([clusterArn, subnetIds]) =>
                          subnetIds.map((id) => `${ec2ArnPrefix(clusterArn)}subnet/${id}`),
                        ),
                      ),
                    },
                  },
                },
              ],
            });

            yield* Mapping(
              `AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${cluster.LogicalId})`,
              {
                functionName: Lambda.qualifiedNameOf(host),
                eventSourceArn: cluster.clusterArn,
                topics: props.topics,
                amazonManagedKafkaEventSourceConfig: props.consumerGroupId
                  ? { ConsumerGroupId: props.consumerGroupId }
                  : undefined,
                batchSize: props.batchSize,
                maximumBatchingWindow: props.maximumBatchingWindow,
                startingPosition: props.startingPosition ?? "LATEST",
                enabled: props.enabled ?? true,
                filterCriteria: props.filterCriteria,
                provisionedPollerConfig: props.provisionedPollerConfig,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (isMSKEvent(event)) {
              // `event.records` maps `topic-partition` → MSKRecord[]; flatten
              // to a single stream of records.
              const records = Object.values(event.records).flat() as MSKRecord[];
              if (records.length > 0) {
                return process(Stream.fromArray(records)).pipe(Effect.orDie);
              }
            }
          };
        }),
      );
    }) as KafkaEventSourceService;
  }),
);
