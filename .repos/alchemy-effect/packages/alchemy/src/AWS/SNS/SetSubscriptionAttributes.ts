import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Subscription } from "./Subscription.ts";

export interface SetSubscriptionAttributesRequest extends Omit<
  sns.SetSubscriptionAttributesInput,
  "SubscriptionArn"
> {}

/**
 * Runtime binding for `sns:SetSubscriptionAttributes`.
 *
 * Bind this operation to a {@link Subscription} inside a function runtime to
 * set a single subscription attribute by name (e.g. `FilterPolicy`,
 * `RawMessageDelivery`). The binding grants the host function
 * `sns:SetSubscriptionAttributes` on the subscription. Provide the
 * `SetSubscriptionAttributesHttp` layer on the Function to implement the
 * binding.
 * @binding
 * @section Updating Subscription Attributes
 * @example Set a Filter Policy
 * ```typescript
 * // init (provide SNS.SetSubscriptionAttributesHttp on the Function)
 * const setSubscriptionAttributes =
 *   yield* SNS.SetSubscriptionAttributes(subscription);
 *
 * // runtime
 * yield* setSubscriptionAttributes({
 *   AttributeName: "FilterPolicy",
 *   AttributeValue: JSON.stringify({ type: ["order"] }),
 * });
 * ```
 */
export interface SetSubscriptionAttributes extends Binding.Service<
  SetSubscriptionAttributes,
  "AWS.SNS.SetSubscriptionAttributes",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: SetSubscriptionAttributesRequest,
    ) => Effect.Effect<
      sns.SetSubscriptionAttributesResponse,
      sns.SetSubscriptionAttributesError
    >
  >
> {}
export const SetSubscriptionAttributes =
  Binding.Service<SetSubscriptionAttributes>(
    "AWS.SNS.SetSubscriptionAttributes",
  );
