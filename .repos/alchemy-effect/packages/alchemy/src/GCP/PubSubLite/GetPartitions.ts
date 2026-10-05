import type * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdminTopic } from "./AdminTopic.ts";

export interface GetPartitionsRequest extends Omit<
  pubsublite.GetPartitionsAdminProjectsLocationsTopicsRequest,
  "name"
> {}

/**
 * Runtime binding for Pub/Sub Lite `topics.getPartitions`.
 *
 * Bind this operation to an {@link AdminTopic} in a Function/Action init
 * phase. Provide {@link GetPartitionsHttp}.
 *
 * Grants `roles/pubsublite.viewer` on the project: Pub/Sub Lite has no
 * resource-level IAM.
 *
 * ### Reading Partition Count
 * **Example:** Get the live partition count
 * ```typescript
 * const getPartitions = yield* GCP.PubSubLite.GetPartitions(events);
 * const { partitionCount } = yield* getPartitions();
 * ```
 *
 * @binding
 * @category PubSubLite
 */
export interface GetPartitions extends Binding.Service<
  GetPartitions,
  "GCP.PubSubLite.GetPartitions",
  (
    topic: AdminTopic,
  ) => Effect.Effect<
    (
      request?: GetPartitionsRequest,
    ) => Effect.Effect<
      pubsublite.TopicPartitions,
      pubsublite.GetPartitionsAdminProjectsLocationsTopicsError,
      RuntimeContext
    >
  >
> {}

export const GetPartitions = Binding.Service<GetPartitions>(
  "GCP.PubSubLite.GetPartitions",
);
