import type * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdminTopic } from "./AdminTopic.ts";

export interface ComputeHeadCursorRequest extends Omit<
  pubsublite.ComputeHeadCursorTopicStatsProjectsLocationsTopicsRequest,
  "topic"
> {}

/**
 * Runtime binding for Pub/Sub Lite `topicStats.computeHeadCursor`.
 *
 * Bind this operation to an {@link AdminTopic} in a Function/Action init
 * phase. Provide {@link ComputeHeadCursorHttp}.
 *
 * Grants `roles/pubsublite.subscriber` on the project: Pub/Sub Lite has no
 * resource-level IAM.
 *
 * ### Computing the Head Cursor
 * **Example:** Head cursor of partition 0
 * ```typescript
 * const computeHead = yield* GCP.PubSubLite.ComputeHeadCursor(events);
 * const { headCursor } = yield* computeHead({
 *   body: { partition: "0" },
 * });
 * ```
 *
 * @binding
 * @category PubSubLite
 */
export interface ComputeHeadCursor extends Binding.Service<
  ComputeHeadCursor,
  "GCP.PubSubLite.ComputeHeadCursor",
  (
    topic: AdminTopic,
  ) => Effect.Effect<
    (
      request?: ComputeHeadCursorRequest,
    ) => Effect.Effect<
      pubsublite.ComputeHeadCursorResponse,
      pubsublite.ComputeHeadCursorTopicStatsProjectsLocationsTopicsError,
      RuntimeContext
    >
  >
> {}

export const ComputeHeadCursor = Binding.Service<ComputeHeadCursor>(
  "GCP.PubSubLite.ComputeHeadCursor",
);
