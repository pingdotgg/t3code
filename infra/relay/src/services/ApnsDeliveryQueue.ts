import type { RelayDeliveryResult } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  sanitizeAgentActivityAggregateState,
  sanitizeApnsNotificationPayload,
} from "../agentActivityPayloads.ts";
import {
  expiresAtForJob,
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  type ApnsDeliveryJobPayload,
  type SignedApnsDeliveryJob,
} from "../apnsDeliveryJobs.ts";
import * as Settings from "../settings.ts";

export class ApnsDeliveryQueueSendError extends Data.TaggedError("ApnsDeliveryQueueSendError")<{
  readonly cause: unknown;
}> {}

export type ApnsDeliveryQueueError = ApnsDeliveryQueueSendError;

export interface ApnsDeliveryQueueSenderShape {
  readonly send: (body: SignedApnsDeliveryJob) => Effect.Effect<void, ApnsDeliveryQueueSendError>;
}

export class ApnsDeliveryQueueSender extends Context.Service<
  ApnsDeliveryQueueSender,
  ApnsDeliveryQueueSenderShape
>()("ApnsDeliveryQueueSender") {}

export interface ApnsDeliveryQueueShape {
  readonly enqueueLiveActivity: (input: {
    readonly kind: ApnsDeliveryJobPayload["kind"];
    readonly userId: string;
    readonly deviceId: string;
    readonly token: string;
    readonly aggregate: ApnsDeliveryJobPayload["aggregate"];
  }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryQueueError>;
  readonly enqueuePushNotification: (input: {
    readonly userId: string;
    readonly deviceId: string;
    readonly token: string;
    readonly notification: NonNullable<ApnsDeliveryJobPayload["notification"]>;
  }) => Effect.Effect<RelayDeliveryResult, ApnsDeliveryQueueError>;
}

export class ApnsDeliveryQueue extends Context.Service<ApnsDeliveryQueue, ApnsDeliveryQueueShape>()(
  "ApnsDeliveryQueue",
) {}

const make = Effect.gen(function* () {
  const sender = yield* ApnsDeliveryQueueSender;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* Settings.Settings;

  return ApnsDeliveryQueue.of({
    enqueueLiveActivity: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const jobId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new ApnsDeliveryQueueSendError({ cause })),
        );
        const payload = makeApnsDeliveryJobPayload({
          ...input,
          aggregate:
            input.aggregate === null ? null : sanitizeAgentActivityAggregateState(input.aggregate),
          jobId,
          createdAt: DateTime.formatIso(now),
          expiresAt: expiresAtForJob(now.epochMilliseconds),
        });
        const signed = signApnsDeliveryJob({
          secret: settings.apnsDeliveryJobSigningSecret,
          payload,
        });
        yield* sender.send(signed);
        return {
          deviceId: input.deviceId,
          kind: input.kind,
          ok: true,
          queued: true,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      }),
    enqueuePushNotification: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const jobId = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new ApnsDeliveryQueueSendError({ cause })),
        );
        const payload = makeApnsDeliveryJobPayload({
          kind: "push_notification",
          userId: input.userId,
          deviceId: input.deviceId,
          token: input.token,
          aggregate: null,
          notification: sanitizeApnsNotificationPayload(input.notification),
          jobId,
          createdAt: DateTime.formatIso(now),
          expiresAt: expiresAtForJob(now.epochMilliseconds),
        });
        const signed = signApnsDeliveryJob({
          secret: settings.apnsDeliveryJobSigningSecret,
          payload,
        });
        yield* sender.send(signed);
        return {
          deviceId: input.deviceId,
          kind: "push_notification",
          ok: true,
          queued: true,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      }),
  });
});

export const layer = Layer.effect(ApnsDeliveryQueue, make);
