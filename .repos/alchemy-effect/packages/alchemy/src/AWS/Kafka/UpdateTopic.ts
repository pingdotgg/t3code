import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `UpdateTopic` operation (IAM action
 * `kafka:UpdateTopic`), scoped to one {@link ServerlessCluster}.
 *
 * Updates a topic's configuration or increases its partition count through
 * the MSK control plane. Provide the implementation with
 * `Effect.provide(AWS.Kafka.UpdateTopicHttp)`.
 * @binding
 * @section Managing Topics
 * @example Grow a Topic's Partitions
 * ```typescript
 * const updateTopic = yield* Kafka.UpdateTopic(cluster);
 *
 * yield* updateTopic({ TopicName: "orders", PartitionCount: 6 });
 * ```
 */
export interface UpdateTopic extends Binding.Service<
  UpdateTopic,
  "AWS.Kafka.UpdateTopic",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.UpdateTopicRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.UpdateTopicResponse, kafka.UpdateTopicError>
  >
> {}
export const UpdateTopic = Binding.Service<UpdateTopic>(
  "AWS.Kafka.UpdateTopic",
);
