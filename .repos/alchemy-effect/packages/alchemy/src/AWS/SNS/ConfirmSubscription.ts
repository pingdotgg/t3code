import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface ConfirmSubscriptionRequest extends Omit<
  sns.ConfirmSubscriptionInput,
  "TopicArn"
> {}

/**
 * Runtime binding for `sns:ConfirmSubscription`.
 *
 * Bind this operation to a {@link Subscription} inside a function runtime to
 * confirm a pending subscription with the token SNS delivered to the
 * endpoint (e.g. from an `https` or `email` confirmation message). The
 * binding grants the host function `sns:ConfirmSubscription` on the topic.
 * Provide the `ConfirmSubscriptionHttp` layer on the Function to implement
 * the binding.
 * @binding
 * @section Confirming Subscriptions
 * @example Confirm with a Delivered Token
 * ```typescript
 * // init (provide SNS.ConfirmSubscriptionHttp on the Function)
 * const confirmSubscription = yield* SNS.ConfirmSubscription(subscription);
 *
 * // runtime: token comes from the SubscriptionConfirmation message
 * const response = yield* confirmSubscription({ Token: token });
 * // response.SubscriptionArn
 * ```
 */
export interface ConfirmSubscription extends Binding.Service<
  ConfirmSubscription,
  "AWS.SNS.ConfirmSubscription",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: ConfirmSubscriptionRequest,
    ) => Effect.Effect<
      sns.ConfirmSubscriptionResponse,
      sns.ConfirmSubscriptionError
    >
  >
> {}
export const ConfirmSubscription = Binding.Service<ConfirmSubscription>(
  "AWS.SNS.ConfirmSubscription",
);
