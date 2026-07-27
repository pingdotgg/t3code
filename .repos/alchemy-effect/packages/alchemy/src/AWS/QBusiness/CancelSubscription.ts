import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `CancelSubscription` request with `applicationId` injected from the bound application.
 */
export interface CancelSubscriptionRequest extends Omit<
  qbusiness.CancelSubscriptionRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `CancelSubscription` operation (IAM action
 * `qbusiness:CancelSubscription`), scoped to one {@link Application}.
 *
 * Unsubscribes a user or group; the change takes effect at the next
 * month boundary.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.CancelSubscriptionHttp)`.
 *
 * @binding
 * @section Subscriptions
 * @example Cancel a Subscription
 * ```typescript
 * const cancel = yield* AWS.QBusiness.CancelSubscription(app);
 *
 * yield* cancel({ subscriptionId });
 * ```
 */
export interface CancelSubscription extends Binding.Service<
  CancelSubscription,
  "AWS.QBusiness.CancelSubscription",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: CancelSubscriptionRequest,
    ) => Effect.Effect<
      qbusiness.CancelSubscriptionResponse,
      qbusiness.CancelSubscriptionError
    >
  >
> {}
export const CancelSubscription = Binding.Service<CancelSubscription>(
  "AWS.QBusiness.CancelSubscription",
);
