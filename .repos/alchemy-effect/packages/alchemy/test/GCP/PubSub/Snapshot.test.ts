import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  pubsub.getProjectsSnapshots({ snapshot: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const getSnapshot = (name: string) =>
  pubsub.getProjectsSnapshots({ snapshot: name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

test.provider(
  "create, update, replace, and delete a snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            topic: topic.name,
            labels: { env: "test" },
          });
          const archive = yield* GCP.PubSub.Subscription("Archive", {
            topic: topic.name,
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.PubSub.Snapshot("Checkpoint", {
            subscription: subscription.name,
            labels: { env: "test" },
          });
          return { topic, subscription, archive, snapshot };
        }),
      );

      expect(created.snapshot.name).toContain("/snapshots/");
      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.topic).toEqual(created.topic.name);
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.expireTime).toEqual(expect.any(String));

      const fetched = yield* getSnapshot(created.snapshot.name);
      expect(fetched.name).toEqual(created.snapshot.name);
      expect(fetched.topic).toEqual(created.topic.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            subscriptionId: created.subscription.subscriptionId,
            topic: topic.name,
            labels: { env: "test" },
          });
          const archive = yield* GCP.PubSub.Subscription("Archive", {
            subscriptionId: created.archive.subscriptionId,
            topic: topic.name,
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.PubSub.Snapshot("Checkpoint", {
            snapshotId: created.snapshot.snapshotId,
            subscription: subscription.name,
            labels: { env: "prod", role: "backup" },
          });
          return { topic, subscription, archive, snapshot };
        }),
      );

      expect(updated.snapshot.name).toEqual(created.snapshot.name);
      expect(updated.snapshot.topic).toEqual(created.topic.name);
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const fetchedUpdated = yield* getSnapshot(updated.snapshot.name);
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("backup");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          // Keep both subscriptions deployed across the replace so the
          // engine does not deadlock on a replace+remove of a dependency.
          const orders = yield* GCP.PubSub.Subscription("Orders", {
            subscriptionId: created.subscription.subscriptionId,
            topic: topic.name,
            labels: { env: "test" },
          });
          const archive = yield* GCP.PubSub.Subscription("Archive", {
            subscriptionId: created.archive.subscriptionId,
            topic: topic.name,
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.PubSub.Snapshot("Checkpoint", {
            snapshotId: created.snapshot.snapshotId,
            subscription: archive.name,
            labels: { env: "prod", role: "backup" },
          });
          return { topic, orders, archive, snapshot };
        }),
      );

      expect(replaced.snapshot.name).toEqual(created.snapshot.name);
      expect(replaced.snapshot.snapshotId).toEqual(created.snapshot.snapshotId);
      expect(replaced.snapshot.topic).toEqual(created.topic.name);
      expect(replaced.snapshot.expireTime).not.toEqual(
        updated.snapshot.expireTime,
      );

      const fetchedReplaced = yield* getSnapshot(replaced.snapshot.name);
      expect(fetchedReplaced.name).toEqual(replaced.snapshot.name);
      expect(fetchedReplaced.topic).toEqual(created.topic.name);
      expect(fetchedReplaced.expireTime).toEqual(replaced.snapshot.expireTime);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.snapshot.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 90_000 },
);
