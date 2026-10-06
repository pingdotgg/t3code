import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withDataplexSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  dataplex.getProjectsLocationsMetadataFeeds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a metadata feed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("CatalogFeed", {
            labels: { env: "test" },
          });
          const feed = yield* GCP.Dataplex.MetadataFeed("Catalog", {
            location: "us-central1",
            pubsubTopic: topic.name,
            labels: { env: "test" },
          });
          return { topic, feed };
        }),
      );

      expect(created.feed.name).toContain("/metadataFeeds/");
      expect(created.feed.metadataFeedId).toEqual(expect.any(String));
      expect(created.feed.pubsubTopic).toEqual(created.topic.name);
      expect(created.feed.labels).toMatchObject({ env: "test" });

      const fetched = yield* dataplex.getProjectsLocationsMetadataFeeds({
        name: created.feed.name,
      });
      expect(fetched.name).toEqual(created.feed.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("CatalogFeed", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const feed = yield* GCP.Dataplex.MetadataFeed("Catalog", {
            metadataFeedId: created.feed.metadataFeedId,
            location: "us-central1",
            pubsubTopic: topic.name,
            filters: { changeTypes: ["CREATE"] },
            labels: { env: "prod", team: "data" },
          });
          return { topic, feed };
        }),
      );

      expect(updated.feed.name).toEqual(created.feed.name);
      expect(updated.feed.labels).toMatchObject({ env: "prod", team: "data" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.feed.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withDataplexSlot),
  { tags: ["provider:gcp", "provider:gcp:dataplex", "live"], timeout: 900_000 },
);
