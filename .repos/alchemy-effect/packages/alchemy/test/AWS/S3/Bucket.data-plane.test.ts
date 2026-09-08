import { Action } from "@/Action";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { flociServices } from "@/AWS/Local/FlociServices.ts";
import { Bucket, PutObject, PutObjectHttp } from "@/AWS/S3";
import { remote } from "@/ProviderMode.ts";
import * as Test from "@/Test/Alchemy";
import { liveContext } from "../Local/fixtures/live.ts";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The Floci sweep must override even a configured live AWS environment. This
// sentinel makes the Action regression independent of local profiles.
const forceLocal = process.env.ALCHEMY_TEST_DEV === "1";
const actionProviders = forceLocal
  ? Layer.merge(
      AWS.providers(),
      Layer.succeed(
        AWSEnvironment,
        Effect.succeed({
          accountId: "111111111111",
          region: "us-east-1",
          credentials: Effect.die("live credentials must not be used"),
        }),
      ),
    )
  : AWS.providers();
const { test: actionTest } = Test.make({ providers: actionProviders });

const deployTestBucket = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    // Leading destroy: reconcile away any partial deployment left by a
    // previously crashed run (the auto-generated physical name is
    // deterministic, so the re-deploy below re-adopts and owns it).
    yield* stack.destroy();
    return yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Bucket("DataPlaneTestBucket", {
          forceDestroy: true,
        });
      }),
    );
  });

// The PRODUCTION dev path: plain `dev: true` (no ALCHEMY_TEST_DEV sweep), so
// the ambient AWS environment stays whatever the profile resolves — live
// credentials under `--profile testing`. Binding clients invoked inside an
// Action must route per bound resource regardless: a local-mode bucket's
// calls land on the floci emulator, an `Alchemy.remote()` bucket's calls
// land on the real cloud. Skipped under the sweep, which pins the whole
// process to floci and would make the live-vs-local distinction vacuous.
const { test: devTest } = Test.make({ providers: AWS.providers(), dev: true });
const inSweep = process.env.ALCHEMY_TEST_DEV === "1";

devTest.provider.skipIf(inSweep)(
  "dev Action routes to the local bucket's emulator data plane",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DevLocalActionBucket", {
            forceDestroy: true,
          });
          const PutLocal = Action(
            "PutLocalObject",
            Effect.gen(function* () {
              const putObject = yield* PutObject(bucket);
              return () =>
                Effect.gen(function* () {
                  const result = yield* putObject({
                    Key: "local.txt",
                    Body: "routed to the emulator",
                  });
                  return { etag: result.ETag };
                });
            }).pipe(Effect.provide(PutObjectHttp)),
          );
          return { bucketName: bucket.bucketName, put: yield* PutLocal({}) };
        }),
      );
      expect(output.put.etag).toBeDefined();

      // The object landed on the emulator...
      const local = yield* S3.headObject({
        Bucket: output.bucketName,
        Key: "local.txt",
      }).pipe(Effect.provide(flociServices()));
      expect(local.ETag).toBe(output.put.etag);

      // ...and the bucket never existed on the real cloud. Ambient in a
      // `dev` run is the emulator, so the live probe must opt into the
      // registration-captured live chain (see Actions.local.test.ts).
      const live = yield* S3.headBucket({ Bucket: output.bucketName }).pipe(
        Effect.map(() => "found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
        Effect.provide(liveContext),
      );
      expect(live).toBe("not-found");

      yield* stack.destroy();
    }),
);

devTest.provider.skipIf(inSweep)(
  "dev Action on a remote() bucket targets the real cloud",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("DevRemoteActionBucket", {
            forceDestroy: true,
          }).pipe(remote());
          const PutRemote = Action(
            "PutRemoteObject",
            Effect.gen(function* () {
              const putObject = yield* PutObject(bucket);
              return () =>
                Effect.gen(function* () {
                  const result = yield* putObject({
                    Key: "remote.txt",
                    Body: "landed on real AWS",
                  });
                  return { etag: result.ETag };
                });
            }).pipe(Effect.provide(PutObjectHttp)),
          );
          return { bucketName: bucket.bucketName, put: yield* PutRemote({}) };
        }),
      );
      expect(output.put.etag).toBeDefined();

      // Out-of-band via the live SDK: the write landed on the real bucket.
      // Ambient in a `dev` run is the emulator, so this probe (and the
      // post-destroy check) must opt into the registration-captured live
      // chain.
      yield* Effect.gen(function* () {
        const live = yield* S3.headObject({
          Bucket: output.bucketName,
          Key: "remote.txt",
        });
        expect(live.ETag).toBe(output.put.etag);

        yield* stack.destroy();
        yield* assertBucketDeleted(output.bucketName);
      }).pipe(Effect.provide(liveContext));
    }),
);

actionTest.provider("Action - uses the configured S3 data plane", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const output = yield* stack.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("ActionDataPlaneBucket", {
          forceDestroy: true,
        });
        const PutWithAction = Action(
          "PutWithAction",
          Effect.gen(function* () {
            const putObject = yield* PutObject(bucket);
            return () =>
              Effect.gen(function* () {
                const environment = yield* AWSEnvironment.current;
                if (forceLocal && environment.accountId !== "000000000000") {
                  return { accountId: environment.accountId };
                }
                const result = yield* putObject({
                  Key: "action.txt",
                  Body: "hello from Action",
                });
                return {
                  accountId: environment.accountId,
                  etag: result.ETag,
                };
              });
          }).pipe(Effect.provide(PutObjectHttp)),
        );
        return yield* PutWithAction({});
      }),
    );

    expect(output.etag).toBeDefined();
    if (forceLocal) {
      expect(output.accountId).toBe("000000000000");
    }
    yield* stack.destroy();
  }),
);

