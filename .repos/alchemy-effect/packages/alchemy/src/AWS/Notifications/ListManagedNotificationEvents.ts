import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListManagedNotificationEvents}.
 */
export interface ListManagedNotificationEventsRequest
  extends notifications.ListManagedNotificationEventsRequest {}

/**
 * Runtime binding for `notifications:ListManagedNotificationEvents`.
 *
 * List the account's AWS-managed notification events (AWS Health security,
 * operations, billing and issue notifications), optionally filtered by time
 * range, source, or related account. Provide the implementation with
 * `Effect.provide(AWS.Notifications.ListManagedNotificationEventsHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example List Recent Managed Notification Events
 * ```typescript
 * // init — account-level binding takes no resource
 * const listManagedNotificationEvents =
 *   yield* AWS.Notifications.ListManagedNotificationEvents();
 *
 * // runtime
 * const result = yield* listManagedNotificationEvents({
 *   startTime: new Date(Date.now() - 7 * 24 * 3600 * 1000),
 * });
 * const count = result.managedNotificationEvents.length;
 * ```
 */
export interface ListManagedNotificationEvents extends Binding.Service<
  ListManagedNotificationEvents,
  "AWS.Notifications.ListManagedNotificationEvents",
  () => Effect.Effect<
    (
      request?: ListManagedNotificationEventsRequest,
    ) => Effect.Effect<
      notifications.ListManagedNotificationEventsResponse,
      notifications.ListManagedNotificationEventsError
    >
  >
> {}

export const ListManagedNotificationEvents =
  Binding.Service<ListManagedNotificationEvents>(
    "AWS.Notifications.ListManagedNotificationEvents",
  );
