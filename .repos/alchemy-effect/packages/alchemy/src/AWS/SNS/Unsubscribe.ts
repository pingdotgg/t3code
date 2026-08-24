import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface UnsubscribeRequest extends sns.UnsubscribeInput {}

/**
 * Runtime binding for `sns:Unsubscribe`.
 *
 * An account-scoped operation — deletes a subscription by ARN, e.g. one
 * created at runtime with the `Subscribe` binding.
 * Provide the `UnsubscribeHttp` layer on the Function to implement the binding.
 * @binding
 * @section Unsubscribing
 * @example Unsubscribe by ARN
 * ```typescript
 * const unsubscribe = yield* SNS.Unsubscribe();
 * yield* unsubscribe({ SubscriptionArn: subscriptionArn });
 * ```
 */
export interface Unsubscribe extends Binding.Service<
  Unsubscribe,
  "AWS.SNS.Unsubscribe",
  () => Effect.Effect<
    (
      request: UnsubscribeRequest,
    ) => Effect.Effect<sns.UnsubscribeResponse, sns.UnsubscribeError>
  >
> {}

export const Unsubscribe = Binding.Service<Unsubscribe>("AWS.SNS.Unsubscribe");
