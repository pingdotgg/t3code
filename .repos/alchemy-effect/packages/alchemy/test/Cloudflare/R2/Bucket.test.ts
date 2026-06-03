import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete bucket with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.storageClass).toEqual("Standard");
    expect(bucket.jurisdiction).toEqual("default");

    const actualBucket = yield* getBucketWhenReady(
      bucket.bucketName,
      accountId,
    );
    expect(actualBucket.name).toEqual(bucket.bucketName);

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete bucket", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "Standard",
        });
      }),
    );

    const actualBucket = yield* getBucketWhenReady(
      bucket.bucketName,
      accountId,
    );
    expect(actualBucket.name).toEqual(bucket.bucketName);
    expect(actualBucket.storageClass).toEqual("Standard");

    const updatedBucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "InfrequentAccess",
        });
      }),
    );

    const actualUpdatedBucket = yield* getBucketWhenReady(
      updatedBucket.bucketName,
      accountId,
    );
    expect(actualUpdatedBucket.name).toEqual(updatedBucket.bucketName);
    expect(actualUpdatedBucket.storageClass).toEqual("InfrequentAccess");

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

// Engine-level adoption: R2 buckets have no ownership signal (Cloudflare
// doesn't expose tags on R2 buckets), so a name match in `read` is treated
// as silent adoption.
test.provider(
  "existing bucket (matching name) is silently adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucketName = `alchemy-test-r2-adopt-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      // Phase 1: deploy normally so a real R2 bucket exists.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("AdoptableBucket", {
            name: bucketName,
          });
        }),
      );
      expect(initial.bucketName).toEqual(bucketName);

      // Phase 2: wipe local state — the bucket stays on Cloudflare.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableBucket",
        });
      }).pipe(Effect.provide(stack.state));

      // Phase 3: redeploy without `adopt(true)`. The engine calls
      // `provider.read`, which fetches the bucket by name and returns
      // plain attrs — silent adoption.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2Bucket("AdoptableBucket", {
            name: bucketName,
          });
        }),
      );

      expect(adopted.bucketName).toEqual(bucketName);

      const persisted = yield* Effect.gen(function* () {
        const state = yield* yield* State;
        return yield* state.get({
          stack: stack.name,
          stage: "test",
          fqn: "AdoptableBucket",
        });
      }).pipe(Effect.provide(stack.state));

      expect((persisted as any)?.attr).toMatchObject({ bucketName });

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucketName, accountId);
    }).pipe(logLevel),
);

test.provider("destroying a bucket empties its objects first", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("BucketWithObjects");
      }),
    );

    const putObject = (key: string, body: string) =>
      r2.putObject({
        accountId,
        bucketName: bucket.bucketName,
        objectName: key,
        contentType: "text/plain",
        body: new Blob([body], { type: "text/plain" }),
      });
    yield* putObject("hello.txt", "hello");
    yield* putObject("nested/world.txt", "world");

    const before = yield* r2
      .listObjects({
        accountId,
        bucketName: bucket.bucketName,
        perPage: 1000,
      })
      .pipe(
        Effect.flatMap((page) => {
          const keys = (page.result ?? [])
            .map((o) => o.key)
            .filter((k): k is string => typeof k === "string");
          return keys.length === 2
            ? Effect.succeed(keys)
            : Effect.fail(new ListLagError());
        }),
        Effect.retry({
          while: (e): e is ListLagError => e instanceof ListLagError,
          schedule: Schedule.exponential(200).pipe(
            Schedule.both(Schedule.recurs(8)),
          ),
        }),
      );
    expect(before.sort()).toEqual(["hello.txt", "nested/world.txt"]);

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("lifecycle rules are added, updated, and removed", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create with one rule.
    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("LifecycleBucket", {
          lifecycleRules: [
            {
              id: "expire-after-30d",
              deleteObjectsTransition: {
                condition: { type: "Age", maxAge: 60 * 60 * 24 * 30 },
              },
            },
          ],
        });
      }),
    );

    const initialRules = yield* r2.getBucketLifecycle({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(initialRules.rules).toHaveLength(1);
    expect(initialRules.rules?.[0]?.id).toEqual("expire-after-30d");
    expect(initialRules.rules?.[0]?.enabled).toEqual(true);
    expect(initialRules.rules?.[0]?.deleteObjectsTransition?.condition).toEqual(
      { type: "Age", maxAge: 60 * 60 * 24 * 30 },
    );

    // Update: change the prefix and add a storage class transition.
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("LifecycleBucket", {
          lifecycleRules: [
            {
              id: "expire-after-30d",
              prefix: "logs/",
              storageClassTransitions: [
                {
                  condition: { type: "Age", maxAge: 60 * 60 * 24 * 7 },
                  storageClass: "InfrequentAccess",
                },
              ],
              deleteObjectsTransition: {
                condition: { type: "Age", maxAge: 60 * 60 * 24 * 30 },
              },
            },
          ],
        });
      }),
    );

    const updatedRules = yield* r2.getBucketLifecycle({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(updatedRules.rules).toHaveLength(1);
    expect(updatedRules.rules?.[0]?.conditions.prefix).toEqual("logs/");
    expect(updatedRules.rules?.[0]?.storageClassTransitions).toEqual([
      {
        condition: { type: "Age", maxAge: 60 * 60 * 24 * 7 },
        storageClass: "InfrequentAccess",
      },
    ]);

    // Clear all rules.
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("LifecycleBucket", {
          lifecycleRules: [],
        });
      }),
    );

    const clearedRules = yield* r2.getBucketLifecycle({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(clearedRules.rules ?? []).toEqual([]);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(initial.bucketName, accountId);
  }).pipe(logLevel),
);

// R2 bucket creates are eventually consistent — a read immediately after
// deploy can briefly return NoSuchBucket until the bucket propagates.
const getBucketWhenReady = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  return yield* r2.getBucket({ accountId, bucketName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NoSuchBucket",
      schedule: Schedule.exponential("200 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

class ListLagError extends Data.TaggedError("ListLagError") {}
