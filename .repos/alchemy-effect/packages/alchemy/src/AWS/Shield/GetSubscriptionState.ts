import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:GetSubscriptionState`.
 *
 * Returns whether the account's Shield Advanced subscription is `ACTIVE` or
 * `INACTIVE` — available to every account, subscribed or not, so a handler
 * can branch on Shield Advanced availability before calling gated operations.
 * Provide the implementation with
 * `Effect.provide(AWS.Shield.GetSubscriptionStateHttp)`.
 * @binding
 * @section Subscription Visibility
 * @example Check Shield Advanced Availability
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSubscriptionState = yield* AWS.Shield.GetSubscriptionState();
 *
 * // runtime
 * const { SubscriptionState } = yield* getSubscriptionState();
 * if (SubscriptionState === "ACTIVE") {
 *   // Shield Advanced operations are available
 * }
 * ```
 */
export interface GetSubscriptionState extends Binding.Service<
  GetSubscriptionState,
  "AWS.Shield.GetSubscriptionState",
  () => Effect.Effect<
    (
      request?: shield.GetSubscriptionStateRequest,
    ) => Effect.Effect<
      shield.GetSubscriptionStateResponse,
      shield.GetSubscriptionStateError
    >
  >
> {}
export const GetSubscriptionState = Binding.Service<GetSubscriptionState>(
  "AWS.Shield.GetSubscriptionState",
);
