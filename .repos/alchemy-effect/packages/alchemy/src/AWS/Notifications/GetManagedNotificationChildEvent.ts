import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetManagedNotificationChildEvent}.
 */
export interface GetManagedNotificationChildEventRequest
  extends notifications.GetManagedNotificationChildEventRequest {}

/**
 * Runtime binding for `notifications:GetManagedNotificationChildEvent`.
 *
 * Fetch one child event of an aggregated AWS-managed notification (e.g. a
 * single account/region item inside an aggregate AWS Health event) by its
 * ARN. Provide the implementation with
 * `Effect.provide(AWS.Notifications.GetManagedNotificationChildEventHttp)`.
 * ### Reading AWS-Managed Notifications
 * **Example:** Fetch a Managed Notification Child Event
 * ```typescript
 * // init — account-level binding takes no resource
 * const getManagedNotificationChildEvent =
 *   yield* AWS.Notifications.GetManagedNotificationChildEvent();
 *
 * // runtime
 * const child = yield* getManagedNotificationChildEvent({ arn: childArn });
 * ```
 *
 * @binding
 */
export interface GetManagedNotificationChildEvent extends Binding.Service<
  GetManagedNotificationChildEvent,
  "AWS.Notifications.GetManagedNotificationChildEvent",
  () => Effect.Effect<
    (
      request: GetManagedNotificationChildEventRequest,
    ) => Effect.Effect<
      notifications.GetManagedNotificationChildEventResponse,
      notifications.GetManagedNotificationChildEventError
    >
  >
> {}

export const GetManagedNotificationChildEvent =
  Binding.Service<GetManagedNotificationChildEvent>(
    "AWS.Notifications.GetManagedNotificationChildEvent",
  );
