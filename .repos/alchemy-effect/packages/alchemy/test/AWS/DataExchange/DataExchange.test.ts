import * as AWS from "@/AWS";
import { DataSet, EventAction, Revision } from "@/AWS/DataExchange";
import { toTagRecord } from "@/AWS/DataExchange/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Typed-error probe: proves the SDK decodes DataExchange errors as typed
// tags. A missing data set surfaces as ResourceNotFoundException.
test.provider("getDataSet on a nonexistent id fails with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      dataexchange.getDataSet({
        DataSetId: "ffffffffffffffffffffffffffffffff",
      }),
    );
    expect(error._tag).toBe("ResourceNotFoundException");
  }),
);

// Data sets and revisions are cheap, instant metadata objects — the live
// lifecycle runs ungated with out-of-band verification. Asset import jobs
// (the paid/slow part) are out of scope for the definition lifecycle.
test.provider(
  "create, update, destroy a data set with a revision",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataSet = yield* DataSet("Prices", {
            description: "Daily commodity price snapshots",
            tags: { Environment: "test" },
          });
          const revision = yield* Revision("PricesV1", {
            dataSetId: dataSet.dataSetId,
            comment: "Initial snapshot",
            tags: { Environment: "test" },
          });
          return { dataSet, revision };
        }),
      );

      expect(created.dataSet.dataSetArn).toContain(":data-sets/");
      expect(created.dataSet.assetType).toBe("S3_SNAPSHOT");
      expect(created.dataSet.origin).toBe("OWNED");
      expect(created.revision.revisionArn).toContain("/revisions/");
      expect(created.revision.dataSetId).toBe(created.dataSet.dataSetId);
      expect(created.revision.finalized).toBe(false);

      // Out-of-band verification via distilled.
      const observed = yield* dataexchange.getDataSet({
        DataSetId: created.dataSet.dataSetId,
      });
      expect(observed.Name).toBe(created.dataSet.name);
      expect(observed.Description).toBe("Daily commodity price snapshots");
      const dataSetTags = yield* dataexchange.listTagsForResource({
        ResourceArn: created.dataSet.dataSetArn,
      });
      expect(toTagRecord(dataSetTags.Tags)["alchemy::id"]).toBe("Prices");
      expect(toTagRecord(dataSetTags.Tags).Environment).toBe("test");

      const observedRevision = yield* dataexchange.getRevision({
        DataSetId: created.dataSet.dataSetId,
        RevisionId: created.revision.revisionId,
      });
      expect(observedRevision.Comment).toBe("Initial snapshot");
      const revisionTags = yield* dataexchange.listTagsForResource({
        ResourceArn: created.revision.revisionArn,
      });
      expect(toTagRecord(revisionTags.Tags)["alchemy::id"]).toBe("PricesV1");

      // Update in place: description, revision comment, and tags.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataSet = yield* DataSet("Prices", {
            description: "Hourly commodity price snapshots",
            tags: { Environment: "test", Extra: "yes" },
          });
          const revision = yield* Revision("PricesV1", {
            dataSetId: dataSet.dataSetId,
            comment: "Amended snapshot",
          });
          return { dataSet, revision };
        }),
      );

      // Stable identifiers are preserved across the update.
      expect(updated.dataSet.dataSetId).toBe(created.dataSet.dataSetId);
      expect(updated.revision.revisionId).toBe(created.revision.revisionId);

      const reobserved = yield* dataexchange.getDataSet({
        DataSetId: created.dataSet.dataSetId,
      });
      expect(reobserved.Description).toBe("Hourly commodity price snapshots");
      const updatedTags = yield* dataexchange.listTagsForResource({
        ResourceArn: created.dataSet.dataSetArn,
      });
      expect(toTagRecord(updatedTags.Tags).Extra).toBe("yes");

      const reobservedRevision = yield* dataexchange.getRevision({
        DataSetId: created.dataSet.dataSetId,
        RevisionId: created.revision.revisionId,
      });
      expect(reobservedRevision.Comment).toBe("Amended snapshot");
      // User tag was removed from the revision; internal tags survive.
      const updatedRevisionTags = yield* dataexchange.listTagsForResource({
        ResourceArn: created.revision.revisionArn,
      });
      expect(toTagRecord(updatedRevisionTags.Tags).Environment).toBeUndefined();
      expect(toTagRecord(updatedRevisionTags.Tags)["alchemy::id"]).toBe(
        "PricesV1",
      );

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      const dataSetError = yield* Effect.flip(
        dataexchange.getDataSet({ DataSetId: created.dataSet.dataSetId }),
      );
      expect(dataSetError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);

