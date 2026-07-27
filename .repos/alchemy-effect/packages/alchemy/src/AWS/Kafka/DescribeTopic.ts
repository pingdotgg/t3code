import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `DescribeTopic` operation (IAM action
 * `kafka:DescribeTopic`), scoped to one {@link ServerlessCluster}.
 *
 * Reads a topic's partition count, replication factor, configuration, and
 * status through the MSK control plane. Provide the implementation with
 * `Effect.provide(AWS.Kafka.DescribeTopicHttp)`.
 * @binding
 * @section Managing Topics
 * @example Describe a Topic
 * ```typescript
 * const describeTopic = yield* Kafka.DescribeTopic(cluster);
 *
 * const topic = yield* describeTopic({ TopicName: "orders" });
 * // topic.PartitionCount, topic.Configs, topic.Status
 * ```
 */
export interface DescribeTopic extends Binding.Service<
  DescribeTopic,
  "AWS.Kafka.DescribeTopic",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.DescribeTopicRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.DescribeTopicResponse, kafka.DescribeTopicError>
  >
> {}
export const DescribeTopic = Binding.Service<DescribeTopic>(
  "AWS.Kafka.DescribeTopic",
);
