import * as AWS from "@/AWS";
import { Application, ApplicationSnapshot } from "@/AWS/KinesisAnalyticsV2";
import * as Test from "@/Test/Alchemy";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Snapshots require a RUNNING application, and starting an application
 * requires a REAL Flink application jar (a placeholder zip passes creation
 * but the Flink job submission fails and the start rolls back). There is no
 * way to fabricate a runnable jar in this repo, so the live lifecycle is
 * gated behind:
 *
 *   AWS_TEST_FLINK_START=1
 *   AWS_TEST_FLINK_JAR_BUCKET_ARN=arn:aws:s3:::my-bucket   (bucket holding the jar)
 *   AWS_TEST_FLINK_JAR_KEY=jars/my-flink-app.jar           (key of a runnable jar)
 *
 * The jar must target the FLINK-1_20 runtime. The ungated typed-error probe
 * for snapshots (describeApplicationSnapshot on a missing snapshot →
 * ResourceNotFoundException) lives in Application.test.ts.
 */
const gated =
  !process.env.AWS_TEST_FLINK_START ||
  !process.env.AWS_TEST_FLINK_JAR_BUCKET_ARN ||
  !process.env.AWS_TEST_FLINK_JAR_KEY;

describe.skipIf(gated)("AWS.KinesisAnalyticsV2.ApplicationSnapshot", () => {
  test.provider(
    "start application, snapshot it, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const app = yield* Application("SnapshottedFlinkApp", {
              runtimeEnvironment: "FLINK-1_20",
              code: {
                bucketArn: process.env.AWS_TEST_FLINK_JAR_BUCKET_ARN!,
                fileKey: process.env.AWS_TEST_FLINK_JAR_KEY!,
              },
              snapshotsEnabled: true,
              start: true,
            });
            const snapshot = yield* ApplicationSnapshot("Checkpoint", {
              applicationName: app.applicationName,
            });
            return { app, snapshot };
          }),
        );

        expect(deployed.app.applicationStatus).toEqual("RUNNING");
        expect(deployed.snapshot.snapshotStatus).toEqual("READY");
        expect(deployed.snapshot.applicationName).toEqual(
          deployed.app.applicationName,
        );

        // Out-of-band verification via distilled.
        const described = yield* analytics.describeApplicationSnapshot({
          ApplicationName: deployed.app.applicationName,
          SnapshotName: deployed.snapshot.snapshotName,
        });
        expect(described.SnapshotDetails.SnapshotStatus).toEqual("READY");

        yield* stack.destroy();

        // The snapshot is deleted with the stack (before the application).
        const gone = yield* analytics
          .describeApplication({
            ApplicationName: deployed.app.applicationName,
          })
          .pipe(Effect.flip);
        expect(gone._tag).toEqual("ResourceNotFoundException");
      }),
    { timeout: 1_140_000 },
  );
});
