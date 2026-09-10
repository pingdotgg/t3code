import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RelayDeliveryResult } from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import {
  expiresAtForWebPushJob,
  signWebPushDeliveryJob,
  type SignedWebPushDeliveryJob,
} from "./webPushDeliveryJobs.ts";

export class WebPushDeliveryQueueError extends Schema.TaggedError<WebPushDeliveryQueueError>()(
  "WebPushDeliveryQueueError",
  { cause: Schema.Defect() },
) {}

export class WebPushDeliveryQueueSender extends Context.Service<
  WebPushDeliveryQueueSender,
  {
    readonly send: (
      body: SignedWebPushDeliveryJob,
    ) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveryQueue/WebPushDeliveryQueueSender") {}

export class WebPushDeliveryQueue extends Context.Service<
  WebPushDeliveryQueue,
  {
    readonly enqueue: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
      readonly eventId: string;
      readonly deepLink: string;
      readonly showProjectAndThreadNames: boolean;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryQueueError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveryQueue") {}

export const make = Effect.gen(function* () {
  const sender = yield* WebPushDeliveryQueueSender;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration.RelayConfiguration;
  return WebPushDeliveryQueue.of({
    enqueue: Effect.fn("relay.web_push_delivery_queue.enqueue")(function* (input) {
      const now = yield* DateTime.now;
      const jobId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new WebPushDeliveryQueueError({ cause })),
      );
      const payload = {
        version: 1 as const,
        jobId,
        ...input,
        createdAt: DateTime.formatIso(now),
        expiresAt: expiresAtForWebPushJob(now.epochMilliseconds),
      };
      const signed = signWebPushDeliveryJob({
        secret: config.webPushDeliveryJobSigningSecret ?? config.apnsDeliveryJobSigningSecret,
        payload,
      });
      yield* sender
        .send(signed)
        .pipe(Effect.mapError((cause) => new WebPushDeliveryQueueError({ cause })));
      return {
        deviceId: input.subscriptionId,
        kind: "web_push_notification" as const,
        ok: true,
        queued: true,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
      };
    }),
  });
});

export const layer = Layer.effect(WebPushDeliveryQueue, make);

export const layerCloudflareQueues = (
  sender: Cloudflare.Queues.WriteQueueClient,
  runtime: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        WebPushDeliveryQueueSender,
        WebPushDeliveryQueueSender.of({
          send: (body) =>
            sender.send(body).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
        }),
      ),
    ),
  );
