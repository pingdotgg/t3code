import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface AcknowledgeRequest extends Omit<
  pubsub.AcknowledgeProjectsSubscriptionsRequest,
  "subscription"
> {}

/**
 * Runtime binding for Pub/Sub `subscriptions.acknowledge`.
 *
 * Bind this operation to a {@link Subscription} in a Function/Action init
 * phase. Provide {@link AcknowledgeHttp}.
 *
 * ### Acknowledging Messages
 * **Example:** Acknowledge pulled messages
 * ```typescript
 * const acknowledge = yield* GCP.PubSub.Acknowledge(subscription);
 * yield* acknowledge({
 *   body: { ackIds: [ackId] },
 * });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Acknowledge extends Binding.Service<
  Acknowledge,
  "GCP.PubSub.Acknowledge",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: AcknowledgeRequest,
    ) => Effect.Effect<pubsub.Empty, pubsub.AcknowledgeProjectsSubscriptionsError, RuntimeContext>
  >
> {}

export const Acknowledge = Binding.Service<Acknowledge>("GCP.PubSub.Acknowledge");