test.provider("listObjectsV2 - list objects in bucket", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "file1.txt",
      Body: "content 1",
    });
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "file2.txt",
      Body: "content 2",
    });
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "folder/file3.txt",
      Body: "content 3",
    });

    const result = yield* S3.listObjectsV2({
      Bucket: bucketName,
    });

    expect(result.Contents).toBeDefined();
    expect(result.Contents!.length).toBe(3);
    expect(result.Contents!.map((c) => c.Key)).toContain("file1.txt");
    expect(result.Contents!.map((c) => c.Key)).toContain("file2.txt");
    expect(result.Contents!.map((c) => c.Key)).toContain("folder/file3.txt");

    const prefixResult = yield* S3.listObjectsV2({
      Bucket: bucketName,
      Prefix: "folder/",
    });
    expect(prefixResult.Contents!.length).toBe(1);
    expect(prefixResult.Contents![0].Key).toBe("folder/file3.txt");

    const limitResult = yield* S3.listObjectsV2({
      Bucket: bucketName,
      MaxKeys: 1,
    });
    expect(limitResult.Contents!.length).toBe(1);
    expect(limitResult.IsTruncated).toBe(true);

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("headObject - get object metadata", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "test-file.txt",
      Body: "Hello, World!",
      ContentType: "text/plain",
    });

    const result = yield* S3.headObject({
      Bucket: bucketName,
      Key: "test-file.txt",
    });

    expect(result.ContentType).toBe("text/plain");
    expect(result.ContentLength).toBe(13);
    expect(result.ETag).toBeDefined();

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("headObject - returns error for non-existent object", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    const result = yield* S3.headObject({
      Bucket: bucketName,
      Key: "non-existent.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(result).toBe("not-found");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("copyObject - copy object within bucket", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "source.txt",
      Body: "Original content",
      ContentType: "text/plain",
    });

    yield* S3.copyObject({
      Bucket: bucketName,
      Key: "destination.txt",
      CopySource: `${bucketName}/source.txt`,
    });

    const destHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "destination.txt",
    });
    expect(destHead.ContentType).toBe("text/plain");
    expect(destHead.ContentLength).toBe(16);

    const sourceHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "source.txt",
    });
    expect(sourceHead.ContentLength).toBe(16);

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("copyObject - copy with metadata replacement", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "source.txt",
      Body: "Content",
      ContentType: "text/plain",
    });

    yield* S3.copyObject({
      Bucket: bucketName,
      Key: "destination.txt",
      CopySource: `${bucketName}/source.txt`,
      ContentType: "application/octet-stream",
      MetadataDirective: "REPLACE",
    });

    const destHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "destination.txt",
    });
    // AWS may normalize content-type to binary/octet-stream
    expect(destHead.ContentType).toBe("binary/octet-stream");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("multipart upload - complete workflow", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    const createResult = yield* S3.createMultipartUpload({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      ContentType: "text/plain",
    });

    expect(createResult.UploadId).toBeDefined();
    const uploadId = createResult.UploadId!;

    // AWS S3 requires parts to be at least 5MB except for the last (or only)
    // part, so a single-part upload works with any size
    const partContent = "Complete multipart upload content";

    const partResult = yield* S3.uploadPart({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      UploadId: uploadId,
      PartNumber: 1,
      Body: partContent,
    });
    expect(partResult.ETag).toBeDefined();

    yield* S3.completeMultipartUpload({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [{ ETag: partResult.ETag!, PartNumber: 1 }],
      },
    });

    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "multipart-file.txt",
    });
    // AWS S3 may use binary/octet-stream for multipart uploads even when
    // ContentType is set on createMultipartUpload
    expect(headResult.ContentLength).toBe(partContent.length);

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("multipart upload - abort", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    const createResult = yield* S3.createMultipartUpload({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      ContentType: "text/plain",
    });

    const uploadId = createResult.UploadId!;

    yield* S3.uploadPart({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      UploadId: uploadId,
      PartNumber: 1,
      Body: "Some content",
    });

    yield* S3.abortMultipartUpload({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      UploadId: uploadId,
    });

    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "aborted-file.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(headResult).toBe("not-found");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("putObject and getObject - basic operations", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "test-put.txt",
      Body: "Test content for put operation",
      ContentType: "text/plain",
    });

    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "test-put.txt",
    });
    expect(headResult.ContentType).toBe("text/plain");
    expect(headResult.ContentLength).toBe(30);

    const getResult = yield* S3.getObject({
      Bucket: bucketName,
      Key: "test-put.txt",
    });
    expect(getResult.ContentType).toBe("text/plain");
    expect(getResult.ContentLength).toBe(30);

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

test.provider("deleteObject - remove object", (stack) =>
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket(stack);
    const bucketName = bucket.bucketName;

    yield* S3.putObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
      Body: "Delete me",
    });

    yield* S3.headObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    });

    yield* S3.deleteObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    });

    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(headResult).toBe("not-found");

    yield* stack.destroy();
    yield* assertBucketDeleted(bucketName);
  }),
);

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
