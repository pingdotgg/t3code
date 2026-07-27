import * as AWS from "@/AWS";
import { Application } from "@/AWS/KinesisAnalyticsV2";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  codeKey,
  deleteCodeBucketIdempotent,
  provisionCodeBucket,
} from "./code-bucket.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic out-of-band code buckets (see code-bucket.ts) — the Flink
// code object must exist before the application resource, and an in-stack
// bucket orphans on a crashed run because its generated name is lost with
// the state.
const appCodeBucket = "alchemy-test-kav2-app-code";
const renameCodeBucket = "alchemy-test-kav2-rename-code";

class ApplicationStillExists extends Data.TaggedError(
  "ApplicationStillExists",
) {}

const assertApplicationDeleted = Effect.fn(function* (applicationName: string) {
  yield* analytics
    .describeApplication({ ApplicationName: applicationName })
    .pipe(
      Effect.flatMap(() => Effect.fail(new ApplicationStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) => e._tag === "ApplicationStillExists",
        schedule: Schedule.max([
          Schedule.fixed("3 seconds"),
          Schedule.recurs(40),
        ]),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
});

describe.skipIf(!!process.env.FAST)(
  "AWS.KinesisAnalyticsV2.Application",
  () => {
    test.provider(
      "create Flink application in READY, update configuration in place, destroy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Stage the code object BEFORE the application exists — the service
          // reads (and hashes) the object at create/update time.
          const codeBucketArn = yield* provisionCodeBucket(appCodeBucket);

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("FlinkApp", {
                runtimeEnvironment: "FLINK-1_20",
                code: { bucketArn: codeBucketArn, fileKey: codeKey },
                environmentProperties: [
                  {
                    propertyGroupId: "AppProperties",
                    propertyMap: { mode: "test" },
                  },
                ],
                tags: { Environment: "test" },
              });
              return { app };
            }),
          );

          expect(deployed.app.applicationName).toBeDefined();
          expect(deployed.app.applicationStatus).toEqual("READY");
          expect(deployed.app.applicationVersionId).toEqual(1);
          expect(deployed.app.applicationArn).toContain(":kinesisanalytics:");
          expect(deployed.app.runtimeEnvironment).toEqual("FLINK-1_20");
          expect(deployed.app.roleName).toBeDefined();
          expect(deployed.app.serviceExecutionRole).toContain(":role/");
          expect(deployed.app.codeBucketArn).toEqual(codeBucketArn);
          expect(deployed.app.codeFileKey).toEqual(codeKey);
          expect(deployed.app.vpcConfigurationId).toBeUndefined();

          // Out-of-band verification via distilled.
          const described = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          expect(described.ApplicationDetail.ApplicationStatus).toEqual(
            "READY",
          );
          expect(described.ApplicationDetail.RuntimeEnvironment).toEqual(
            "FLINK-1_20",
          );
          const observedGroups =
            described.ApplicationDetail.ApplicationConfigurationDescription
              ?.EnvironmentPropertyDescriptions?.PropertyGroupDescriptions;
          expect(observedGroups?.[0]?.PropertyGroupId).toEqual("AppProperties");
          expect(observedGroups?.[0]?.PropertyMap?.mode).toEqual("test");

          // Ownership + user tags.
          const tags = yield* analytics.listTagsForResource({
            ResourceARN: deployed.app.applicationArn,
          });
          const tagKeys = (tags.Tags ?? []).map((tag) => tag.Key);
          expect(tagKeys).toContain("alchemy::stack");
          expect(tagKeys).toContain("alchemy::stage");
          expect(tagKeys).toContain("alchemy::id");
          expect(tags.Tags).toContainEqual({
            Key: "Environment",
            Value: "test",
          });

          // Typed error probe: describing a nonexistent snapshot of a live
          // application surfaces the typed ResourceNotFoundException.
          const snapshotError = yield* analytics
            .describeApplicationSnapshot({
              ApplicationName: deployed.app.applicationName,
              SnapshotName: "does-not-exist",
            })
            .pipe(Effect.flip);
          expect(snapshotError._tag).toEqual("ResourceNotFoundException");

          // Update runtime properties + tags in place (UpdateApplication).
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("FlinkApp", {
                runtimeEnvironment: "FLINK-1_20",
                code: { bucketArn: codeBucketArn, fileKey: codeKey },
                environmentProperties: [
                  {
                    propertyGroupId: "AppProperties",
                    propertyMap: { mode: "production", region: "us-west-2" },
                  },
                ],
                flinkConfiguration: {
                  parallelismConfiguration: {
                    configurationType: "CUSTOM",
                    parallelism: 1,
                    parallelismPerKPU: 1,
                    autoScalingEnabled: false,
                  },
                },
                maintenanceWindowStartTime: "02:00",
                tags: { Environment: "production", Team: "platform" },
              });
              return { app };
            }),
          );

          // Same physical application — updated in place, not replaced.
          expect(updated.app.applicationName).toEqual(
            deployed.app.applicationName,
          );
          expect(updated.app.applicationVersionId).toBeGreaterThan(1);
          expect(updated.app.applicationStatus).toEqual("READY");
          // Maintenance window applied via UpdateApplicationMaintenanceConfiguration.
          expect(updated.app.maintenanceWindowStartTime).toEqual("02:00");
          expect(updated.app.maintenanceWindowEndTime).toBeDefined();

          const updatedDescribe = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          const updatedConfig =
            updatedDescribe.ApplicationDetail
              .ApplicationConfigurationDescription;
          expect(
            updatedConfig?.EnvironmentPropertyDescriptions
              ?.PropertyGroupDescriptions?.[0]?.PropertyMap?.mode,
          ).toEqual("production");
          expect(
            updatedConfig?.FlinkApplicationConfigurationDescription
              ?.ParallelismConfigurationDescription?.ConfigurationType,
          ).toEqual("CUSTOM");

          const updatedTags = yield* analytics.listTagsForResource({
            ResourceARN: deployed.app.applicationArn,
          });
          expect(updatedTags.Tags).toContainEqual({
            Key: "Environment",
            Value: "production",
          });
          expect(updatedTags.Tags).toContainEqual({
            Key: "Team",
            Value: "platform",
          });

          // A no-change redeploy must not bump the application version
          // (observed-vs-desired diffing skips the UpdateApplication call).
          const steady = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("FlinkApp", {
                runtimeEnvironment: "FLINK-1_20",
                code: { bucketArn: codeBucketArn, fileKey: codeKey },
                environmentProperties: [
                  {
                    propertyGroupId: "AppProperties",
                    propertyMap: { mode: "production", region: "us-west-2" },
                  },
                ],
                flinkConfiguration: {
                  parallelismConfiguration: {
                    configurationType: "CUSTOM",
                    parallelism: 1,
                    parallelismPerKPU: 1,
                    autoScalingEnabled: false,
                  },
                },
                maintenanceWindowStartTime: "02:00",
                tags: { Environment: "production", Team: "platform" },
              });
              return { app };
            }),
          );
          expect(steady.app.applicationVersionId).toEqual(
            updated.app.applicationVersionId,
          );

          yield* stack.destroy();

          yield* assertApplicationDeleted(deployed.app.applicationName);

          // The synthesized IAM role is cleaned up with the application.
          const roleResult = yield* iam
            .getRole({ RoleName: deployed.app.roleName! })
            .pipe(Effect.result);
          expect(Result.isFailure(roleResult)).toBe(true);
        }).pipe(Effect.ensuring(deleteCodeBucketIdempotent(appCodeBucket))),
      { timeout: 300_000 },
    );

    test.provider(
      "replaces the application when the name changes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const codeBucketArn = yield* provisionCodeBucket(renameCodeBucket);

          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("RenamedApp", {
                runtimeEnvironment: "FLINK-1_20",
                code: { bucketArn: codeBucketArn, fileKey: codeKey },
              });
              return { app };
            }),
          );

          const replaced = yield* stack.deploy(
            Effect.gen(function* () {
              const app = yield* Application("RenamedApp", {
                applicationName: "alchemy-test-kav2-renamed",
                runtimeEnvironment: "FLINK-1_20",
                code: { bucketArn: codeBucketArn, fileKey: codeKey },
              });
              return { app };
            }),
          );

          // Name change is a replacement — new physical application.
          expect(replaced.app.applicationName).toEqual(
            "alchemy-test-kav2-renamed",
          );
          expect(replaced.app.applicationName).not.toEqual(
            initial.app.applicationName,
          );

          // The replaced (old) application is deleted by the engine.
          yield* assertApplicationDeleted(initial.app.applicationName);

          yield* stack.destroy();

          yield* assertApplicationDeleted(replaced.app.applicationName);
        }).pipe(Effect.ensuring(deleteCodeBucketIdempotent(renameCodeBucket))),
      { timeout: 300_000 },
    );
  },
);
