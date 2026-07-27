import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface GetSubscriptionAttributesRequest extends Omit<
  sns.GetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

/**
 * Runtime binding for `sns:GetSubscriptionAttributes`.
 *
 * Bind this operation to a {@link Subscription} inside a function runtime to
 * read the subscription's raw attribute map (filter policy, redrive policy,
 * raw message delivery, etc.). The binding grants the host function
 * `sns:GetSubscriptionAttributes` on the subscription. Provide the
 * `GetSubscriptionAttributesHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Reading Subscription Attributes
 * @example Read a Subscription's Attributes
 * ```typescript
 * // init (provide SNS.GetSubscriptionAttributesHttp on the Function)
 * const getSubscriptionAttributes =
 *   yield* SNS.GetSubscriptionAttributes(subscription);
 *
 * // runtime
 * const response = yield* getSubscriptionAttributes();
 * const filterPolicy = response.Attributes?.FilterPolicy;
 * ```
 */
export interface GetSubscriptionAttributes extends Binding.Service<
  GetSubscriptionAttributes,
  "AWS.SNS.GetSubscriptionAttributes",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: GetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.GetSubscriptionAttributesResponse,
      sns.GetSubscriptionAttributesError
    >
  >
> {}
export const GetSubscriptionAttributes =
  Binding.Service<GetSubscriptionAttributes>(
    "AWS.SNS.GetSubscriptionAttributes",
  );
