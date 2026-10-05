import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudasset from "@distilled.cloud/gcp/cloudasset_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const projectNumber = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const resource = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  const parts = (resource.name ?? "").split("/");
  return parts[parts.length - 1] || project;
});

const waitUntilGone = (name: string) =>
  cloudasset.getFeeds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getFeeds on a missing feed fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const number = yield* projectNumber;
      const error = yield* Effect.flip(
        cloudasset.getFeeds({
          name: `projects/${number}/feeds/alchemy-missing-feed`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudasset", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an asset feed",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("AssetEvents", {
            labels: { env: "test" },
          });
          const feed = yield* GCP.CloudAsset.Feed("Buckets", {
            pubsubTopic: topic.name,
            assetTypes: ["storage.googleapis.com/Bucket"],
            contentType: "RESOURCE",
            condition: { description: "watch buckets" },
          });
          return { topic, feed };
        }),
      );

      expect(created.feed.name).toContain("/feeds/");
      expect(created.feed.feedId).toEqual(expect.any(String));
      expect(created.feed.pubsubTopic).toEqual(created.topic.name);
      expect(created.feed.assetTypes).toEqual(
        expect.arrayContaining(["storage.googleapis.com/Bucket"]),
      );
      expect(created.feed.contentType).toEqual("RESOURCE");
      expect(created.feed.condition?.description).toEqual("watch buckets");

      const fetched = yield* cloudasset.getFeeds({ name: created.feed.name });
      expect(fetched.name).toEqual(created.feed.name);
      expect(fetched.feedOutputConfig?.pubsubDestination?.topic).toEqual(
        created.topic.name,
      );
      expect(fetched.condition?.description).toContain("alchemy-id=");
      expect(fetched.condition?.description).toContain("watch buckets");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("AssetEvents", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const feed = yield* GCP.CloudAsset.Feed("Buckets", {
            feedId: created.feed.feedId,
            pubsubTopic: topic.name,
            assetTypes: [
              "storage.googleapis.com/Bucket",
              "pubsub.googleapis.com/Topic",
            ],
            contentType: "RESOURCE",
            condition: { description: "watch buckets and topics" },
          });
          return { topic, feed };
        }),
      );

      expect(updated.feed.name).toEqual(created.feed.name);
      expect(updated.feed.feedId).toEqual(created.feed.feedId);
      expect(updated.feed.assetTypes).toEqual(
        expect.arrayContaining([
          "storage.googleapis.com/Bucket",
          "pubsub.googleapis.com/Topic",
        ]),
      );
      expect(updated.feed.condition?.description).toEqual(
        "watch buckets and topics",
      );

      const refetched = yield* cloudasset.getFeeds({
        name: created.feed.name,
      });
      expect(refetched.assetTypes).toEqual(
        expect.arrayContaining(["pubsub.googleapis.com/Topic"]),
      );
      expect(refetched.condition?.description).toContain(
        "watch buckets and topics",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.feed.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudasset", "live"],
    timeout: 90_000,
  },
);
