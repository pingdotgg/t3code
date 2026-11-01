import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import type { SignedApnsDeliveryJob } from "./apnsDeliveryJobs.ts";

const config: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.com",
  apns: {
    teamId: "team-1",
    keyId: "key-1",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.t3tools.test",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-job-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-private-key"),
  cloudMintPublicKey: "cloud-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

describe("ApnsDeliveryQueue", () => {
  it.effect("keeps alert jobs stable across renames and retries, independently per target", () => {
    const sent: SignedApnsDeliveryJob[] = [];
    const layer = ApnsDeliveryQueue.layer.pipe(
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
      Layer.provide(
        Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
          send: (job) =>
            Effect.sync(() => {
              sent.push(job);
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      const input = {
        userId: "user-1",
        deviceId: "device-1",
        token: "push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env-1",
          threadId: "thread-1",
          deepLink: "/threads/env-1/thread-1",
          phase: "waiting_for_input" as const,
          updatedAt: "2026-09-04T12:00:00.000Z",
        },
      };
      yield* queue.enqueuePushNotification(input);
      yield* queue.enqueuePushNotification({
        ...input,
        notification: { ...input.notification, title: "Renamed" },
      });
      yield* queue.enqueuePushNotification({ ...input, deviceId: "device-2" });
      yield* queue.enqueuePushNotification({
        ...input,
        notification: { ...input.notification, updatedAt: "2026-09-04T13:00:00.000Z" },
      });
      yield* queue.enqueuePushNotification({ ...input, token: "rotated-token" });
      expect(sent[4]!.payload.jobId).not.toBe(sent[0]!.payload.jobId);
      expect(sent[1]!.payload.jobId).toBe(sent[0]!.payload.jobId);
      expect(sent[2]!.payload.jobId).not.toBe(sent[0]!.payload.jobId);
      expect(sent[3]!.payload.jobId).not.toBe(sent[0]!.payload.jobId);
      expect(sent[1]!.payload.notification?.title).toBe("Renamed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not require the deployment RuntimeContext when building the Worker layer", () => {
    const sent: unknown[] = [];
    const sender: Cloudflare.Queues.WriteQueueClient = {
      raw: Effect.die("raw queue binding is not used"),
      send: (body) =>
        Effect.sync(() => {
          sent.push(body);
        }),
      sendBatch: () => Effect.die("batch queue binding is not used"),
    };
    const runtimeContext = {} as Alchemy.BaseRuntimeContext;
    const layer = ApnsDeliveryQueue.layerCloudflareQueues(sender, runtimeContext).pipe(
      Layer.provide(NodeCryptoLayer.layer),
      Layer.provide(RelayConfiguration.layer(config)),
    );

    return Effect.gen(function* () {
      const queue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
      yield* queue.enqueuePushNotification({
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
      });

      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
