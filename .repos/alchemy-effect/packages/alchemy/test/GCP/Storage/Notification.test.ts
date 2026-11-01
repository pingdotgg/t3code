import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (bucketName: string, notificationId: string) =>
  storage
    .getNotifications({
      bucket: bucketName,
      notification: notificationId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, replace, and delete a notification",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const topic = yield* GCP.PubSub.Topic("Events", {});
          return yield* GCP.Storage.Notification("ObjectEvents", {
            bucketName: bucket.bucketName,
            topic: topic.name,
            customAttributes: { env: "test" },
          });
        }),
      );

      expect(created.notificationId).toEqual(expect.any(String));
      expect(created.bucketName).toEqual(expect.any(String));
      expect(created.payloadFormat).toEqual("JSON_API_V1");
      expect(created.customAttributes).toMatchObject({ env: "test" });
      expect(created.topic).toContain(created.topicId);

      const fetched = yield* storage.getNotifications({
        bucket: created.bucketName,
        notification: created.notificationId,
      });
      expect(fetched.id).toEqual(created.notificationId);
      expect(fetched.payload_format).toEqual("JSON_API_V1");
      expect(fetched.custom_attributes?.env).toEqual("test");
      expect(fetched.custom_attributes).toEqual({ env: "test" });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Assets", {
            bucketName: created.bucketName,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topicId,
          });
          return yield* GCP.Storage.Notification("ObjectEvents", {
            bucketName: bucket.bucketName,
            topic: topic.name,
            eventTypes: ["OBJECT_FINALIZE"],
            objectNamePrefix: "uploads/",
            customAttributes: { env: "prod" },
          });
        }),
      );

      expect(updated.bucketName).toEqual(created.bucketName);
      expect(updated.eventTypes).toEqual(["OBJECT_FINALIZE"]);
      expect(updated.objectNamePrefix).toEqual("uploads/");
      expect(updated.customAttributes).toMatchObject({ env: "prod" });
      expect(updated.notificationId).not.toEqual(created.notificationId);

      const refetched = yield* storage.getNotifications({
        bucket: updated.bucketName,
        notification: updated.notificationId,
      });
      expect(refetched.event_types).toEqual(["OBJECT_FINALIZE"]);
      expect(refetched.object_name_prefix).toEqual("uploads/");
      expect(refetched.custom_attributes?.env).toEqual("prod");

      const previousGone = yield* waitUntilGone(
        created.bucketName,
        created.notificationId,
      );
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        updated.bucketName,
        updated.notificationId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 90_000 },
);
