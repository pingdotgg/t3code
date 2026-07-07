import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RelayDeliveryResult } from "@t3tools/contracts/relay";

import { sanitizeApnsNotificationPayload } from "./agentActivityPayloads.ts";
import { fcmChannelIdForPhase } from "./pushNotificationDelivery.ts";
import {
  expiresAtForFcmJob,
  makeFcmDeliveryJobPayload,
  signFcmDeliveryJob,
  type FcmDeliveryJobPayload,
  type SignedFcmDeliveryJob,
} from "./fcmDeliveryJobs.ts";
import * as RelayConfiguration from "../Config.ts";

export class FcmDeliveryQueueSendError extends Schema.TaggedErrorClass<FcmDeliveryQueueSendError>()(
  "FcmDeliveryQueueSendError",
  {
    operation: Schema.Literals(["generate-job-id", "send"]),
    jobId: Schema.NullOr(Schema.String),
    userId: Schema.String,
    deviceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to enqueue FCM push notification delivery during ${this.operation} for device ${this.deviceId}.`;
  }
}

export type FcmDeliveryQueueError = FcmDeliveryQueueSendError;

export class FcmDeliveryQueueSender extends Context.Service<
  FcmDeliveryQueueSender,
  {
    readonly send: (body: SignedFcmDeliveryJob) => Effect.Effect<void, Cloudflare.QueueSendError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveryQueue/FcmDeliveryQueueSender") {}

export class FcmDeliveryQueue extends Context.Service<
  FcmDeliveryQueue,
  {
    readonly enqueuePushNotification: (input: {
      readonly userId: string;
      readonly deviceId: string;
      readonly token: string;
      readonly notification: FcmDeliveryJobPayload["notification"];
      readonly channelId: string;
    }) => Effect.Effect<RelayDeliveryResult, FcmDeliveryQueueError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveryQueue") {}

export const make = Effect.gen(function* () {
  const sender = yield* FcmDeliveryQueueSender;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration.RelayConfiguration;

  return FcmDeliveryQueue.of({
    enqueuePushNotification: Effect.fn("relay.fcm_delivery_queue.enqueue_push_notification")(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "relay.mobile.device_id": input.deviceId,
          "relay.delivery.kind": "push_notification",
          "relay.environment_id": input.notification.environmentId,
          "relay.thread_id": input.notification.threadId,
        });
        const now = yield* DateTime.now;
        const jobId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new FcmDeliveryQueueSendError({
                operation: "generate-job-id",
                jobId: null,
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": jobId });
        const payload = makeFcmDeliveryJobPayload({
          userId: input.userId,
          deviceId: input.deviceId,
          token: input.token,
          notification: sanitizeApnsNotificationPayload(input.notification),
          channelId: input.channelId,
          jobId,
          createdAt: DateTime.formatIso(now),
          expiresAt: expiresAtForFcmJob(now.epochMilliseconds),
        });
        const signed = signFcmDeliveryJob({
          secret: config.fcmDeliveryJobSigningSecret,
          payload,
        });
        yield* sender.send(signed).pipe(
          Effect.mapError(
            (cause) =>
              new FcmDeliveryQueueSendError({
                operation: "send",
                jobId,
                userId: input.userId,
                deviceId: input.deviceId,
                cause,
              }),
          ),
        );
        return {
          deviceId: input.deviceId,
          kind: "push_notification" as const,
          ok: true,
          queued: true,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      },
    ),
  });
});

export const layer = Layer.effect(FcmDeliveryQueue, make);

export const layerCloudflareQueues = (
  sender: Cloudflare.QueueSender,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        FcmDeliveryQueueSender,
        FcmDeliveryQueueSender.of({
          send: (body) =>
            sender
              .send(body)
              .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
        }),
      ),
    ),
  );
