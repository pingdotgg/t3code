import * as AWS from "@/AWS";
import { Dataset, DatasetGroup, EventTracker, Schema } from "@/AWS/Personalize";
import { toTagRecord } from "@/AWS/Personalize/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as personalize from "@distilled.cloud/aws/personalize";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const INTERACTIONS_SCHEMA = JSON.stringify({
  type: "record",
  name: "Interactions",
  namespace: "com.amazonaws.personalize.schema",
  fields: [
    { name: "USER_ID", type: "string" },
    { name: "ITEM_ID", type: "string" },
    { name: "TIMESTAMP", type: "long" },
  ],
  version: "1.0",
});

class DatasetGroupStillExists extends Data.TaggedError(
  "DatasetGroupStillExists",
)<{ readonly arn: string }> {}

const assertDatasetGroupDeleted = (arn: string) =>
  personalize.describeDatasetGroup({ datasetGroupArn: arn }).pipe(
    Effect.flatMap(() => Effect.fail(new DatasetGroupStillExists({ arn }))),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
    Effect.retry({
      while: (e) => e._tag === "DatasetGroupStillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

// Typed-error probe: proves the SDK decodes Personalize errors as typed tags.
// A missing dataset group surfaces as ResourceNotFoundException. Training
// resources (solutions, campaigns) take ~an hour of paid training — they are
// intentionally NOT implemented; only the cheap definition resources below
// have a live lifecycle.
test.provider(
  "describeDatasetGroup on a nonexistent ARN fails with a typed error",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const error = yield* Effect.flip(
        personalize.describeDatasetGroup({
          datasetGroupArn: `arn:aws:personalize:${region}:000000000000:dataset-group/does-not-exist`,
        }),
      );
      expect(
        ["ResourceNotFoundException", "AccessDeniedException"].includes(
          error._tag,
        ),
      ).toBe(true);
    }),
);

// Personalize schemas, dataset groups, datasets, and event trackers are
// cheap, fast metadata objects — the live lifecycle runs ungated with
// out-of-band verification. The expensive training work (solutions,
// campaigns, import jobs) runs at runtime through the MLOps bindings instead
// of IaC resources.
test.provider(
  "create and destroy a schema, dataset group, dataset, and event tracker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* Schema("Interactions", {
            schema: INTERACTIONS_SCHEMA,
          });
          const group = yield* DatasetGroup("Group", {
            tags: { Environment: "test" },
          });
          const dataset = yield* Dataset("Dataset", {
            schemaArn: schema.schemaArn,
            datasetGroupArn: group.datasetGroupArn,
            datasetType: "Interactions",
            tags: { Environment: "test" },
          });
          // Depend on the DATASET's group ARN (not the group's): Personalize
          // rejects creating an event tracker until the group has an
          // Interactions dataset, so the tracker must be sequenced after it.
          const tracker = yield* EventTracker("Tracker", {
            datasetGroupArn: dataset.datasetGroupArn,
            tags: { Environment: "test" },
          });
          return { schema, group, dataset, tracker };
        }),
      );

      expect(created.schema.schemaArn).toContain(":schema/");
      expect(created.group.datasetGroupArn).toContain(":dataset-group/");
      expect(created.group.status).toBe("ACTIVE");
      expect(created.dataset.datasetArn).toContain(":dataset/");
      expect(created.dataset.status).toBe("ACTIVE");
      // Personalize canonicalizes the dataset type to uppercase on describe.
      expect(created.dataset.datasetType).toBe("INTERACTIONS");

      // Out-of-band verification via distilled.
      const describedSchema = yield* personalize.describeSchema({
        schemaArn: created.schema.schemaArn,
      });
      expect(JSON.parse(describedSchema.schema!.schema!)).toEqual(
        JSON.parse(INTERACTIONS_SCHEMA),
      );

      const describedGroup = yield* personalize.describeDatasetGroup({
        datasetGroupArn: created.group.datasetGroupArn,
      });
      expect(describedGroup.datasetGroup?.status).toBe("ACTIVE");

      const groupTags = yield* personalize.listTagsForResource({
        resourceArn: created.group.datasetGroupArn,
      });
      expect(toTagRecord(groupTags.tags)["alchemy::id"]).toBe("Group");

      const describedDataset = yield* personalize.describeDataset({
        datasetArn: created.dataset.datasetArn,
      });
      expect(describedDataset.dataset?.datasetType).toBe("INTERACTIONS");
      expect(describedDataset.dataset?.schemaArn).toBe(
        created.schema.schemaArn,
      );

      expect(created.tracker.eventTrackerArn).toContain(":event-tracker/");
      expect(created.tracker.status).toBe("ACTIVE");
      expect(created.tracker.trackingId).toBeTruthy();
      const describedTracker = yield* personalize.describeEventTracker({
        eventTrackerArn: created.tracker.eventTrackerArn,
      });
      expect(describedTracker.eventTracker?.trackingId).toBe(
        created.tracker.trackingId,
      );
      expect(describedTracker.eventTracker?.datasetGroupArn).toBe(
        created.group.datasetGroupArn,
      );

      // Update: change the dataset group's tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* Schema("Interactions", {
            schema: INTERACTIONS_SCHEMA,
          });
          const group = yield* DatasetGroup("Group", {
            tags: { Environment: "test", Extra: "yes" },
          });
          const dataset = yield* Dataset("Dataset", {
            schemaArn: schema.schemaArn,
            datasetGroupArn: group.datasetGroupArn,
            datasetType: "Interactions",
            tags: { Environment: "test" },
          });
          const tracker = yield* EventTracker("Tracker", {
            datasetGroupArn: dataset.datasetGroupArn,
            tags: { Environment: "test", Extra: "yes" },
          });
          return { schema, group, dataset, tracker };
        }),
      );
      // Stable identifiers are preserved across the update.
      expect(updated.group.datasetGroupArn).toBe(created.group.datasetGroupArn);
      expect(updated.dataset.datasetArn).toBe(created.dataset.datasetArn);
      expect(updated.tracker.eventTrackerArn).toBe(
        created.tracker.eventTrackerArn,
      );
      expect(updated.tracker.trackingId).toBe(created.tracker.trackingId);

      const updatedTags = yield* personalize.listTagsForResource({
        resourceArn: created.group.datasetGroupArn,
      });
      expect(toTagRecord(updatedTags.tags).Extra).toBe("yes");
      const updatedTrackerTags = yield* personalize.listTagsForResource({
        resourceArn: created.tracker.eventTrackerArn,
      });
      expect(toTagRecord(updatedTrackerTags.tags).Extra).toBe("yes");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertDatasetGroupDeleted(created.group.datasetGroupArn);
      const datasetError = yield* Effect.flip(
        personalize.describeDataset({
          datasetArn: created.dataset.datasetArn,
        }),
      );
      expect(datasetError._tag).toBe("ResourceNotFoundException");
      const trackerError = yield* Effect.flip(
        personalize.describeEventTracker({
          eventTrackerArn: created.tracker.eventTrackerArn,
        }),
      );
      expect(trackerError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 480_000 },
);
