import * as AWS from "@/AWS";
import { Application } from "@/AWS/EMRServerless";
import { Role } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emr from "@distilled.cloud/aws/emr-serverless";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic names — same on every run of the test case.
const APP_NAME = "alchemy-test-emrs-app";
const JOB_APP_NAME = "alchemy-test-emrs-job";
const RELEASE_LABEL = "emr-7.5.0";

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag the read/observe/delete paths depend on.
test.provider("typed error semantics on a nonexistent application", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      emr.getApplication({ applicationId: "00abcdefabcdef01" }),
    );
    expect(error._tag).toBe("ResourceNotFoundException");
  }),
);

// Full ungated lifecycle: an application in the CREATED state is free (billing
// only starts when the application starts workers), and creation is bounded
// (~1 min). create → CREATED, no-op redeploy, in-place update, destroy,
// verify gone.
test.provider(
  "application lifecycle: create, no-op, update, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const deployApp = (idleMinutes: number) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Application("App", {
              applicationName: APP_NAME,
              releaseLabel: RELEASE_LABEL,
              autoStartConfiguration: { enabled: true },
              autoStopConfiguration: {
                enabled: true,
                idleTimeout: Duration.minutes(idleMinutes),
              },
              tags: { purpose: "alchemy-test" },
            });
          }),
        );

      const created = yield* deployApp(15);
      expect(created.applicationName).toBe(APP_NAME);
      // the API echoes the engine type in mixed case ("Spark"/"Hive")
      expect(created.type).toBe("Spark");
      expect(created.releaseLabel).toBe(RELEASE_LABEL);
      expect(created.applicationArn).toContain("/applications/");
      expect(created.state).toBe("CREATED");

      // Out-of-band verification via distilled.
      const observed = yield* emr.getApplication({
        applicationId: created.applicationId,
      });
      expect(observed.application.state).toBe("CREATED");
      expect(
        observed.application.autoStopConfiguration?.idleTimeoutMinutes,
      ).toBe(15);
      expect(observed.application.tags?.purpose).toBe("alchemy-test");

      // The provider's list() enumerates it.
      const provider = yield* Provider.findProvider(Application);
      const all = yield* provider.list();
      expect(all.some((a) => a.applicationId === created.applicationId)).toBe(
        true,
      );

      // No-op redeploy: same application, no replacement.
      const noop = yield* deployApp(15);
      expect(noop.applicationId).toBe(created.applicationId);

      // In-place update: shrink the auto-stop idle timeout.
      const updated = yield* deployApp(5);
      expect(updated.applicationId).toBe(created.applicationId);
      const afterUpdate = yield* emr.getApplication({
        applicationId: created.applicationId,
      });
      expect(
        afterUpdate.application.autoStopConfiguration?.idleTimeoutMinutes,
      ).toBe(5);

      // Destroy and verify deletion out-of-band (deleted applications either
      // disappear or briefly linger as TERMINATED).
      yield* stack.destroy();
      yield* assertApplicationGone(created.applicationId);
    }),
  { timeout: 240_000 },
);

// Live JobRun (SparkPi from the EMR image itself — no S3 assets needed).
// Starting the application and running the job bills real worker-seconds and
// takes minutes, so it is gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "live Spark job run reaches SUCCESS (AWS_TEST_SLOW=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { app, role } = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* Role("JobRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "emr-serverless.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const app = yield* Application("JobApp", {
            applicationName: JOB_APP_NAME,
            releaseLabel: RELEASE_LABEL,
            autoStopConfiguration: {
              enabled: true,
              idleTimeout: "1 minute",
            },
          });
          return { app, role };
        }),
      );

      const jobToken = yield* Effect.sync(() => crypto.randomUUID());
      const started = yield* emr.startJobRun({
        clientToken: jobToken,
        applicationId: app.applicationId,
        executionRoleArn: role.roleArn,
        jobDriver: {
          sparkSubmit: {
            entryPoint: "local:///usr/lib/spark/examples/src/main/python/pi.py",
            sparkSubmitParameters:
              "--conf spark.executor.cores=1 --conf spark.executor.memory=2g --conf spark.executor.instances=1 --conf spark.driver.cores=1 --conf spark.driver.memory=2g",
          },
        },
        executionTimeoutMinutes: 10,
      });

      // Poll the job run to a terminal state (app cold-start ~1 min + SparkPi
      // ~1-2 min; bounded at ~8 min).
      const finished = yield* emr
        .getJobRun({
          applicationId: app.applicationId,
          jobRunId: started.jobRunId,
        })
        .pipe(
          Effect.map((response) => response.jobRun),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (run) =>
              run.state === "SUCCESS" ||
              run.state === "FAILED" ||
              run.state === "CANCELLED",
            times: 48,
          }),
        );
      expect(finished.stateDetails).toBeDefined();
      expect(finished.state).toBe("SUCCESS");

      // Destroy immediately (the provider stops the STARTED application
      // before deleting it) and verify gone.
      yield* stack.destroy();
      yield* assertApplicationGone(app.applicationId);
    }),
  { timeout: 900_000 },
);

const assertApplicationGone = (applicationId: string) =>
  Effect.gen(function* () {
    const state = yield* emr.getApplication({ applicationId }).pipe(
      Effect.map((response) => response.application.state),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone"),
      ),
    );
    if (state !== "gone" && state !== "TERMINATED") {
      return yield* Effect.fail(
        new Error(`application ${applicationId} still exists (${state})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );
