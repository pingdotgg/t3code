import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListManagedNotificationConfigurations}.
 */
export interface ListManagedNotificationConfigurationsRequest
  extends notifications.ListManagedNotificationConfigurationsRequest {}

/**
 * Runtime binding for `notifications:ListManagedNotificationConfigurations`.
 *
 * List the AWS-managed notification configurations (the AWS Health
 * Security/Operations/Issue/Billing categories), optionally filtered by an
 * associated channel. Provide the implementation with
 * `Effect.provide(AWS.Notifications.ListManagedNotificationConfigurationsHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example List Managed Notification Configurations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listManagedNotificationConfigurations =
 *   yield* AWS.Notifications.ListManagedNotificationConfigurations();
 *
 * // runtime
 * const result = yield* listManagedNotificationConfigurations();
 * const names = result.managedNotificationConfigurations.map((c) => c.name);
 * ```
 */
export interface ListManagedNotificationConfigurations extends Binding.Service<
  ListManagedNotificationConfigurations,
  "AWS.Notifications.ListManagedNotificationConfigurations",
  () => Effect.Effect<
    (
      request?: ListManagedNotificationConfigurationsRequest,
    ) => Effect.Effect<
      notifications.ListManagedNotificationConfigurationsResponse,
      notifications.ListManagedNotificationConfigurationsError
    >
  >
> {}

export const ListManagedNotificationConfigurations =
  Binding.Service<ListManagedNotificationConfigurations>(
    "AWS.Notifications.ListManagedNotificationConfigurations",
  );
