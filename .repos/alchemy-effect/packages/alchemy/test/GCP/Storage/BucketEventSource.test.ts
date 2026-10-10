import * as GCP from "@/GCP";
import { makeObjectMedia } from "@/GCP/Storage/ObjectMedia.ts";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import BucketEventsService, {
  INCOMING_PREFIX,
  markerFor,
  Uploads,
} from "./fixtures/bucket-events.ts";

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

test.provider.skipIf(!dockerAvailable)(
  "bucket finalize events are pushed to an effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* BucketEventsService;
          const bucket = yield* Uploads;
          return { uri: service.uri, bucket: bucket.bucketName };
        }),
      );
      const bucket = out.bucket;

      // The notification publishes only `incoming/` finalizes to a topic
      // with one push subscription to the service.
      const notifications = (yield* storage.listNotifications({ bucket }))
        .items;
      expect(notifications?.length).toEqual(1);
      const notification = notifications![0]!;
      expect(notification.event_types).toEqual(["OBJECT_FINALIZE"]);
      expect(notification.object_name_prefix).toEqual(INCOMING_PREFIX);
      expect(notification.payload_format).toEqual("JSON_API_V1");
      const topic = notification.topic!.replace("//pubsub.googleapis.com/", "");
      const { subscriptions = [] } =
        yield* pubsub.listProjectsTopicsSubscriptions({ topic });
      expect(subscriptions.length).toEqual(1);
      const subscription = yield* pubsub.getProjectsSubscriptions({
        subscription: subscriptions[0]!,
      });
      const pushEndpoint = `${out.uri}/__alchemy/pubsub/uploads-bucketevents`;
      expect(subscription.pushConfig?.pushEndpoint).toEqual(pushEndpoint);
      expect(subscription.pushConfig?.oidcToken?.audience).toEqual(
        pushEndpoint,
      );

      const media = yield* makeObjectMedia;
      // Outside the prefix: must not be delivered.
      yield* media.upload(bucket, { name: "other/skip.txt", body: "skip" });
      const uploaded = yield* media.upload(bucket, {
        name: `${INCOMING_PREFIX}hello.txt`,
        body: "Hello, events!",
      });

      const marker = yield* media
        .download({ bucket, object: markerFor(`${INCOMING_PREFIX}hello.txt`) })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "GCP.Storage.ObjectNotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 36,
          }),
        );
      const event = JSON.parse(new TextDecoder().decode(marker.body));
      expect(event).toMatchObject({
        eventType: "OBJECT_FINALIZE",
        bucket,
        object: `${INCOMING_PREFIX}hello.txt`,
        generation: uploaded.generation,
        size: "14",
      });
      expect(event.contentType).toContain("text/plain");
      expect(event.eventTime).toEqual(expect.any(String));

      const skipped = yield* media
        .download({ bucket, object: markerFor("other/skip.txt") })
        .pipe(
          Effect.as("delivered" as const),
          Effect.catchTag("GCP.Storage.ObjectNotFound", () =>
            Effect.succeed("filtered" as const),
          ),
        );
      expect(skipped).toEqual("filtered");

      yield* stack.destroy();

      const topicGone = yield* pubsub.getProjectsTopics({ topic }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(topicGone).toEqual("gone");
      const subscriptionGone = yield* pubsub
        .getProjectsSubscriptions({ subscription: subscriptions[0]! })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(subscriptionGone).toEqual("gone");
      // The bucket (and with it the notification) is gone.
      const notificationsGone = yield* storage
        .getNotifications({ bucket, notification: notification.id! })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(notificationsGone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 600_000 },
);
