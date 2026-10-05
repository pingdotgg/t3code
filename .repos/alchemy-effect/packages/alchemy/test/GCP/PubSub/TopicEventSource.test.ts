import * as GCP from "@/GCP";
import { makeObjectMedia } from "@/GCP/Storage/ObjectMedia.ts";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import {
  Markers,
  markerFor,
  PullConsumer,
  PullOrders,
  PushConsumer,
  PushOrders,
} from "./fixtures/consumers.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

// Pub/Sub reads are eventually consistent; ride out a lagging replica.
const readSubscription = (subscription: string) =>
  pubsub.getProjectsSubscriptions({ subscription }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

const subscriptionStatus = (subscription: string) =>
  pubsub.getProjectsSubscriptions({ subscription }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const publishAndAwaitMarker = (topic: string, bucket: string, data: string) =>
  Effect.gen(function* () {
    const { messageIds = [] } = yield* pubsub.publishProjectsTopics({
      topic,
      body: { messages: [{ data: btoa(data), attributes: { kind: "test" } }] },
    });
    expect(messageIds.length).toEqual(1);
    const media = yield* makeObjectMedia;
    const marker = yield* media
      .download({ bucket, object: markerFor(messageIds[0]!) })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "GCP.Storage.ObjectNotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 36,
        }),
      );
    return JSON.parse(new TextDecoder().decode(marker.body)) as {
      data: string;
      attributes: Record<string, string>;
      subscription: string;
    };
  });

test.provider.skipIf(!dockerAvailable)(
  "topic messages are pushed to an effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* PushConsumer;
          const topic = yield* PushOrders;
          const bucket = yield* Markers;
          return {
            uri: service.uri,
            topic: topic.name,
            bucket: bucket.bucketName,
          };
        }),
      );

      const { subscriptions = [] } =
        yield* pubsub.listProjectsTopicsSubscriptions({ topic: out.topic });
      expect(subscriptions.length).toEqual(1);
      const subscription = yield* readSubscription(subscriptions[0]!);
      const pushEndpoint = `${out.uri}/__alchemy/pubsub/pushorders`;
      expect(subscription.pushConfig?.pushEndpoint).toEqual(pushEndpoint);
      expect(subscription.pushConfig?.oidcToken?.audience).toEqual(
        pushEndpoint,
      );

      const event = yield* publishAndAwaitMarker(out.topic, out.bucket, "push");
      expect(event).toEqual({
        data: "push",
        attributes: { kind: "test" },
        subscription: subscriptions[0]!,
      });

      yield* stack.destroy();

      expect(yield* subscriptionStatus(subscriptions[0]!)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 600_000 },
);

test.provider.skipIf(!dockerAvailable)(
  "topic messages are pulled by an effect-native WorkerPool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* PullConsumer;
          const topic = yield* PullOrders;
          const bucket = yield* Markers;
          return { topic: topic.name, bucket: bucket.bucketName };
        }),
      );

      const { subscriptions = [] } =
        yield* pubsub.listProjectsTopicsSubscriptions({ topic: out.topic });
      expect(subscriptions.length).toEqual(1);
      const subscription = yield* readSubscription(subscriptions[0]!);
      expect(subscription.pushConfig?.pushEndpoint).toBeUndefined();

      const event = yield* publishAndAwaitMarker(out.topic, out.bucket, "pull");
      expect(event).toEqual({
        data: "pull",
        attributes: { kind: "test" },
        subscription: subscriptions[0]!,
      });

      yield* stack.destroy();

      expect(yield* subscriptionStatus(subscriptions[0]!)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 600_000 },
);
