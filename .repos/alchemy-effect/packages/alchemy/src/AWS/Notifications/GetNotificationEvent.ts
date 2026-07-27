import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetNotificationEvent}.
 */
export interface GetNotificationEventRequest
  extends notifications.GetNotificationEventRequest {}

/**
 * Runtime binding for `notifications:GetNotificationEvent`.
 *
 * Fetch one notification event (headline, message components, source event
 * metadata) by its ARN. Provide the implementation with
 * `Effect.provide(AWS.Notifications.GetNotificationEventHttp)`.
 * @binding
 * @section Reading Notification Events
 * @example Fetch a Notification Event
 * ```typescript
 * // init — account-level binding takes no resource
 * const getNotificationEvent = yield* AWS.Notifications.GetNotificationEvent();
 *
 * // runtime
 * const event = yield* getNotificationEvent({ arn: eventArn });
 * const headline = event.content.messageComponents.headline;
 * ```
 */
export interface GetNotificationEvent extends Binding.Service<
  GetNotificationEvent,
  "AWS.Notifications.GetNotificationEvent",
  () => Effect.Effect<
    (
      request: GetNotificationEventRequest,
    ) => Effect.Effect<
      notifications.GetNotificationEventResponse,
      notifications.GetNotificationEventError
    >
  >
> {}

export const GetNotificationEvent = Binding.Service<GetNotificationEvent>(
  "AWS.Notifications.GetNotificationEvent",
);
