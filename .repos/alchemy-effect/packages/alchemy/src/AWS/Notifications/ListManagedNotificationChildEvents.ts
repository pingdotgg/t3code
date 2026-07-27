import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListManagedNotificationChildEvents}.
 */
export interface ListManagedNotificationChildEventsRequest
  extends notifications.ListManagedNotificationChildEventsRequest {}

/**
 * Runtime binding for `notifications:ListManagedNotificationChildEvents`.
 *
 * List the child events of one aggregated AWS-managed notification event.
 * Provide the implementation with
 * `Effect.provide(AWS.Notifications.ListManagedNotificationChildEventsHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example List an Aggregate Event's Children
 * ```typescript
 * // init — account-level binding takes no resource
 * const listManagedNotificationChildEvents =
 *   yield* AWS.Notifications.ListManagedNotificationChildEvents();
 *
 * // runtime
 * const result = yield* listManagedNotificationChildEvents({
 *   aggregateManagedNotificationEventArn: aggregateArn,
 * });
 * const children = result.managedNotificationChildEvents;
 * ```
 */
export interface ListManagedNotificationChildEvents extends Binding.Service<
  ListManagedNotificationChildEvents,
  "AWS.Notifications.ListManagedNotificationChildEvents",
  () => Effect.Effect<
    (
      request: ListManagedNotificationChildEventsRequest,
    ) => Effect.Effect<
      notifications.ListManagedNotificationChildEventsResponse,
      notifications.ListManagedNotificationChildEventsError
    >
  >
> {}

export const ListManagedNotificationChildEvents =
  Binding.Service<ListManagedNotificationChildEvents>(
    "AWS.Notifications.ListManagedNotificationChildEvents",
  );
