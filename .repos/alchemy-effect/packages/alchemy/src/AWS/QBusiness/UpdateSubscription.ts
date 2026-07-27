import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `UpdateSubscription` request with `applicationId` injected from the bound application.
 */
export interface UpdateSubscriptionRequest extends Omit<
  qbusiness.UpdateSubscriptionRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `UpdateSubscription` operation (IAM action
 * `qbusiness:UpdateSubscription`), scoped to one {@link Application}.
 *
 * Changes an existing subscription's pricing tier.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.UpdateSubscriptionHttp)`.
 *
 * @binding
 * @section Subscriptions
 * @example Change a Subscription Tier
 * ```typescript
 * const updateSubscription = yield* AWS.QBusiness.UpdateSubscription(app);
 *
 * yield* updateSubscription({ subscriptionId, type: "Q_LITE" });
 * ```
 */
export interface UpdateSubscription extends Binding.Service<
  UpdateSubscription,
  "AWS.QBusiness.UpdateSubscription",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: UpdateSubscriptionRequest,
    ) => Effect.Effect<
      qbusiness.UpdateSubscriptionResponse,
      qbusiness.UpdateSubscriptionError
    >
  >
> {}
export const UpdateSubscription = Binding.Service<UpdateSubscription>(
  "AWS.QBusiness.UpdateSubscription",
);
