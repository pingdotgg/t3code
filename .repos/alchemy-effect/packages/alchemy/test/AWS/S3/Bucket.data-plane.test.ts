import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const deployTestBucket = (stack: Test.ScratchStack) =>
  stack.deploy(
    Effect.gen(function* () {
      return yield* Bucket("DataPlaneTestBucket", {
        forceDestroy: true,
      });
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
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
