import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
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
const topicArnGlob = (clusterArn: string) =>
  `${clusterArn.replace(":cluster/", ":topic/")}/*`;
const groupArnGlob = (clusterArn: string) =>
  `${clusterArn.replace(":cluster/", ":group/")}/*`;

/** @binding */
export const KafkaEventSource = Layer.effect(
  MSKKafkaEventSource,
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Mapping = yield* EventSourceMapping;

    return Effect.fn(function* <StreamReq = never, Req = never>(
      cluster: ServerlessCluster,
      props: KafkaEventSourceProps,
      process: (
        stream: Stream.Stream<MSKRecord, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const ClusterArn = yield* cluster.clusterArn;

      // Deploy-time: grant the IAM actions MSK IAM authentication requires and
      // create the event-source mapping. Skipped once running inside the
      // deployed Function (the global guard). Namespaced under the host so the
      // mapping's logical identity is stable.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.Lambda.KafkaEventSource(${cluster}))`(
              {
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
                    Action: [
                      "kafka-cluster:DescribeTopic",
                      "kafka-cluster:ReadData",
                    ],
                    Resource: [
                      cluster.clusterArn.pipe(Output.map(topicArnGlob)),
                    ],
                  },
                  {
                    // Consumer-group-level: join/commit as a consumer group.
                    Effect: "Allow",
                    Action: [
                      "kafka-cluster:DescribeGroup",
                      "kafka-cluster:AlterGroup",
                    ],
                    Resource: [
                      cluster.clusterArn.pipe(Output.map(groupArnGlob)),
                    ],
                  },
                ],
              },
            );

            yield* Mapping(
              `AWS.Lambda.EventSourceMapping(${host.LogicalId}, ${cluster.LogicalId})`,
              {
                functionName: host.functionName,
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
              const records = Object.values(
                event.records,
              ).flat() as MSKRecord[];
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
