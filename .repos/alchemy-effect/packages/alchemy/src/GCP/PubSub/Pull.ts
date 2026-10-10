import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Subscription } from "./Subscription.ts";

export interface PullRequest extends Omit<
  pubsub.PullProjectsSubscriptionsRequest,
  "subscription"
> {}

/**
 * Runtime binding for Pub/Sub `subscriptions.pull`.
 *
 * Bind this operation to a {@link Subscription} in a Function/Action init
 * phase. Provide {@link PullHttp}.
 *
 * ### Pulling Messages
 * **Example:** Pull messages
 * ```typescript
 * const pull = yield* GCP.PubSub.Pull(subscription);
 * const { receivedMessages } = yield* pull({
 *   body: { maxMessages: 10 },
 * });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Pull extends Binding.Service<
  Pull,
  "GCP.PubSub.Pull",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: PullRequest,
    ) => Effect.Effect<
      pubsub.PullResponse,
      pubsub.PullProjectsSubscriptionsError,
      RuntimeContext
    >
  >
> {}

export const Pull = Binding.Service<Pull>("GCP.PubSub.Pull");
