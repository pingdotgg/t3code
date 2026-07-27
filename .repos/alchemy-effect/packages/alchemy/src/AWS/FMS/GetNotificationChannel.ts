import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetNotificationChannel}.
 */
export interface GetNotificationChannelRequest
  extends fms.GetNotificationChannelRequest {}

/**
 * Runtime binding for `fms:GetNotificationChannel`.
 *
 * Returns the SNS topic that is used to record Firewall Manager SNS logs. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetNotificationChannelHttp)`.
 * @binding
 * @section Notification Channel
 * @example Read the Notification Channel
 * ```typescript
 * // init — account-level binding takes no resource
 * const getNotificationChannel = yield* AWS.FMS.GetNotificationChannel();
 *
 * // runtime
 * const result = yield* getNotificationChannel();
 * console.log(result.SnsTopicArn);
 * ```
 */
export interface GetNotificationChannel extends Binding.Service<
  GetNotificationChannel,
  "AWS.FMS.GetNotificationChannel",
  () => Effect.Effect<
    (
      request?: GetNotificationChannelRequest,
    ) => Effect.Effect<
      fms.GetNotificationChannelResponse,
      fms.GetNotificationChannelError
    >
  >
> {}

export const GetNotificationChannel = Binding.Service<GetNotificationChannel>(
  "AWS.FMS.GetNotificationChannel",
);
