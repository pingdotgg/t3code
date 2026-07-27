import * as AWS from "@/AWS";
import { RecordingConfiguration } from "@/AWS/IVS";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as ivs from "@distilled.cloud/aws/ivs";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getRecordingConfiguration on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        ivs.getRecordingConfiguration({
          arn: `arn:aws:ivs:${region}:${Account}:recording-configuration/AbCdEfGh1234`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const assertConfigGone = (arn: string) =>
  Effect.gen(function* () {
    const config = yield* ivs.getRecordingConfiguration({ arn }).pipe(
      Effect.map((r) => r.recordingConfiguration),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (config !== undefined) {
      return yield* Effect.fail(new Error(`config '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Recording configurations are free while idle; creation is async
// (CREATING -> ACTIVE) but completes in seconds when the bucket is in the
// same region.
test.provider(
  "create and destroy an IVS recording configuration",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const app = Effect.gen(function* () {
        const bucket = yield* Bucket("RecordingArchive", {
          forceDestroy: true,
        });
        return yield* RecordingConfiguration("Recording", {
          recordingConfigurationName: "alchemy-test-ivs-recording",
          destinationConfiguration: {
            s3: { bucketName: bucket.bucketName },
          },
          recordingReconnectWindow: "2 minutes",
          thumbnailConfiguration: {
            recordingMode: "INTERVAL",
            targetInterval: "30 seconds",
          },
          tags: { fixture: "ivs-recording" },
        });
      });

      // Create — the provider waits until the configuration leaves
      // CREATING (ACTIVE proves the bucket wiring worked).
      const created = yield* stack.deploy(app);
      expect(created.recordingConfigurationArn).toContain(
        ":recording-configuration/",
      );
      expect(created.recordingConfigurationName).toBe(
        "alchemy-test-ivs-recording",
      );
      expect(created.state).toBe("ACTIVE");
      expect(created.bucketName).toBeDefined();

      // Out-of-band verification via distilled — the duration props landed
      // as wire seconds.
      const observed = yield* ivs.getRecordingConfiguration({
        arn: created.recordingConfigurationArn,
      });
      expect(
        observed.recordingConfiguration?.recordingReconnectWindowSeconds,
      ).toBe(120);
      expect(
        observed.recordingConfiguration?.thumbnailConfiguration
          ?.targetIntervalSeconds,
      ).toBe(30);
      expect(observed.recordingConfiguration?.tags?.["alchemy::id"]).toBe(
        "Recording",
      );

      // No-op redeploy keeps the same configuration.
      const noop = yield* stack.deploy(app);
      expect(noop.recordingConfigurationArn).toBe(
        created.recordingConfigurationArn,
      );

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertConfigGone(created.recordingConfigurationArn);
    }),
  { timeout: 300_000 },
);