// Replacement: assetType is immutable, so changing it replaces the data set.
test.provider(
  "changing assetType replaces the data set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataSet("Replaceable", {
            assetType: "S3_SNAPSHOT",
            description: "before replacement",
          });
        }),
      );
      expect(created.assetType).toBe("S3_SNAPSHOT");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataSet("Replaceable", {
            assetType: "API_GATEWAY_API",
            description: "after replacement",
          });
        }),
      );
      expect(replaced.assetType).toBe("API_GATEWAY_API");
      expect(replaced.dataSetId).not.toBe(created.dataSetId);

      // The old data set is gone.
      const oldError = yield* Effect.flip(
        dataexchange.getDataSet({ DataSetId: created.dataSetId }),
      );
      expect(oldError._tag).toBe("ResourceNotFoundException");

      yield* stack.destroy();
      const newError = yield* Effect.flip(
        dataexchange.getDataSet({ DataSetId: replaced.dataSetId }),
      );
      expect(newError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);

// Event actions only attach to ENTITLED data sets (subscriptions / accepted
// data grants), which cannot be provisioned self-contained. This ungated
// probe proves the rejection against an OWNED data set is a typed tag.
test.provider(
  "createEventAction against an owned data set fails with a typed error",
  () =>
    Effect.gen(function* () {
      const dataSet = yield* dataexchange.createDataSet({
        AssetType: "S3_SNAPSHOT",
        Name: "alchemy-test-dataexchange-eventaction-probe",
        Description: "event action entitlement probe",
      });
      const error = yield* Effect.flip(
        dataexchange.createEventAction({
          Action: {
            ExportRevisionToS3: {
              RevisionDestination: { Bucket: "alchemy-nonexistent-bucket" },
            },
          },
          Event: { RevisionPublished: { DataSetId: dataSet.Id! } },
        }),
      ).pipe(
        Effect.ensuring(
          // Cleanup tolerates ONLY the typed not-found; any other delete
          // failure must surface rather than silently orphan the data set.
          dataexchange.deleteDataSet({ DataSetId: dataSet.Id! }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.orDie,
          ),
        ),
      );
      expect(error._tag).toBe("ValidationException");
    }),
  { timeout: 60_000 },
);

// Full event-action lifecycle needs an entitled data set — run it from an
// account with an active subscription/data grant by setting
// AWS_TEST_DATAEXCHANGE_ENTITLED_DATASET_ID (and an export bucket whose
// policy admits dataexchange.amazonaws.com via
// AWS_TEST_DATAEXCHANGE_EXPORT_BUCKET).
test.provider.skipIf(!process.env.AWS_TEST_DATAEXCHANGE_ENTITLED_DATASET_ID)(
  "create, update, destroy an event action on an entitled data set",
  (stack) =>
    Effect.gen(function* () {
      const entitledDataSetId =
        process.env.AWS_TEST_DATAEXCHANGE_ENTITLED_DATASET_ID!;
      const exportBucket = process.env.AWS_TEST_DATAEXCHANGE_EXPORT_BUCKET!;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventAction("AutoExport", {
            dataSetId: entitledDataSetId,
            exportRevisionToS3: { bucket: exportBucket },
          });
        }),
      );
      expect(created.eventActionArn).toContain(":event-actions/");

      // Update the key pattern in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EventAction("AutoExport", {
            dataSetId: entitledDataSetId,
            exportRevisionToS3: {
              bucket: exportBucket,
              keyPattern: "exports/${Revision.CreatedAt}/${Asset.Name}",
            },
          });
        }),
      );
      expect(updated.eventActionId).toBe(created.eventActionId);

      const observed = yield* dataexchange.getEventAction({
        EventActionId: created.eventActionId,
      });
      expect(
        observed.Action?.ExportRevisionToS3?.RevisionDestination.KeyPattern,
      ).toBe("exports/${Revision.CreatedAt}/${Asset.Name}");

      yield* stack.destroy();
      const gone = yield* Effect.flip(
        dataexchange.getEventAction({
          EventActionId: created.eventActionId,
        }),
      );
      expect(gone._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);
