import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  currentProject,
  runLifecycle,
  waitUntilGone,
  zone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getAdminProjectsLocationsTopics on a missing topic fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        pubsublite.getAdminProjectsLocationsTopics({
          name: `projects/${project}/locations/${zone}/topics/alchemy-missing-topic`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:pubsublite", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSubLite.AdminTopic("Events", {
            location: zone,
            partitionConfig: {
              count: 1,
              capacity: { publishMibPerSec: 4, subscribeMibPerSec: 4 },
            },
            retentionConfig: { perPartitionBytes: "32212254720" },
          });
        }),
      );

      expect(created.name).toContain("/topics/");
      expect(created.topicId).toContain("+alc.");
      expect(created.location).toEqual(zone);
      expect(created.partitionConfig?.count).toEqual("1");
      expect(created.partitionConfig?.capacity?.publishMibPerSec).toEqual(4);
      expect(created.partitionConfig?.capacity?.subscribeMibPerSec).toEqual(4);

      const fetched = yield* pubsublite.getAdminProjectsLocationsTopics({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.partitionConfig?.capacity?.publishMibPerSec).toEqual(4);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSubLite.AdminTopic("Events", {
            topicId: created.topicId,
            location: zone,
            partitionConfig: {
              count: 1,
              capacity: { publishMibPerSec: 4, subscribeMibPerSec: 8 },
            },
            retentionConfig: {
              perPartitionBytes: "32212254720",
              period: "86400s",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.partitionConfig?.capacity?.subscribeMibPerSec).toEqual(8);
      expect(updated.retentionConfig?.period).toEqual("86400s");

      const refetched = yield* pubsublite.getAdminProjectsLocationsTopics({
        name: created.name,
      });
      expect(refetched.partitionConfig?.capacity?.subscribeMibPerSec).toEqual(
        8,
      );
      expect(refetched.retentionConfig?.period).toEqual("86400s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        pubsublite.getAdminProjectsLocationsTopics({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:pubsublite", "live"],
    timeout: 90_000,
  },
);
