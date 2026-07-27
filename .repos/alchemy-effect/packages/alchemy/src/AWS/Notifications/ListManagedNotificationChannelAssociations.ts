import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListManagedNotificationChannelAssociations}.
 */
export interface ListManagedNotificationChannelAssociationsRequest
  extends notifications.ListManagedNotificationChannelAssociationsRequest {}

/**
 * Runtime binding for
 * `notifications:ListManagedNotificationChannelAssociations`.
 *
 * List the account contacts and channels associated with an AWS-managed
 * notification configuration. Provide the implementation with
 * `Effect.provide(AWS.Notifications.ListManagedNotificationChannelAssociationsHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example List a Managed Configuration's Channel Associations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listManagedNotificationChannelAssociations =
 *   yield* AWS.Notifications.ListManagedNotificationChannelAssociations();
 *
 * // runtime
 * const result = yield* listManagedNotificationChannelAssociations({
 *   managedNotificationConfigurationArn: managedConfigArn,
 * });
 * const channels = result.channelAssociations;
 * ```
 */
export interface ListManagedNotificationChannelAssociations extends Binding.Service<
  ListManagedNotificationChannelAssociations,
  "AWS.Notifications.ListManagedNotificationChannelAssociations",
  () => Effect.Effect<
    (
      request: ListManagedNotificationChannelAssociationsRequest,
    ) => Effect.Effect<
      notifications.ListManagedNotificationChannelAssociationsResponse,
      notifications.ListManagedNotificationChannelAssociationsError
    >
  >
> {}

export const ListManagedNotificationChannelAssociations =
  Binding.Service<ListManagedNotificationChannelAssociations>(
    "AWS.Notifications.ListManagedNotificationChannelAssociations",
  );
