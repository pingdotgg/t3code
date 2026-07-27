import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link PutNotificationChannel}.
 */
export interface PutNotificationChannelRequest
  extends fms.PutNotificationChannelRequest {}

/**
 * Runtime binding for `fms:PutNotificationChannel`.
 *
 * Designates the SNS topic and IAM role that Firewall Manager uses to record SNS logs — the channel through which Firewall Manager notifications flow. Provide the
 * implementation with `Effect.provide(AWS.FMS.PutNotificationChannelHttp)`.
 * @binding
 * @section Notification Channel
 * @example Set the Notification Channel
 * ```typescript
 * // init — account-level binding takes no resource
 * const putNotificationChannel = yield* AWS.FMS.PutNotificationChannel();
 *
 * // runtime
 * yield* putNotificationChannel({
 *   SnsTopicArn: topicArn,
 *   SnsRoleName: roleArn,
 * });
 * ```
 */
export interface PutNotificationChannel extends Binding.Service<
  PutNotificationChannel,
  "AWS.FMS.PutNotificationChannel",
  () => Effect.Effect<
    (
      request: PutNotificationChannelRequest,
    ) => Effect.Effect<
      fms.PutNotificationChannelResponse,
      fms.PutNotificationChannelError
    >
  >
> {}

export const PutNotificationChannel = Binding.Service<PutNotificationChannel>(
  "AWS.FMS.PutNotificationChannel",
);
