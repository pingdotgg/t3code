import * as AWS from "@/AWS";
import {
  Application,
  ApplicationCloudWatchLoggingOption,
} from "@/AWS/KinesisAnalyticsV2";
import * as Test from "@/Test/Alchemy";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  codeKey,
  deleteCodeBucketIdempotent,
  provisionCodeBucket,
} from "./code-bucket.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic out-of-band code bucket (see code-bucket.ts) — an in-stack
// bucket orphans on a crashed run because its generated name is lost with
// the state.
const loggingCodeBucket = "alchemy-test-kav2-logging-code";

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
  "AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption",
  () => {
    test.provider(
      "attach a CloudWatch logging option, detach it, destroy",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Stage the code object BEFORE the application exists — the service
          // reads (and hashes) the object at create/update time.
          const codeBucketArn = yield* provisionCodeBucket(loggingCodeBucket);

          const makeBase = Effect.gen(function* () {
            const logGroup = yield* AWS.Logs.LogGroup("FlinkLogGroup", {});
            const logStream = yield* AWS.Logs.LogStream("FlinkLogStream", {
              logGroupName: logGroup.logGroupName,
            });
            const app = yield* Application("LoggedFlinkApp", {
              runtimeEnvironment: "FLINK-1_20",
              code: { bucketArn: codeBucketArn, fileKey: codeKey },
            });
            return { logGroup, logStream, app };
          });

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const base = yield* makeBase;
              const logging = yield* ApplicationCloudWatchLoggingOption(
                "FlinkLogging",
                {
                  applicationName: base.app.applicationName,
                  logStreamArn: base.logStream.logStreamArn.as<string>(),
                },
              );
              return { ...base, logging };
            }),
          );

          expect(deployed.logging.applicationName).toEqual(
            deployed.app.applicationName,
          );
          expect(deployed.logging.cloudWatchLoggingOptionId).toBeDefined();
          expect(deployed.logging.logStreamArn).toContain(":log-stream:");

          // Out-of-band: the option is visible on the application.
          const described = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          const options =
            described.ApplicationDetail.CloudWatchLoggingOptionDescriptions ??
            [];
          expect(options).toHaveLength(1);
          expect(options[0]?.LogStreamARN).toEqual(
            deployed.logging.logStreamArn,
          );

          // Remove the option while the application stays deployed — the
          // engine deletes just the sub-resource.
          const detached = yield* stack.deploy(makeBase);
          expect(detached.app.applicationName).toEqual(
            deployed.app.applicationName,
          );

          const afterDetach = yield* analytics.describeApplication({
            ApplicationName: deployed.app.applicationName,
          });
          expect(
            afterDetach.ApplicationDetail.CloudWatchLoggingOptionDescriptions ??
              [],
          ).toHaveLength(0);

          yield* stack.destroy();

          yield* assertApplicationDeleted(deployed.app.applicationName);
        }).pipe(Effect.ensuring(deleteCodeBucketIdempotent(loggingCodeBucket))),
      { timeout: 300_000 },
    );
  },
);
