import * as AWS from "@/AWS";
import { Index, VectorBucket } from "@/AWS/S3Vectors";
import type { ScopedPlanStatusSession } from "@/Cli/Cli.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });
const stubSession = {
  note: () => Effect.void,
} as unknown as ScopedPlanStatusSession;

const findBucket = (vectorBucketName: string) =>
  s3vectors.getVectorBucket({ vectorBucketName }).pipe(
    Effect.map((r) => r.vectorBucket),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const findIndex = (vectorBucketName: string, indexName: string) =>
  s3vectors.getIndex({ vectorBucketName, indexName }).pipe(
    Effect.map((r) => r.index),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const findPolicy = (vectorBucketName: string) =>
  s3vectors.getVectorBucketPolicy({ vectorBucketName }).pipe(
    Effect.map((r) => r.policy),
    Effect.catchTag("NotFoundException", () =>
      Effect.succeed(undefined as string | undefined),
    ),
  );

class BucketStillExists extends Data.TaggedError("BucketStillExists")<{
  readonly vectorBucketName: string;
}> {}

const assertBucketDeleted = (vectorBucketName: string) =>
  findBucket(vectorBucketName).pipe(
    Effect.flatMap((bucket) =>
      bucket === undefined
        ? Effect.void
        : Effect.fail(new BucketStillExists({ vectorBucketName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create bucket + index, verify out-of-band, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { bucket, index } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("TestVectors", {});
          const index = yield* Index("TestIndex", {
            vectorBucketName: bucket.vectorBucketName,
            dimension: 8,
            distanceMetric: "cosine",
          });
          return { bucket, index };
        }),
      );

      expect(bucket.vectorBucketName).toBeDefined();
      expect(bucket.vectorBucketArn).toContain(":bucket/");
      expect(index.indexName).toBeDefined();
      expect(index.indexArn).toContain("/index/");

      // out-of-band verification via distilled
      const observedBucket = yield* findBucket(bucket.vectorBucketName);
      expect(observedBucket?.vectorBucketArn).toBe(bucket.vectorBucketArn);

      const observedIndex = yield* findIndex(
        bucket.vectorBucketName,
        index.indexName,
      );
      expect(observedIndex?.dimension).toBe(8);
      expect(observedIndex?.distanceMetric).toBe("cosine");

      // internal ownership tags applied
      const tags = yield* s3vectors
        .listTagsForResource({ resourceArn: bucket.vectorBucketArn })
        .pipe(Effect.map((r) => r.tags ?? {}));
      expect(tags["alchemy::id"]).toBe("TestVectors");

      yield* stack.destroy();
      yield* assertBucketDeleted(bucket.vectorBucketName);
    }),
  { timeout: 180_000 },
);

test.provider(
  "custom names + index shape replacement on dimension change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("NamedVectors", {
            vectorBucketName: "alchemy-test-vectors-a",
          });
          // index name generated (engine-default) so a shape change replaces
          // it under a fresh physical name — a pinned name would collide with
          // itself during create-before-delete replacement.
          const index = yield* Index("NamedIndex", {
            vectorBucketName: bucket.vectorBucketName,
            dimension: 4,
            distanceMetric: "euclidean",
          });
          return { bucket, index };
        }),
      );
      expect(first.bucket.vectorBucketName).toBe("alchemy-test-vectors-a");
      expect(first.index.indexName).toBeDefined();

      // changing dimension replaces the index (shape is immutable)
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("NamedVectors", {
            vectorBucketName: "alchemy-test-vectors-a",
          });
          const index = yield* Index("NamedIndex", {
            vectorBucketName: bucket.vectorBucketName,
            dimension: 16,
            distanceMetric: "euclidean",
          });
          return { bucket, index };
        }),
      );
      // replacement produced a new physical index
      expect(second.index.indexName).not.toBe(first.index.indexName);

      const observed = yield* findIndex(
        "alchemy-test-vectors-a",
        second.index.indexName,
      );
      expect(observed?.dimension).toBe(16);

      yield* stack.destroy();
      yield* assertBucketDeleted("alchemy-test-vectors-a");
    }),
  { timeout: 180_000 },
);

test.provider(
  "bucket policy lifecycle: attach, verify, remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucketName = "alchemy-test-vectors-policy";

      // 1. deploy without a policy
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("PolicyVectors", {
            vectorBucketName: bucketName,
          });
          return { bucket };
        }),
      );
      expect(yield* findPolicy(bucketName)).toBeUndefined();

      // 2. attach a policy — principal derived from the bucket ARN's account
      const accountId = first.bucket.vectorBucketArn.split(":")[4];
      const deployWithPolicy = stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("PolicyVectors", {
            vectorBucketName: bucketName,
            policy: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                Action: ["s3vectors:GetVectors", "s3vectors:QueryVectors"],
                Resource: `${first.bucket.vectorBucketArn}/index/*`,
              },
            ],
          });
          return { bucket };
        }),
      );
      yield* deployWithPolicy;

      const attached = yield* findPolicy(bucketName);
      expect(attached).toBeDefined();
      expect(attached).toContain("s3vectors:GetVectors");

      // re-deploying the same policy is a no-op (idempotent sync)
      yield* deployWithPolicy;
      expect(yield* findPolicy(bucketName)).toContain("s3vectors:GetVectors");

      // 3. remove the policy prop — reconcile deletes the bucket policy
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* VectorBucket("PolicyVectors", {
            vectorBucketName: bucketName,
          });
          return { bucket };
        }),
      );
      expect(yield* findPolicy(bucketName)).toBeUndefined();

      yield* stack.destroy();
      yield* assertBucketDeleted(bucketName);
    }),
  { timeout: 240_000 },
);

test.provider(
  "ordinary bucket delete protects an untracked index; force purges it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* VectorBucket("CascadeDelete", {});
        }),
      );
      // Simulate an index created before state persistence. Its child provider
      // cannot enumerate it globally, but deleting the bucket must still work.
      yield* s3vectors.createIndex({
        vectorBucketName: bucket.vectorBucketName,
        indexName: "untracked-child",
        dataType: "float32",
        dimension: 2,
        distanceMetric: "cosine",
      });

      const provider = yield* Provider.findProvider(VectorBucket);
      const deleteInput = {
        id: "CascadeDelete",
        fqn: "CascadeDelete",
        instanceId: "force-delete-test",
        olds: {},
        output: bucket,
        session: stubSession,
        bindings: [],
      };
      const protectedDelete = yield* Effect.result(
        provider.delete(deleteInput),
      );
      expect(Result.isFailure(protectedDelete)).toBe(true);
      if (Result.isFailure(protectedDelete)) {
        expect(protectedDelete.failure._tag).toBe("ConflictException");
      }
      expect(
        yield* findIndex(bucket.vectorBucketName, "untracked-child"),
      ).toBeDefined();

      yield* provider.delete({ ...deleteInput, force: true });
      yield* assertBucketDeleted(bucket.vectorBucketName);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
