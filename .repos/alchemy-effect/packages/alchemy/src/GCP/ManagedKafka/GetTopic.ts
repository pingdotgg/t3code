import type * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ClustersTopic } from "./ClustersTopic.ts";

export interface GetTopicRequest extends Omit<
  kafka.GetProjectsLocationsClustersTopicsRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `topics.get`.
 *
 * Bind this operation to a {@link ClustersTopic} in a Function/Action
 * init phase. Provide {@link GetTopicHttp}.
 *
 * ### Observing Topics
 * **Example:** Read the bound topic
 * ```typescript
 * const getTopic = yield* GCP.ManagedKafka.GetTopic(topic);
 * const live = yield* getTopic();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetTopic extends Binding.Service<
  GetTopic,
  "GCP.ManagedKafka.GetTopic",
  (
    topic: ClustersTopic,
  ) => Effect.Effect<
    (
      request?: GetTopicRequest,
    ) => Effect.Effect<
      kafka.Topic,
      kafka.GetProjectsLocationsClustersTopicsError,
      RuntimeContext
    >
  >
> {}

export const GetTopic = Binding.Service<GetTopic>("GCP.ManagedKafka.GetTopic");
