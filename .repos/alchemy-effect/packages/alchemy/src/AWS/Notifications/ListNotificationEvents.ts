import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListNotificationEvents}.
 */
export interface ListNotificationEventsRequest
  extends notifications.ListNotificationEventsRequest {}

/**
 * Runtime binding for `notifications:ListNotificationEvents`.
 *
 * List the account's notification events, optionally filtered by time
 * range, EventBridge source, or aggregate parent event. Provide the
 * implementation with
 * `Effect.provide(AWS.Notifications.ListNotificationEventsHttp)`.
 * @binding
 * @section Reading Notification Events
 * @example List Recent Notification Events
 * ```typescript
 * // init — account-level binding takes no resource
 * const listNotificationEvents = yield* AWS.Notifications.ListNotificationEvents();
 *
 * // runtime
 * const result = yield* listNotificationEvents({ source: "aws.s3" });
 * const headlines = result.notificationEvents.map(
 *   (e) => e.notificationEvent.messageComponents.headline,
 * );
 * ```
 */
export interface ListNotificationEvents extends Binding.Service<
  ListNotificationEvents,
  "AWS.Notifications.ListNotificationEvents",
  () => Effect.Effect<
    (
      request?: ListNotificationEventsRequest,
    ) => Effect.Effect<
      notifications.ListNotificationEventsResponse,
      notifications.ListNotificationEventsError
    >
  >
> {}

export const ListNotificationEvents = Binding.Service<ListNotificationEvents>(
  "AWS.Notifications.ListNotificationEvents",
);
