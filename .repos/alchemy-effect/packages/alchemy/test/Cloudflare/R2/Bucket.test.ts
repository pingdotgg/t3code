import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
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
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DefaultBucket");
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
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("TestBucket", {
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
        return yield* Cloudflare.R2.Bucket("TestBucket", {
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
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Phase 1: deploy normally so a real R2 bucket exists. No explicit
      // `name` — the engine generates a random-suffixed physical name
      // (collision-free across concurrent runs); the deploy output hands
      // back the real name, which pins the bucket's identity for the
      // adoption phase below.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("AdoptableBucket");
        }),
      );
      const bucketName = initial.bucketName;

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
          return yield* Cloudflare.R2.Bucket("AdoptableBucket", {
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
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("BucketWithObjects");
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
          schedule: Schedule.max([
            Schedule.exponential(200),
            Schedule.recurs(8),
          ]),
        }),
      );
    expect(before.sort()).toEqual(["hello.txt", "nested/world.txt"]);

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("lifecycle rules are added, updated, and removed", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create with one rule.
    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("LifecycleBucket", {
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
        return yield* Cloudflare.R2.Bucket("LifecycleBucket", {
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
        return yield* Cloudflare.R2.Bucket("LifecycleBucket", {
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

test.provider("cors rules are added, updated, and removed", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create with one rule.
    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("CorsBucket", {
          cors: [
            {
              id: "range-reads",
              allowedMethods: ["GET", "HEAD"],
              allowedOrigins: ["https://map.example.com"],
              allowedHeaders: ["range"],
              exposeHeaders: ["etag", "content-range"],
              maxAgeSeconds: 3600,
            },
          ],
        });
      }),
    );

    expect(initial.cors).toHaveLength(1);

    const initialCors = yield* r2.getBucketCors({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(initialCors.rules).toHaveLength(1);
    expect(initialCors.rules?.[0]?.id).toEqual("range-reads");
    expect(initialCors.rules?.[0]?.allowed.methods).toEqual(["GET", "HEAD"]);
    expect(initialCors.rules?.[0]?.allowed.origins).toEqual([
      "https://map.example.com",
    ]);
    expect(initialCors.rules?.[0]?.exposeHeaders).toEqual([
      "etag",
      "content-range",
    ]);
    expect(initialCors.rules?.[0]?.maxAgeSeconds).toEqual(3600);

    // Update: widen origins and add a second rule.
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("CorsBucket", {
          cors: [
            {
              id: "range-reads",
              allowedMethods: ["GET", "HEAD"],
              allowedOrigins: ["*"],
              allowedHeaders: ["range"],
              exposeHeaders: ["etag", "content-range"],
              maxAgeSeconds: 3600,
            },
            {
              id: "uploads",
              allowedMethods: ["PUT", "POST"],
              allowedOrigins: ["https://app.example.com"],
              allowedHeaders: ["content-type"],
            },
          ],
        });
      }),
    );

    const updatedCors = yield* r2.getBucketCors({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(updatedCors.rules).toHaveLength(2);
    expect(updatedCors.rules?.[0]?.allowed.origins).toEqual(["*"]);
    expect(updatedCors.rules?.[1]?.id).toEqual("uploads");
    expect(updatedCors.rules?.[1]?.allowed.methods).toEqual(["PUT", "POST"]);

    // Clear all rules — the CORS configuration is deleted entirely, so the
    // GET endpoint reports the typed NoCorsConfiguration error.
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("CorsBucket", {
          cors: [],
        });
      }),
    );

    const cleared = yield* r2
      .getBucketCors({
        accountId,
        bucketName: initial.bucketName,
      })
      .pipe(
        Effect.map((response) => response.rules ?? []),
        Effect.catchTag("NoCorsConfiguration", () => Effect.succeed([])),
      );
    expect(cleared).toEqual([]);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(initial.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("cors reconciliation converges drift and adoption", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const bucketName = "alchemy-test-r2-cors-drift";
    const rangeReads = {
      id: "range-reads",
      allowedMethods: ["GET", "HEAD"] as ("GET" | "HEAD")[],
      allowedOrigins: ["https://map.example.com"],
      allowedHeaders: ["range"],
      exposeHeaders: ["etag"],
      maxAgeSeconds: 3600,
    };
    const foreignRule = {
      id: "foreign",
      allowed: {
        methods: ["DELETE" as const],
        origins: ["https://other.example.com"],
      },
    };

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftCorsBucket", {
          name: bucketName,
          cors: [rangeReads],
        });
      }),
    );

    // Drift: overwrite the CORS configuration out-of-band.
    yield* r2.putBucketCors({
      accountId,
      bucketName,
      rules: [foreignRule],
    });

    // Re-deploy with a changed rule. Reconcile diffs desired against
    // *observed* cloud state (not olds), so the foreign rule is replaced
    // even though olds still describes the original rule.
    yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftCorsBucket", {
          name: bucketName,
          cors: [{ ...rangeReads, maxAgeSeconds: 7200 }],
        });
      }),
    );

    const repaired = yield* r2.getBucketCors({ accountId, bucketName });
    expect(repaired.rules).toHaveLength(1);
    expect(repaired.rules?.[0]?.id).toEqual("range-reads");
    expect(repaired.rules?.[0]?.maxAgeSeconds).toEqual(7200);

    // Adoption: re-drift the CORS config, then wipe local state so the next
    // deploy adopts via `read` (output defined, olds undefined).
    yield* r2.putBucketCors({
      accountId,
      bucketName,
      rules: [foreignRule],
    });
    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "DriftCorsBucket",
      });
    }).pipe(Effect.provide(stack.state));

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftCorsBucket", {
          name: bucketName,
          cors: [rangeReads],
        });
      }),
    );
    expect(adopted.bucketName).toEqual(bucketName);
    expect(adopted.cors).toHaveLength(1);
    expect(adopted.cors[0]?.id).toEqual("range-reads");

    const converged = yield* r2.getBucketCors({ accountId, bucketName });
    expect(converged.rules).toHaveLength(1);
    expect(converged.rules?.[0]?.id).toEqual("range-reads");
    expect(converged.rules?.[0]?.allowed.origins).toEqual([
      "https://map.example.com",
    ]);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("cors is applied to the new bucket on replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const oldName = "alchemy-test-r2-cors-replace-a";
    const newName = "alchemy-test-r2-cors-replace-b";
    const cors = [
      {
        id: "range-reads",
        allowedMethods: ["GET", "HEAD"] as ("GET" | "HEAD")[],
        allowedOrigins: ["https://map.example.com"],
        allowedHeaders: ["range"],
        exposeHeaders: ["etag"],
        maxAgeSeconds: 3600,
      },
    ];

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("ReplaceCorsBucket", {
          name: oldName,
          cors,
        });
      }),
    );
    expect(initial.bucketName).toEqual(oldName);

    const initialCors = yield* r2.getBucketCors({
      accountId,
      bucketName: oldName,
    });
    expect(initialCors.rules).toHaveLength(1);

    // Changing the name replaces the bucket: the new bucket is created
    // (greenfield reconcile must apply the CORS config from scratch) and
    // the old bucket is deleted afterwards.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("ReplaceCorsBucket", {
          name: newName,
          cors,
        });
      }),
    );
    expect(replaced.bucketName).toEqual(newName);
    expect(replaced.cors).toHaveLength(1);
    expect(replaced.cors[0]?.id).toEqual("range-reads");

    const replacedCors = yield* r2.getBucketCors({
      accountId,
      bucketName: newName,
    });
    expect(replacedCors.rules).toHaveLength(1);
    expect(replacedCors.rules?.[0]?.id).toEqual("range-reads");
    expect(replacedCors.rules?.[0]?.allowed.origins).toEqual([
      "https://map.example.com",
    ]);

    // The replaced bucket is cleaned up.
    yield* waitForBucketToBeDeleted(oldName, accountId);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(newName, accountId);
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
      // Cap the backoff at 2s so we keep sampling instead of sleeping
      // through the budget on the geometric tail.
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("200 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
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
