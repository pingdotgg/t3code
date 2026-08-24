import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetManagedNotificationEvent}.
 */
export interface GetManagedNotificationEventRequest
  extends notifications.GetManagedNotificationEventRequest {}

/**
 * Runtime binding for `notifications:GetManagedNotificationEvent`.
 *
 * Fetch one AWS-managed notification event (AWS Health security,
 * operations, billing and issue notifications) by its ARN. Provide the
 * implementation with
 * `Effect.provide(AWS.Notifications.GetManagedNotificationEventHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example Fetch a Managed Notification Event
 * ```typescript
 * // init — account-level binding takes no resource
 * const getManagedNotificationEvent =
 *   yield* AWS.Notifications.GetManagedNotificationEvent();
 *
 * // runtime
 * const event = yield* getManagedNotificationEvent({ arn: eventArn });
 * const headline = event.content.messageComponents.headline;
 * ```
 */
export interface GetManagedNotificationEvent extends Binding.Service<
  GetManagedNotificationEvent,
  "AWS.Notifications.GetManagedNotificationEvent",
  () => Effect.Effect<
    (
      request: GetManagedNotificationEventRequest,
    ) => Effect.Effect<
      notifications.GetManagedNotificationEventResponse,
      notifications.GetManagedNotificationEventError
    >
  >
> {}

export const GetManagedNotificationEvent =
  Binding.Service<GetManagedNotificationEvent>(
    "AWS.Notifications.GetManagedNotificationEvent",
  );
