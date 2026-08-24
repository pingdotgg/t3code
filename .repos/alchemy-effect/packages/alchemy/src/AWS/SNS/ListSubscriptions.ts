import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListSubscriptionsRequest extends sns.ListSubscriptionsInput {}

/**
 * Runtime binding for `sns:ListSubscriptions`.
 *
 * An account-scoped operation — bind it with no arguments to page through
 * all subscriptions in the account/region. The binding grants the host
 * function `sns:ListSubscriptions`. Provide the `ListSubscriptionsHttp`
 * layer on the Function to implement the binding.
 *
 * To list only the subscriptions of one topic, use
 * {@link ListSubscriptionsByTopic}.
 * @binding
 * @section Listing Subscriptions
 * @example List All Subscriptions
 * ```typescript
 * // init (provide SNS.ListSubscriptionsHttp on the Function)
 * const listSubscriptions = yield* SNS.ListSubscriptions();
 *
 * // runtime: pass NextToken to page through large accounts
 * const response = yield* listSubscriptions();
 * // response.Subscriptions
 * ```
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.SNS.ListSubscriptions",
  () => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      sns.ListSubscriptionsResponse,
      sns.ListSubscriptionsError
    >
  >
> {}

export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.SNS.ListSubscriptions",
);
