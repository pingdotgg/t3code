/**
 * Out-of-band S3 code-bucket helpers for the KinesisAnalyticsV2 tests.
 *
 * Flink applications read their code zip from S3 out-of-band (the object
 * must exist BEFORE the application resource is created), so the bucket is
 * deliberately NOT an in-stack `AWS.S3.Bucket` resource: an in-stack bucket
 * gets an engine-generated (per-instance-unique) physical name, and a
 * crashed/failed run orphans it where the next run's `stack.destroy()`
 * cannot find it. Instead each test uses a DETERMINISTIC bucket name,
 * provisions it with a delete-if-exists pre-clean, and guarantees teardown
 * via an idempotent `Effect.ensuring` finalizer (empty + delete, tolerating
 * NoSuchBucket) — the same pattern as `test/AWS/SNS/Topic.test.ts` and
 * `test/AWS/RDSData/reap.ts`.
 */
import { AWSEnvironment } from "@/AWS/Environment.ts";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeDummyFlinkCodeZip } from "./dummy-zip.ts";

/** Key of the staged code object inside the code bucket. */
export const codeKey = "code/app.zip";

/**
 * Empty the bucket (bounded pagination) and delete it. Idempotent —
 * `NoSuchBucket` at any step is success. Unexpected errors are defects
 * (`Effect.orDie`), so the error channel is `never` and this is a valid
 * `Effect.ensuring` finalizer.
 */
export const deleteCodeBucketIdempotent = (bucketName: string) =>
  Effect.gen(function* () {
    // Bounded pagination — test buckets hold at most a handful of objects.
    for (let page = 0; page < 10; page++) {
      const listed = yield* s3.listObjectsV2({ Bucket: bucketName });
      const objects = (listed.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (objects.length === 0) break;
      yield* s3.deleteObjects({
        Bucket: bucketName,
        Delete: { Objects: objects, Quiet: true },
      });
      if (!listed.IsTruncated) break;
    }
    yield* s3.deleteBucket({ Bucket: bucketName });
  }).pipe(
    Effect.catchTag("NoSuchBucket", () => Effect.void),
    Effect.orDie,
  );

/**
 * Delete-if-exists pre-clean, create the bucket, stage the dummy Flink code
 * zip at {@link codeKey}, and return the bucket ARN. Recreating a
 * just-deleted bucket name can race S3's conflicting-operation window, so
 * creation retries `OperationAborted` boundedly and tolerates
 * `BucketAlreadyOwnedByYou`.
 */
export const provisionCodeBucket = Effect.fn(function* (bucketName: string) {
  yield* deleteCodeBucketIdempotent(bucketName);
  const { region } = yield* AWSEnvironment.current;
  yield* s3
    .createBucket({
      Bucket: bucketName,
      ...(region === "us-east-1"
        ? {}
        : {
            CreateBucketConfiguration: {
              LocationConstraint: region as BucketLocationConstraint,
            },
          }),
    })
    .pipe(
      Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
      Effect.retry({
        while: (e): boolean =>
          e._tag === "OperationAborted" || e._tag === "ServiceUnavailable",
        schedule: Schedule.fixed("5 seconds"),
        times: 8,
      }),
    );
  const zip = yield* Effect.sync(() => makeDummyFlinkCodeZip());
  yield* s3.putObject({ Bucket: bucketName, Key: codeKey, Body: zip });
  return `arn:aws:s3:::${bucketName}`;
});
