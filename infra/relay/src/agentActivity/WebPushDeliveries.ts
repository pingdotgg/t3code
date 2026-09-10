import type { RelayDeliveryResult } from "@t3tools/contracts/relay";
import webpush from "web-push";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import { SignedWebPushDeliveryJob, verifyWebPushDeliveryJob } from "./webPushDeliveryJobs.ts";

export type WebPushPayload = {
  readonly eventId: string;
  readonly deepLink: string;
  readonly showProjectAndThreadNames: boolean;
  readonly title: string;
  readonly body: string;
};

const WebPushPayloadJson = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: Schema.String,
      deepLink: Schema.String,
      showProjectAndThreadNames: Schema.Boolean,
      title: Schema.String,
      body: Schema.String,
    }),
  ),
);

function responseStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || !("statusCode" in cause)) return null;
  const statusCode = cause.statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

export class WebPushDeliveryTransportError extends Schema.TaggedError<WebPushDeliveryTransportError>()(
  "WebPushDeliveryTransportError",
  { cause: Schema.Defect() },
) {}

export class WebPushDeliveries extends Context.Service<
  WebPushDeliveries,
  {
    readonly send: (input: {
      readonly subscription: WebPushSubscriptions.WebPushNotification["subscription"];
      readonly payload: WebPushPayload;
    }) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryTransportError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryTransportError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveries") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  if (!config.webPush) {
    return yield* Effect.die("Web Push VAPID credentials are not configured.");
  }
  const vapidDetails = {
    subject: config.webPush.subject,
    publicKey: config.webPush.publicKey,
    privateKey: Redacted.value(config.webPush.privateKey),
  };

  const send = Effect.fn("relay.web_push_deliveries.send")(function* (input: {
    readonly subscription: WebPushSubscriptions.WebPushNotification["subscription"];
    readonly payload: WebPushPayload;
  }) {
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          webpush.sendNotification(
            {
              endpoint: input.subscription.endpoint,
              keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth },
            },
            WebPushPayloadJson(input.payload),
            { TTL: 60, vapidDetails },
          ),
        catch: (cause) => new WebPushDeliveryTransportError({ cause }),
      }),
    );
    if (Result.isSuccess(result)) {
      return {
        deviceId: input.subscription.id,
        kind: "web_push_notification" as const,
        ok: true,
        queued: false,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
        webPushStatus: result.success.statusCode,
        webPushReason: null,
      };
    }
    const status = responseStatus(result.failure.cause);
    if (status === 404 || status === 410) {
      yield* subscriptions
        .remove({
          userId: input.subscription.userId,
          subscriptionId: input.subscription.id,
        })
        .pipe(Effect.catch(() => Effect.die("Could not remove expired Web Push subscription.")));
      return {
        deviceId: input.subscription.id,
        kind: "web_push_notification" as const,
        ok: false,
        queued: false,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
        webPushStatus: status,
        webPushReason: "subscription_gone",
      };
    }
    return yield* result.failure;
  });
  return WebPushDeliveries.of({
    send,
    processSignedJob: Effect.fn("relay.web_push_deliveries.process_signed_job")(function* (body) {
      const job = yield* Schema.decodeUnknownEffect(SignedWebPushDeliveryJob)(body).pipe(
        Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })),
      );
      const verified = verifyWebPushDeliveryJob({
        secret: config.webPushDeliveryJobSigningSecret ?? config.apnsDeliveryJobSigningSecret,
        job,
        nowMs: (yield* DateTime.now).epochMilliseconds,
      });
      if (verified === null) {
        return yield* Effect.die("Invalid or expired Web Push delivery job.");
      }
      const subscription = yield* subscriptions
        .get({ userId: verified.userId, subscriptionId: verified.subscriptionId })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      if (subscription === null) {
        return {
          deviceId: verified.subscriptionId,
          kind: "web_push_notification" as const,
          ok: false,
          queued: false,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
          webPushReason: "subscription_missing",
        };
      }
      const claim = yield* attempts
        .claimSourceJob({
          userId: verified.userId,
          environmentId: null,
          threadId: null,
          deviceId: verified.subscriptionId,
          kind: "web_push_notification",
          sourceJobId: verified.jobId,
          token: null,
        })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      if (claim === "completed") {
        return {
          deviceId: verified.subscriptionId,
          kind: "web_push_notification" as const,
          ok: true,
          queued: false,
          apnsStatus: null,
          apnsReason: "Duplicate Web Push job skipped.",
          apnsId: null,
        };
      }
      if (claim === "in_flight")
        return yield* Effect.die("Web Push delivery job is already in flight.");
      const result = yield* send({
        subscription,
        payload: verified,
      }).pipe(
        Effect.catch((error) =>
          attempts.releaseSourceJob
            ? attempts.releaseSourceJob({ sourceJobId: verified.jobId }).pipe(
                Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })),
                Effect.andThen(Effect.fail(error)),
              )
            : Effect.fail(error),
        ),
      );
      yield* attempts
        .completeSourceJob({
          sourceJobId: verified.jobId,
          ...(result.webPushStatus !== undefined ? { apnsStatus: result.webPushStatus } : {}),
          ...(result.webPushReason ? { apnsReason: result.webPushReason } : {}),
        })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      return result;
    }),
  });
});

export const layer = Layer.effect(WebPushDeliveries, make);
