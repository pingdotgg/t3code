import * as AWS from "@/AWS";
import { Dataset, DatasetGroup } from "@/AWS/Forecast";
import { toTagRecord } from "@/AWS/Forecast/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as forecast from "@distilled.cloud/aws/forecast";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class DatasetGroupStillExists extends Data.TaggedError(
  "DatasetGroupStillExists",
)<{ readonly arn: string }> {}

const assertDatasetGroupDeleted = (arn: string) =>
  forecast.describeDatasetGroup({ DatasetGroupArn: arn }).pipe(
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

// Typed-error probe: proves the SDK decodes Forecast errors as typed tags.
// A missing dataset surfaces as ResourceNotFoundException. Training resources
// (predictors, forecasts) take ~an hour of paid training — they are
// intentionally NOT implemented; only the cheap definition resources below
// have a live lifecycle.
test.provider(
  "describeDataset on a nonexistent ARN fails with a typed error",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const error = yield* Effect.flip(
        forecast.describeDataset({
          DatasetArn: `arn:aws:forecast:${region}:000000000000:dataset/does_not_exist`,
        }),
      );
      expect(
        ["ResourceNotFoundException", "AccessDeniedException"].includes(
          error._tag,
        ),
      ).toBe(true);
    }),
);

// Entitlement probe: Amazon Forecast is closed to new customers — accounts
// without prior Forecast usage get a typed AccessDeniedException on every
// create ("Amazon Forecast is no longer available to new customers. Existing
// customers of Amazon Forecast can continue to use the service as normal.").
// In an entitled (grandfathered) account the create succeeds, so this probe
// accepts either outcome and cleans up after itself.
test.provider(
  "createDatasetGroup is either entitled or a typed AccessDeniedException",
  () =>
    Effect.gen(function* () {
      const arn = yield* forecast
        .createDatasetGroup({
          DatasetGroupName: "alchemy_forecast_entitlement_probe",
          Domain: "CUSTOM",
        })
        .pipe(
          Effect.map((r) => r.DatasetGroupArn),
          Effect.catchTag(
            // A leftover probe group from a crashed prior run is also fine.
            ["AccessDeniedException", "ResourceAlreadyExistsException"],
            () => Effect.succeed(undefined),
          ),
        );
      if (arn !== undefined) {
        // Entitled account — clean up the probe group.
        yield* forecast
          .deleteDatasetGroup({ DatasetGroupArn: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
      }
    }),
);

// Forecast datasets and dataset groups are cheap, fast metadata objects, but
// the standing test account is blocked by the new-customer closure above —
// createDatasetGroup fails with AccessDeniedException ("Amazon Forecast is no
// longer available to new customers"). The lifecycle is implemented fully and
// gated behind AWS_TEST_FORECAST=1 so a grandfathered account can run it
// unchanged. The expensive training work (predictors, forecasts, import jobs)
// is out of scope.
test.provider.skipIf(!process.env.AWS_TEST_FORECAST)(
  "create, attach, and destroy a dataset and dataset group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Dataset("Demand", {
            domain: "CUSTOM",
            datasetType: "TARGET_TIME_SERIES",
            dataFrequency: "D",
            schema: {
              attributes: [
                { attributeName: "item_id", attributeType: "string" },
                { attributeName: "timestamp", attributeType: "timestamp" },
                { attributeName: "target_value", attributeType: "float" },
              ],
            },
            tags: { Environment: "test" },
          });
          const group = yield* DatasetGroup("Sales", {
            domain: "CUSTOM",
            datasetArns: [dataset.datasetArn],
            tags: { Environment: "test" },
          });
          return { dataset, group };
        }),
      );

      expect(created.dataset.datasetArn).toContain(":dataset/");
      expect(created.dataset.datasetType).toBe("TARGET_TIME_SERIES");
      expect(created.group.datasetGroupArn).toContain(":dataset-group/");
      expect(created.group.domain).toBe("CUSTOM");

      // Out-of-band verification via distilled.
      const describedDataset = yield* forecast.describeDataset({
        DatasetArn: created.dataset.datasetArn,
      });
      expect(describedDataset.Domain).toBe("CUSTOM");
      expect(describedDataset.DataFrequency).toBe("D");

      const describedGroup = yield* forecast.describeDatasetGroup({
        DatasetGroupArn: created.group.datasetGroupArn,
      });
      expect(describedGroup.DatasetArns).toContain(created.dataset.datasetArn);

      const groupTags = yield* forecast.listTagsForResource({
        ResourceArn: created.group.datasetGroupArn,
      });
      expect(toTagRecord(groupTags.Tags)["alchemy::id"]).toBe("Sales");

      // Update: detach the dataset and change tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Dataset("Demand", {
            domain: "CUSTOM",
            datasetType: "TARGET_TIME_SERIES",
            dataFrequency: "D",
            schema: {
              attributes: [
                { attributeName: "item_id", attributeType: "string" },
                { attributeName: "timestamp", attributeType: "timestamp" },
                { attributeName: "target_value", attributeType: "float" },
              ],
            },
            tags: { Environment: "test" },
          });
          const group = yield* DatasetGroup("Sales", {
            domain: "CUSTOM",
            datasetArns: [],
            tags: { Environment: "test", Extra: "yes" },
          });
          return { dataset, group };
        }),
      );
      expect(updated.group.datasetGroupArn).toBe(created.group.datasetGroupArn);

      const reDescribedGroup = yield* forecast.describeDatasetGroup({
        DatasetGroupArn: created.group.datasetGroupArn,
      });
      expect(reDescribedGroup.DatasetArns ?? []).not.toContain(
        created.dataset.datasetArn,
      );
      const updatedTags = yield* forecast.listTagsForResource({
        ResourceArn: created.group.datasetGroupArn,
      });
      expect(toTagRecord(updatedTags.Tags).Extra).toBe("yes");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertDatasetGroupDeleted(created.group.datasetGroupArn);
      const datasetError = yield* Effect.flip(
        forecast.describeDataset({ DatasetArn: created.dataset.datasetArn }),
      );
      expect(datasetError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 300_000 },
);
