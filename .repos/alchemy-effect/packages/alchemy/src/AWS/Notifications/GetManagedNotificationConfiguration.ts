import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetManagedNotificationConfiguration}.
 */
export interface GetManagedNotificationConfigurationRequest
  extends notifications.GetManagedNotificationConfigurationRequest {}

/**
 * Runtime binding for `notifications:GetManagedNotificationConfiguration`.
 *
 * Fetch one AWS-managed notification configuration (the AWS Health
 * Security/Operations/Issue/Billing categories) by its ARN. Provide the
 * implementation with
 * `Effect.provide(AWS.Notifications.GetManagedNotificationConfigurationHttp)`.
 * @binding
 * @section Reading AWS-Managed Notifications
 * @example Fetch a Managed Notification Configuration
 * ```typescript
 * // init — account-level binding takes no resource
 * const getManagedNotificationConfiguration =
 *   yield* AWS.Notifications.GetManagedNotificationConfiguration();
 *
 * // runtime
 * const config = yield* getManagedNotificationConfiguration({
 *   arn: managedConfigArn,
 * });
 * ```
 */
export interface GetManagedNotificationConfiguration extends Binding.Service<
  GetManagedNotificationConfiguration,
  "AWS.Notifications.GetManagedNotificationConfiguration",
  () => Effect.Effect<
    (
      request: GetManagedNotificationConfigurationRequest,
    ) => Effect.Effect<
      notifications.GetManagedNotificationConfigurationResponse,
      notifications.GetManagedNotificationConfigurationError
    >
  >
> {}

export const GetManagedNotificationConfiguration =
  Binding.Service<GetManagedNotificationConfiguration>(
    "AWS.Notifications.GetManagedNotificationConfiguration",
  );
