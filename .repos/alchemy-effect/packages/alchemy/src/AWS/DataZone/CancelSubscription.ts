import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface CancelSubscriptionRequest extends Omit<
  datazone.CancelSubscriptionInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:CancelSubscription`.
 *
 * Cancels a subscription in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.CancelSubscriptionHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example Cancel a Subscription
 * ```typescript
 * // init — bind the operation to the domain
 * const cancelSubscription = yield* AWS.DataZone.CancelSubscription(domain);
 *
 * // runtime
 * yield* cancelSubscription({ identifier: subscriptionId });
 * ```
 */
export interface CancelSubscription extends Binding.Service<
  CancelSubscription,
  "AWS.DataZone.CancelSubscription",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: CancelSubscriptionRequest,
    ) => Effect.Effect<
      datazone.CancelSubscriptionOutput,
      datazone.CancelSubscriptionError
    >
  >
> {}
export const CancelSubscription = Binding.Service<CancelSubscription>(
  "AWS.DataZone.CancelSubscription",
);
