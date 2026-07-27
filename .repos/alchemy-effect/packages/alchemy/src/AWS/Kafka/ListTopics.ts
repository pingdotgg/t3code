import type * as kafka from "@distilled.cloud/aws/kafka";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `ListTopics` operation (IAM action
 * `kafka:ListTopics`), scoped to one {@link ServerlessCluster}.
 *
 * Lists the topics on the bound cluster through the MSK control plane,
 * optionally filtered by name prefix. Provide the implementation with
 * `Effect.provide(AWS.Kafka.ListTopicsHttp)`.
 * @binding
 * @section Managing Topics
 * @example List the Cluster's Topics
 * ```typescript
 * const listTopics = yield* Kafka.ListTopics(cluster);
 *
 * const page = yield* listTopics({ TopicNameFilter: "orders" });
 * // page.Topics → [{ TopicName: "orders", PartitionCount: 3, … }]
 * ```
 */
export interface ListTopics extends Binding.Service<
  ListTopics,
  "AWS.Kafka.ListTopics",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request?: Omit<kafka.ListTopicsRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.ListTopicsResponse, kafka.ListTopicsError>
  >
> {}
export const ListTopics = Binding.Service<ListTopics>("AWS.Kafka.ListTopics");
