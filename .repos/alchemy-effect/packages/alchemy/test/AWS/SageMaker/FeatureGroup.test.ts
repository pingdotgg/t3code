import * as AWS from "@/AWS";
import { FeatureGroup } from "@/AWS/SageMaker";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: FeatureGroup APIs return the model's own typed
// ResourceNotFound (no patch needed) — prove it stays that way.
test.provider(
  "describeFeatureGroup on a nonexistent group fails with ResourceNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        sagemaker.describeFeatureGroup({
          FeatureGroupName: "alchemy-nonexistent-feature-group-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFound");
    }),
);

const findFeatureGroup = (name: string) =>
  sagemaker
    .describeFeatureGroup({ FeatureGroupName: name })
    .pipe(Effect.catchTag("ResourceNotFound", () => Effect.succeed(undefined)));

test.provider(
  "create online-store feature group, verify out-of-band, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { featureGroup } = yield* stack.deploy(
        Effect.gen(function* () {
          const featureGroup = yield* FeatureGroup("TestFeatures", {
            recordIdentifierFeatureName: "user_id",
            eventTimeFeatureName: "event_time",
            featureDefinitions: [
              { FeatureName: "user_id", FeatureType: "String" },
              { FeatureName: "event_time", FeatureType: "String" },
              { FeatureName: "clicks", FeatureType: "Integral" },
            ],
            onlineStoreConfig: { EnableOnlineStore: true },
            tags: { purpose: "alchemy-test" },
          });
          return { featureGroup };
        }),
      );

      expect(featureGroup.featureGroupName).toBeDefined();
      expect(featureGroup.featureGroupArn).toContain(":feature-group/");
      expect(featureGroup.recordIdentifierFeatureName).toBe("user_id");
      expect(featureGroup.eventTimeFeatureName).toBe("event_time");

      // out-of-band verification via distilled — reconcile waits for Created
      const observed = yield* findFeatureGroup(featureGroup.featureGroupName);
      expect(observed?.FeatureGroupStatus).toBe("Created");
      expect(observed?.OnlineStoreConfig?.EnableOnlineStore).toBe(true);
      expect(observed?.FeatureDefinitions?.length).toBe(3);

      // internal ownership tags applied
      const tags = yield* sagemaker
        .listTags({ ResourceArn: featureGroup.featureGroupArn })
        .pipe(Effect.map((r) => r.Tags ?? []));
      const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
      expect(tagMap["alchemy::id"]).toBe("TestFeatures");
      expect(tagMap.purpose).toBe("alchemy-test");

      // delete waits until the group is fully gone
      yield* stack.destroy();
      expect(
        yield* findFeatureGroup(featureGroup.featureGroupName),
      ).toBeUndefined();
    }),
  { timeout: 240_000 },
);
