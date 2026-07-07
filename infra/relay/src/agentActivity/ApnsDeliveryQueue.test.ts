import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { testRelayConfiguration } from "../testRelayConfiguration.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";

const config = testRelayConfiguration();

describe("ApnsDeliveryQueue", () => {
  it.effect("preserves job identity and the queue sender cause", () => {
    const cause = new Error("queue unavailable");
    const senderCause = new Cloudflare.QueueSendError({
      message: cause.message,
      cause,
    });
    const layer = ApnsDeliveryQueue.layer.pipe(
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
      Layer.provide(
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: () => Effect.fail(senderCause),
        }),
      ),
    );

    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      const error = yield* Effect.flip(
        queue.enqueuePushNotification({
          userId: "user-1",
          deviceId: "device-1",
          token: "push-token",
          notification: {
            title: "Thread",
            body: "Input: Project",
            environmentId: "env-1",
            threadId: "thread-1",
            deepLink: "/threads/env-1/thread-1",
          },
        }),
      );

      expect(error).toMatchObject({
        _tag: "ApnsDeliveryQueueSendError",
        operation: "send",
        jobId: expect.any(String),
        kind: "push_notification",
        userId: "user-1",
        deviceId: "device-1",
        cause: senderCause,
      });
      expect(senderCause.cause).toBe(cause);
      expect(error.message).toBe(
        "Failed to enqueue APNs push notification delivery during send for device device-1.",
      );
    }).pipe(Effect.provide(layer));
  });
});
