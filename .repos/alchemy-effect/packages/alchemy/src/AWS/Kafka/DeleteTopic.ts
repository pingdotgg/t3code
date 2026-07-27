import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `DeleteTopic` operation (IAM action
 * `kafka:DeleteTopic`), scoped to one {@link ServerlessCluster}.
 *
 * Deletes a Kafka topic on the bound cluster through the MSK control plane.
 * Provide the implementation with `Effect.provide(AWS.Kafka.DeleteTopicHttp)`.
 * @binding
 * @section Managing Topics
 * @example Delete a Topic
 * ```typescript
 * const deleteTopic = yield* Kafka.DeleteTopic(cluster);
 *
 * yield* deleteTopic({ TopicName: "orders" });
 * ```
 */
export interface DeleteTopic extends Binding.Service<
  DeleteTopic,
  "AWS.Kafka.DeleteTopic",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.DeleteTopicRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.DeleteTopicResponse, kafka.DeleteTopicError>
  >
> {}
export const DeleteTopic = Binding.Service<DeleteTopic>(
  "AWS.Kafka.DeleteTopic",
);
