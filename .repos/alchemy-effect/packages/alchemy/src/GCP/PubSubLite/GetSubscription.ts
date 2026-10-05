import type * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdminSubscription } from "./AdminSubscription.ts";

export interface GetSubscriptionRequest extends Omit<
  pubsublite.GetAdminProjectsLocationsSubscriptionsRequest,
  "name"
> {}

/**
 * Runtime binding for Pub/Sub Lite `subscriptions.get`.
 *
 * Bind this operation to an {@link AdminSubscription} in a Function/Action
 * init phase. Provide {@link GetSubscriptionHttp}.
 *
 * Grants `roles/pubsublite.viewer` on the project: Pub/Sub Lite has no
 * resource-level IAM.
 *
 * ### Observing Subscriptions
 * **Example:** Read the bound subscription
 * ```typescript
 * const getSubscription = yield* GCP.PubSubLite.GetSubscription(inbox);
 * const live = yield* getSubscription();
 * ```
 *
 * @binding
 * @category PubSubLite
 */
export interface GetSubscription extends Binding.Service<
  GetSubscription,
  "GCP.PubSubLite.GetSubscription",
  (
    subscription: AdminSubscription,
  ) => Effect.Effect<
    (
      request?: GetSubscriptionRequest,
    ) => Effect.Effect<
      pubsublite.Subscription,
      pubsublite.GetAdminProjectsLocationsSubscriptionsError,
      RuntimeContext
    >
  >
> {}

export const GetSubscription = Binding.Service<GetSubscription>(
  "GCP.PubSubLite.GetSubscription",
);
