import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `ListSubscriptions` request with `applicationId` injected from the bound application.
 */
export interface ListSubscriptionsRequest extends Omit<
  qbusiness.ListSubscriptionsRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListSubscriptions` operation (IAM action
 * `qbusiness:ListSubscriptions`), scoped to one {@link Application}.
 *
 * Lists the application's user and group subscriptions.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListSubscriptionsHttp)`.
 *
 * @binding
 * @section Subscriptions
 * @example List Subscriptions
 * ```typescript
 * const listSubscriptions = yield* AWS.QBusiness.ListSubscriptions(app);
 *
 * const { subscriptions } = yield* listSubscriptions();
 * ```
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.QBusiness.ListSubscriptions",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      qbusiness.ListSubscriptionsResponse,
      qbusiness.ListSubscriptionsError
    >
  >
> {}
export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.QBusiness.ListSubscriptions",
);
