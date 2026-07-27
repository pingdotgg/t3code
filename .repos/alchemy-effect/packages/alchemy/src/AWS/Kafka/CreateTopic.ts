import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `CreateTopic` operation (IAM action
 * `kafka:CreateTopic`), scoped to one {@link ServerlessCluster}.
 *
 * Creates a Kafka topic on the bound cluster through the MSK control plane —
 * no Kafka admin client or VPC connectivity required. Provide the
 * implementation with `Effect.provide(AWS.Kafka.CreateTopicHttp)`.
 * @binding
 * @section Managing Topics
 * @example Create a Topic
 * ```typescript
 * const createTopic = yield* Kafka.CreateTopic(cluster);
 *
 * const topic = yield* createTopic({
 *   TopicName: "orders",
 *   PartitionCount: 3,
 * });
 * // topic.TopicArn, topic.Status → "CREATING" | "ACTIVE"
 * ```
 */
export interface CreateTopic extends Binding.Service<
  CreateTopic,
  "AWS.Kafka.CreateTopic",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.CreateTopicRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.CreateTopicResponse, kafka.CreateTopicError>
  >
> {}
export const CreateTopic = Binding.Service<CreateTopic>(
  "AWS.Kafka.CreateTopic",
);
