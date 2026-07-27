import * as AWS from "@/AWS";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as datasync from "@distilled.cloud/aws/datasync";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const waitUntilTaskGone = (taskArn: string) =>
  datasync.describeTask({ TaskArn: taskArn }).pipe(
    Effect.as(false),
    Effect.catchTag("TaskNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("1 seconds"),
      until: (gone) => gone,
      times: 20,
    }),
  );

const trustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "datasync.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const s3Policy = (arn: Output.Output<string>) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Action: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
      ],
      Resource: [arn],
    },
    {
      Effect: "Allow" as const,
      Action: [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:GetObjectTagging",
        "s3:ListMultipartUploadParts",
        "s3:PutObject",
        "s3:PutObjectTagging",
      ],
      Resource: [Output.interpolate`${arn}/*`],
    },
  ],
});

const buildStack = (options?: datasync.Options) =>
  Effect.gen(function* () {
    const src = yield* AWS.S3.Bucket("TaskSrc", { forceDestroy: true });
    const dst = yield* AWS.S3.Bucket("TaskDst", { forceDestroy: true });
    const role = yield* AWS.IAM.Role("TaskRole", {
      assumeRolePolicyDocument: trustPolicy,
      inlinePolicies: {
        Src: s3Policy(src.bucketArn),
        Dst: s3Policy(dst.bucketArn),
      },
    });
    const source = yield* AWS.DataSync.LocationS3("TaskSrcLoc", {
      s3BucketArn: src.bucketArn,
      bucketAccessRoleArn: role.roleArn,
    });
    const dest = yield* AWS.DataSync.LocationS3("TaskDstLoc", {
      s3BucketArn: dst.bucketArn,
      bucketAccessRoleArn: role.roleArn,
    });
    const task = yield* AWS.DataSync.Task("BackupTask", {
      sourceLocationArn: source.locationArn,
      destinationLocationArn: dest.locationArn,
      ...(options !== undefined ? { options } : {}),
    });
    return { task, src, dst };
  });

test.provider(
  "typed TaskNotFound on a nonexistent task",
  () =>
    Effect.gen(function* () {
      const result = yield* datasync
        .describeTask({
          TaskArn:
            "arn:aws:datasync:us-west-2:391965393224:task/task-00000000000000000",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const err = result.failure as { _tag: string };
        expect(err._tag).toBe("TaskNotFound");
      }
    }),
  { timeout: 60_000 },
);

test.provider(
  "create S3 -> S3 task, update options, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // --- create: two S3 locations + a transfer task ---
      const created = yield* stack.deploy(buildStack());
      expect(created.task.taskArn).toContain(":task/task-");
      expect(created.task.sourceLocationArn).toContain(":location/loc-");
      expect(created.task.destinationLocationArn).toContain(":location/loc-");
      const arn = created.task.taskArn;

      const observed = yield* datasync.describeTask({ TaskArn: arn });
      expect(observed.SourceLocationArn).toBe(created.task.sourceLocationArn);
      const tags = Object.fromEntries(
        (
          (yield* datasync.listTagsForResource({ ResourceArn: arn })).Tags ?? []
        ).map((t) => [t.Key, t.Value]),
      );
      expect(tags["alchemy::id"]).toBe("BackupTask");

      // --- update: change transfer options in place ---
      const updated = yield* stack.deploy(
        buildStack({ VerifyMode: "ONLY_FILES_TRANSFERRED" }),
      );
      expect(updated.task.taskArn).toBe(arn);
      const observed2 = yield* datasync.describeTask({ TaskArn: arn });
      expect(observed2.Options?.VerifyMode).toBe("ONLY_FILES_TRANSFERRED");

      // --- delete ---
      yield* stack.destroy();
      const gone = yield* waitUntilTaskGone(arn);
      expect(gone).toBe(true);
    }),
  { timeout: 240_000 },
);

// A live BASIC-mode task execution has 1–4 minutes of launch/prepare
// overhead, so it is gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "live S3 -> S3 task execution transfers an object",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        buildStack({ VerifyMode: "ONLY_FILES_TRANSFERRED" }),
      );

      yield* S3.putObject({
        Bucket: created.src.bucketName,
        Key: "hello.txt",
        Body: "hello datasync",
      });

      // The freshly-created IAM role's permissions take a while to propagate
      // to DataSync's location access test (typed LocationAccessTestFailed,
      // patched from InvalidRequestException + "location access test failed").
      const started = yield* datasync
        .startTaskExecution({ TaskArn: created.task.taskArn })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "LocationAccessTestFailed",
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(12),
            ]),
          }),
        );
      const finished = yield* datasync
        .describeTaskExecution({
          TaskExecutionArn: started.TaskExecutionArn!,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (e) => e.Status === "SUCCESS" || e.Status === "ERROR",
            times: 40,
          }),
        );
      if (finished.Status !== "SUCCESS") {
        // surface the execution failure detail before the assertion trips
        yield* Effect.log("task execution result", finished.Result);
      }
      expect(finished.Status).toBe("SUCCESS");

      // out-of-band: the object landed in the destination bucket
      yield* S3.headObject({
        Bucket: created.dst.bucketName,
        Key: "hello.txt",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilTaskGone(created.task.taskArn);
      expect(gone).toBe(true);
    }),
  { timeout: 900_000 },
);
