import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DeleteNotificationChannel}.
 */
export interface DeleteNotificationChannelRequest
  extends fms.DeleteNotificationChannelRequest {}

/**
 * Runtime binding for `fms:DeleteNotificationChannel`.
 *
 * Deletes the Firewall Manager association with the IAM role and SNS topic used to record SNS logs. Provide the
 * implementation with `Effect.provide(AWS.FMS.DeleteNotificationChannelHttp)`.
 * @binding
 * @section Notification Channel
 * @example Delete the Notification Channel
 * ```typescript
 * // init — account-level binding takes no resource
 * const deleteNotificationChannel = yield* AWS.FMS.DeleteNotificationChannel();
 *
 * // runtime
 * yield* deleteNotificationChannel();
 * ```
 */
export interface DeleteNotificationChannel extends Binding.Service<
  DeleteNotificationChannel,
  "AWS.FMS.DeleteNotificationChannel",
  () => Effect.Effect<
    (
      request?: DeleteNotificationChannelRequest,
    ) => Effect.Effect<
      fms.DeleteNotificationChannelResponse,
      fms.DeleteNotificationChannelError
    >
  >
> {}

export const DeleteNotificationChannel =
  Binding.Service<DeleteNotificationChannel>(
    "AWS.FMS.DeleteNotificationChannel",
  );
