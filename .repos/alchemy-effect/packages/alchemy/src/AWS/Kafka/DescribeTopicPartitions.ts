import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `DescribeTopicPartitions` operation (IAM action
 * `kafka:DescribeTopicPartitions`), scoped to one {@link ServerlessCluster}.
 *
 * Reads per-partition detail (leader, replicas, ISR) for a topic through the
 * MSK control plane. Pass `NextToken` from the previous page to paginate.
 * Provide the implementation with
 * `Effect.provide(AWS.Kafka.DescribeTopicPartitionsHttp)`.
 * @binding
 * @section Managing Topics
 * @example Read a Topic's Partitions
 * ```typescript
 * const describeTopicPartitions = yield* Kafka.DescribeTopicPartitions(cluster);
 *
 * const page = yield* describeTopicPartitions({ TopicName: "orders" });
 * // page.Partitions → [{ Partition: 0, Leader: …, Isr: […] }, …]
 * ```
 */
export interface DescribeTopicPartitions extends Binding.Service<
  DescribeTopicPartitions,
  "AWS.Kafka.DescribeTopicPartitions",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.DescribeTopicPartitionsRequest, "ClusterArn">,
    ) => Effect.Effect<
      kafka.DescribeTopicPartitionsResponse,
      kafka.DescribeTopicPartitionsError
    >
  >
> {}
export const DescribeTopicPartitions = Binding.Service<DescribeTopicPartitions>(
  "AWS.Kafka.DescribeTopicPartitions",
);
