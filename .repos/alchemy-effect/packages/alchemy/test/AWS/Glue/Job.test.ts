import * as AWS from "@/AWS";
import { Job } from "@/AWS/Glue";
import { Role } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const getJob = (name: string) =>
  glue.getJob({ JobName: name }).pipe(
    Effect.map((r) => r.Job),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

const jobRole = () =>
  Role("GlueJobRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "glue.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole",
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    ],
  });

test.provider("create, update, delete Glue job definition", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("JobBucket", { forceDestroy: true });
        const role = yield* jobRole();
        const job = yield* Job("Etl", {
          role: role.roleArn,
          command: {
            name: "pythonshell",
            pythonVersion: "3.9",
            scriptLocation: Output.interpolate`s3://${bucket.bucketName}/scripts/etl.py`,
          },
          maxCapacity: 0.0625,
          glueVersion: "3.0",
          defaultArguments: { "--job-language": "python" },
          tags: { Environment: "test" },
        });
        return { bucket, role, job };
      }),
    );

    expect(created.job.jobName).toBeDefined();
    expect(created.job.jobArn).toContain(`:job/${created.job.jobName}`);

    // out-of-band verification
    const observed = yield* getJob(created.job.jobName);
    expect(observed?.Name).toEqual(created.job.jobName);
    expect(observed?.Command?.Name).toEqual("pythonshell");
    expect(observed?.Command?.ScriptLocation).toEqual(
      `s3://${created.bucket.bucketName}/scripts/etl.py`,
    );
    expect(observed?.GlueVersion).toEqual("3.0");
    expect(observed?.DefaultArguments?.["--job-language"]).toEqual("python");

    // tags (jobs ARE ARN-taggable)
    const tags = yield* glue.getTags({ ResourceArn: created.job.jobArn });
    expect(tags.Tags?.["alchemy::id"]).toBeDefined();
    expect(tags.Tags?.Environment).toEqual("test");

    // update: change default arguments + timeout
    yield* stack.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("JobBucket", { forceDestroy: true });
        const role = yield* jobRole();
        const job = yield* Job("Etl", {
          role: role.roleArn,
          command: {
            name: "pythonshell",
            pythonVersion: "3.9",
            scriptLocation: Output.interpolate`s3://${bucket.bucketName}/scripts/etl.py`,
          },
          maxCapacity: 0.0625,
          glueVersion: "3.0",
          description: "curated ETL",
          defaultArguments: { "--job-language": "python", "--extra": "1" },
          timeout: "30 minutes",
          tags: { Environment: "test" },
        });
        return { job };
      }),
    );

    const reobserved = yield* getJob(created.job.jobName);
    expect(reobserved?.Description).toEqual("curated ETL");
    expect(reobserved?.DefaultArguments?.["--extra"]).toEqual("1");
    expect(reobserved?.Timeout).toEqual(30);

    yield* stack.destroy();
    const gone = yield* getJob(created.job.jobName);
    expect(gone).toBeUndefined();
  }),
);

// A live job run is billed and takes ~1-2 minutes — gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "run a live Python shell job to success",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("LiveJobBucket", { forceDestroy: true });
          const role = yield* jobRole();
          const job = yield* Job("LiveEtl", {
            role: role.roleArn,
            command: {
              name: "pythonshell",
              pythonVersion: "3.9",
              scriptLocation: Output.interpolate`s3://${bucket.bucketName}/scripts/noop.py`,
            },
            maxCapacity: 0.0625,
            glueVersion: "3.0",
          });
          return { bucket, job };
        }),
      );

      // upload a trivial script the job will execute
      yield* s3.putObject({
        Bucket: deployed.bucket.bucketName,
        Key: "scripts/noop.py",
        Body: new TextEncoder().encode("print('hello from glue')\n"),
      });

      // Start a run and poll to a terminal state. A run started seconds after
      // the IAM role is created can FAIL with "should be given assume role
      // permissions for Glue Service" while the trust propagates — retry the
      // whole start+await through that window (bounded).
      const runOnce = Effect.gen(function* () {
        const { JobRunId } = yield* glue.startJobRun({
          JobName: deployed.job.jobName,
        });
        const finalRun = yield* glue
          .getJobRun({ JobName: deployed.job.jobName, RunId: JobRunId! })
          .pipe(
            Effect.map((r) => r.JobRun),
            Effect.repeat({
              schedule: Schedule.spaced("15 seconds"),
              until: (run) =>
                run?.JobRunState === "SUCCEEDED" ||
                run?.JobRunState === "FAILED" ||
                run?.JobRunState === "TIMEOUT" ||
                run?.JobRunState === "ERROR",
              times: 20,
            }),
          );
        yield* Effect.log(
          `job run state=${finalRun?.JobRunState} error=${finalRun?.ErrorMessage}`,
        );
        if (
          finalRun?.JobRunState !== "SUCCEEDED" &&
          finalRun?.ErrorMessage?.includes("assume role permissions")
        ) {
          return yield* Effect.fail("role-not-yet-assumable" as const);
        }
        return finalRun;
      });

      const finalRun = yield* runOnce.pipe(
        Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 4 }),
      );
      expect(finalRun?.JobRunState).toEqual("SUCCEEDED");

      yield* stack.destroy();
    }),
  { timeout: 420_000 },
);
