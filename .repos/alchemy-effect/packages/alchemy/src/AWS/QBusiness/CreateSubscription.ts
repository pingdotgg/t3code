import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `CreateSubscription` request with `applicationId` injected from the bound application.
 */
export interface CreateSubscriptionRequest extends Omit<
  qbusiness.CreateSubscriptionRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `CreateSubscription` operation (IAM action
 * `qbusiness:CreateSubscription`), scoped to one {@link Application}.
 *
 * Subscribes an IAM Identity Center user or group to a Q Business
 * pricing tier (`Q_LITE` or `Q_BUSINESS`).
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.CreateSubscriptionHttp)`.
 *
 * @binding
 * @section Subscriptions
 * @example Subscribe a User
 * ```typescript
 * const subscribe = yield* AWS.QBusiness.CreateSubscription(app);
 *
 * yield* subscribe({
 *   principal: { user: idcUserId },
 *   type: "Q_BUSINESS",
 * });
 * ```
 */
export interface CreateSubscription extends Binding.Service<
  CreateSubscription,
  "AWS.QBusiness.CreateSubscription",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: CreateSubscriptionRequest,
    ) => Effect.Effect<
      qbusiness.CreateSubscriptionResponse,
      qbusiness.CreateSubscriptionError
    >
  >
> {}
export const CreateSubscription = Binding.Service<CreateSubscription>(
  "AWS.QBusiness.CreateSubscription",
);
