import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import * as Cloudflare from "@/Cloudflare";
import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { LocalRuntimeState } from "@/Cloudflare/LocalRuntime.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { Provider } from "@/Provider.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { type ResourceState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";

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
        return yield* Cloudflare.R2.Bucket("DefaultBucket", {
          forceDestroy: true,
        });
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.storageClass).toEqual("Standard");
    expect(bucket.jurisdiction).toEqual("default");
    expect(bucket.publicDomain).toBeUndefined();

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
          forceDestroy: true,
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
          forceDestroy: true,
          storageClass: "InfrequentAccess",
        });
      }),
    );

    // The storage-class change is an IN-PLACE update (PATCH with the
    // `cf-r2-storage-class` header), never a replacement: same physical
    // bucket name and unchanged creation date.
    expect(updatedBucket.bucketName).toEqual(bucket.bucketName);

    const actualUpdatedBucket = yield* getBucketWhenReady(
      updatedBucket.bucketName,
      accountId,
    );
    expect(actualUpdatedBucket.name).toEqual(updatedBucket.bucketName);
    expect(actualUpdatedBucket.storageClass).toEqual("InfrequentAccess");
    expect(actualUpdatedBucket.creationDate).toEqual(actualBucket.creationDate);

    yield* stack.destroy();

    yield* waitForBucketToBeDeleted(updatedBucket.bucketName, accountId);
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
          return yield* Cloudflare.R2.Bucket("AdoptableBucket", {
            forceDestroy: true,
          });
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
            forceDestroy: true,
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

test.provider(
  "destroying a bucket with forceDestroy empties its objects first",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("BucketWithObjects", {
            forceDestroy: true,
          });
        }),
      );

      yield* putObject(accountId, bucket.bucketName, "hello.txt", "hello");
      yield* putObject(
        accountId,
        bucket.bucketName,
        "nested/world.txt",
        "world",
      );

      const before = yield* listKeysWhenReady(accountId, bucket.bucketName, 2);
      expect(before.sort()).toEqual(["hello.txt", "nested/world.txt"]);

      yield* stack.destroy();

      yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
    }).pipe(logLevel),
);

// Without `forceDestroy`, R2's own refusal to delete a non-empty bucket is
// the last line of defense for the data in it — alchemy must not empty the
// bucket to get past it. See https://github.com/alchemy-run/alchemy/issues/1248.
test.provider(
  "destroying a non-empty bucket without forceDestroy keeps the objects",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const declaration = Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("ProtectedBucket");
      });

      const bucket = yield* stack.deploy(declaration);

      yield* putObject(accountId, bucket.bucketName, "keep.txt", "precious");
      yield* listKeysWhenReady(accountId, bucket.bucketName, 1);

      // R2's own refusal (`BucketNotEmpty`) is what fails the teardown.
      const destroyed = yield* Effect.result(stack.destroy());
      expect(Result.isFailure(destroyed)).toBe(true);
      expect(String(destroyed)).toContain("BucketNotEmpty");

      // Both the bucket and its object survived the teardown.
      const survived = yield* r2.getBucket({
        accountId,
        bucketName: bucket.bucketName,
      });
      expect(survived.name).toEqual(bucket.bucketName);
      const keys = yield* listKeysWhenReady(accountId, bucket.bucketName, 1);
      expect(keys).toEqual(["keep.txt"]);

      // Opting in lets the same stack tear down for real.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("ProtectedBucket", {
            forceDestroy: true,
          });
        }),
      );
      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
    }).pipe(logLevel),
);

// The incident behind https://github.com/alchemy-run/alchemy/issues/1248,
// end to end against a real bucket: `retain` is added to an
// already-deployed bucket (a props-identical, noop deploy), the bucket's
// declaration then moves away, and the old stack's orphan sweep must leave
// both the bucket and its objects untouched.
//
// A bucket cannot be renamed in place — R2 has no rename API, and the
// provider's `diff` orders a REPLACE on a name change — so "moving" a
// bucket is always: drop the state row here, adopt the same physical bucket
// there. Retain is what makes that safe.
test.provider(
  "a retained bucket outlives its declaration with its objects intact",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const bucketName = "alchemy-test-retained-move";

      // A retained bucket is alchemy's to forget, not to delete, so an
      // interrupted earlier run can leave a NON-EMPTY bucket behind — which
      // the leading `stack.destroy()` could never reclaim on its own (that
      // is the whole point of the protection under test). Reclaim it out of
      // band first, then let destroy drain any state row pointing at it.
      yield* forceDeleteBucket(accountId, bucketName);
      yield* stack.destroy();

      // ── 1. deploy with the DEFAULT policy, then put an object in it ──
      const origin = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("Origin", { name: bucketName });
        }),
      );
      expect(origin.bucketName).toEqual(bucketName);
      yield* putObject(accountId, bucketName, "precious.txt", "irreplaceable");
      yield* listKeysWhenReady(accountId, bucketName, 1);
      expect(yield* removalPolicyOf(stack, "Origin")).toEqual("destroy");

      // ── 2. add `retain`, props otherwise identical ──
      // The policy is a declaration decoration, not a prop, so the plan is a
      // noop — and the noop path is the only pass that can persist it.
      const retained = Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("Origin", { name: bucketName }).pipe(
          RemovalPolicy.retain(),
        );
      });
      const plan = yield* stack.plan(retained);
      expect(
        (Object.values(plan.resources) as { action: string }[])[0]?.action,
      ).toEqual("noop");
      yield* stack.deploy(retained);
      expect(yield* removalPolicyOf(stack, "Origin")).toEqual("retain");

      // ── 3. the declaration moves away — the old stack sweeps ──
      yield* stack.destroy();

      // The state row is dropped either way; only the physical bucket
      // survives. That is why the bug was silent.
      expect(yield* stateOf(stack, "Origin")).toBeUndefined();
      const survivor = yield* r2.getBucket({ accountId, bucketName });
      expect(survivor.name).toEqual(bucketName);
      expect(yield* listKeysWhenReady(accountId, bucketName, 1)).toEqual([
        "precious.txt",
      ]);

      // ── 4. it lands in its new home by adopting the same bucket ──
      // (Same stack, new logical id — the engine cannot tell that apart from
      // the same declaration in a different stack: both `read` the bucket by
      // name and adopt it.) `forceDestroy` is set here purely so the final
      // teardown reclaims the test bucket.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("Destination", {
            name: bucketName,
            forceDestroy: true,
          });
        }),
      );
      expect(moved.bucketName).toEqual(bucketName);
      expect(yield* listKeysWhenReady(accountId, bucketName, 1)).toEqual([
        "precious.txt",
      ]);

      yield* stack.destroy();
      yield* waitForBucketToBeDeleted(bucketName, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// The other half of a move: a retained bucket whose REPLACEMENT is ordered
// (an explicit name change, the only way to "rename" an R2 bucket). The old
// generation must be left standing, objects and all.
test.provider(
  "replacing a retained bucket leaves the old generation and its objects",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const oldName = "alchemy-test-retained-replace-old";
      const newName = "alchemy-test-retained-replace-new";

      // Same reason as above: retained leftovers from an interrupted run are
      // never reclaimed by the engine.
      yield* forceDeleteBucket(accountId, oldName);
      yield* forceDeleteBucket(accountId, newName);
      yield* stack.destroy();

      const declare = (name: string) =>
        Effect.gen(function* () {
          return yield* Cloudflare.R2.Bucket("Renamed", { name }).pipe(
            RemovalPolicy.retain(),
          );
        });

      yield* stack.deploy(declare(oldName));
      yield* putObject(accountId, oldName, "precious.txt", "irreplaceable");
      yield* listKeysWhenReady(accountId, oldName, 1);

      // A name change is a replacement: new bucket created, state re-pointed.
      const replaced = yield* stack.deploy(declare(newName));
      expect(replaced.bucketName).toEqual(newName);
      yield* getBucketWhenReady(newName, accountId);

      // Retain covers the replacement's old generation too — the bucket is
      // dropped from state, never deleted, and its objects are still there.
      const old = yield* r2.getBucket({ accountId, bucketName: oldName });
      expect(old.name).toEqual(oldName);
      expect(yield* listKeysWhenReady(accountId, oldName, 1)).toEqual([
        "precious.txt",
      ]);

      yield* stack.destroy();

      // Retained buckets are alchemy's to forget, not to delete, so this
      // suite reclaims both out of band.
      yield* forceDeleteBucket(accountId, oldName);
      yield* forceDeleteBucket(accountId, newName);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider("lifecycle rules are added, updated, and removed", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create with one rule.
    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("LifecycleBucket", {
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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
          forceDestroy: true,
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

test.provider("managed r2.dev domain is enabled and disabled", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("PublicBucket", {
          forceDestroy: true,
          publicAccess: true,
        });
      }),
    );

    expect(initial.publicDomain).toBeDefined();
    expect(initial.publicDomain).toMatch(/\.r2\.dev$/);

    const enabled = yield* r2.listBucketDomainManageds({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(enabled.enabled).toEqual(true);
    expect(enabled.domain).toEqual(initial.publicDomain);

    const disabled = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("PublicBucket", {
          forceDestroy: true,
          publicAccess: false,
        });
      }),
    );

    expect(disabled.bucketName).toEqual(initial.bucketName);
    expect(disabled.publicDomain).toBeUndefined();

    const observed = yield* r2.listBucketDomainManageds({
      accountId,
      bucketName: initial.bucketName,
    });
    expect(observed.enabled).toEqual(false);
    expect(observed.domain).toEqual(enabled.domain);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(initial.bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("managed r2.dev domain converges drift and adoption", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Pin the physical name on every deploy so adding `name` cannot be
    // what schedules the update — same shape as the CORS drift case
    // above. A PR/user suffix keeps concurrent runs from colliding.
    const suffix = (process.env.PULL_REQUEST ?? process.env.USER ?? "local")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 24);
    const bucketName = `alchemy-test-r2-pub-drift-${suffix}`;

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftPublicBucket", {
          forceDestroy: true,
          name: bucketName,
          publicAccess: false,
        });
      }),
    );
    expect(initial.publicDomain).toBeUndefined();

    // Drift: enable the managed domain out of band.
    yield* r2.putBucketDomainManaged({
      accountId,
      bucketName,
      enabled: true,
    });

    // Re-deploy with publicAccess still false. The storage-class change
    // is what makes Plan run reconcile (unchanged props skip it); the
    // managed-domain sync must still disable the leaked enable because
    // it diffs desired against *observed* cloud state, not olds.
    const repaired = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftPublicBucket", {
          forceDestroy: true,
          name: bucketName,
          publicAccess: false,
          storageClass: "InfrequentAccess",
        });
      }),
    );
    expect(repaired.bucketName).toEqual(bucketName);
    expect(repaired.storageClass).toEqual("InfrequentAccess");
    expect(repaired.publicDomain).toBeUndefined();

    const afterRepair = yield* r2.listBucketDomainManageds({
      accountId,
      bucketName,
    });
    expect(afterRepair.enabled).toEqual(false);

    // Adoption: re-enable out of band, wipe local state, then adopt
    // with publicAccess: true (output defined, olds undefined).
    yield* r2.putBucketDomainManaged({
      accountId,
      bucketName,
      enabled: true,
    });
    yield* Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "DriftPublicBucket",
      });
    }).pipe(Effect.provide(stack.state));

    const adopted = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("DriftPublicBucket", {
          forceDestroy: true,
          name: bucketName,
          publicAccess: true,
        });
      }),
    );
    expect(adopted.bucketName).toEqual(bucketName);
    expect(adopted.publicDomain).toMatch(/\.r2\.dev$/);

    const converged = yield* r2.listBucketDomainManageds({
      accountId,
      bucketName,
    });
    expect(converged.enabled).toEqual(true);
    expect(converged.domain).toEqual(adopted.publicDomain);

    yield* stack.destroy();
    yield* waitForBucketToBeDeleted(bucketName, accountId);
  }).pipe(logLevel),
);

test.provider("managed r2.dev domain is applied on replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("ReplacePublicBucket", {
          forceDestroy: true,
          publicAccess: true,
        });
      }),
    );
    const oldName = initial.bucketName;
    // Flip the first character so the replacement name is unique and
    // stays within R2's 63-char limit regardless of the original length.
    const newName = `x${oldName.slice(1)}`;

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2.Bucket("ReplacePublicBucket", {
          forceDestroy: true,
          name: newName,
          publicAccess: true,
        });
      }),
    );
    expect(replaced.bucketName).toEqual(newName);
    expect(replaced.publicDomain).toMatch(/\.r2\.dev$/);

    const replacedDomain = yield* r2.listBucketDomainManageds({
      accountId,
      bucketName: newName,
    });
    expect(replacedDomain.enabled).toEqual(true);
    expect(replacedDomain.domain).toEqual(replaced.publicDomain);

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

const putObject = (
  accountId: string,
  bucketName: string,
  key: string,
  body: string,
) =>
  r2.putObject({
    accountId,
    bucketName,
    objectName: key,
    contentType: "text/plain",
    body: new Blob([body], { type: "text/plain" }),
  });

// R2's object listing lags a write by a beat — poll until the expected
// number of keys shows up, then return them.
const listKeysWhenReady = Effect.fn(function* (
  accountId: string,
  bucketName: string,
  count: number,
) {
  return yield* r2.listObjects({ accountId, bucketName, perPage: 1000 }).pipe(
    Effect.flatMap((page) => {
      const keys = (page.result ?? [])
        .map((o) => o.key)
        .filter((k): k is string => typeof k === "string");
      return keys.length === count
        ? Effect.succeed(keys)
        : Effect.fail(new ListLagError());
    }),
    Effect.retry({
      while: (e): e is ListLagError => e instanceof ListLagError,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
    }),
  );
});

class ListLagError extends Data.TaggedError("ListLagError") {}

const stateOf = Effect.fn(function* (
  stack: { name: string; state: Layer.Layer<State> },
  fqn: string,
) {
  return yield* Effect.gen(function* () {
    const state = yield* yield* State;
    return (yield* state.get({ stack: stack.name, stage: "test", fqn })) as
      | ResourceState
      | undefined;
  }).pipe(Effect.provide(stack.state));
});

const removalPolicyOf = Effect.fn(function* (
  stack: { name: string; state: Layer.Layer<State> },
  fqn: string,
) {
  return (yield* stateOf(stack, fqn))?.removalPolicy;
});

/**
 * Empty and delete a bucket out of band. Needed only for buckets a test
 * deliberately RETAINED: alchemy has forgotten them by design, so nothing
 * else will ever reclaim them.
 */
const forceDeleteBucket = Effect.fn(function* (
  accountId: string,
  bucketName: string,
) {
  yield* r2.listObjects.items({ accountId, bucketName, perPage: 1000 }).pipe(
    Stream.filter(
      (o): o is typeof o & { key: string } => typeof o.key === "string",
    ),
    Stream.map((o) => o.key),
    Stream.runForEachArray((chunk) =>
      r2.deleteObjects({ accountId, bucketName, body: [...chunk] }),
    ),
    Effect.catchTag("NoSuchBucket", () => Effect.void),
  );
  yield* r2
    .deleteBucket({ accountId, bucketName })
    .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
});

// ── destructive deletes require explicit opt-in ────────────────────────
//
// DATA-PROTECTION INVARIANT: `delete` may remove the bucket, but it must
// NEVER destroy the bucket's CONTENTS unless the user opted in on the
// resource (`forceDestroy`) or an operator ran `alchemy unsafe nuke`
// (which passes `force: true`).
//
// R2 refuses to delete a non-empty bucket (409 "is not empty", typed
// `BucketNotEmpty`). That refusal is the last line of defense for
// production data, and emptying the bucket first silently converts a
// routine teardown into irreversible data loss — which is what happened
// in https://github.com/alchemy-run/alchemy/issues/1248, where a stale
// removal policy orphaned a bucket and the delete wiped 60k objects the
// API would otherwise have protected.
//
// The live test above can only observe that the bucket survived, not that
// no destructive request was ever issued. These run the REAL provider
// `delete` against a recording transport and assert on the wire traffic.

type Recorded = { method: string; url: string };

/** Fetch transport that records every request and answers from `respond`. */
const recordingTransport = (respond: (call: Recorded) => Response) => {
  const calls: Recorded[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      method: (input instanceof Request ? input.method : init?.method) ?? "GET",
      url: input instanceof Request ? input.url : String(input),
    });
    return respond(calls[calls.length - 1]!);
  };
  return {
    calls,
    layer: FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      ),
    ),
  };
};

const TEST_ACCOUNT = "test-account-id";
const INSTANCE_ID = "0123456789abcdef0123456789abcdef";

const testStack: Omit<StackSpec, "output"> = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

const stubbedEnv = (transport: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.mergeAll(
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test-token"),
        accountId: TEST_ACCOUNT,
        source: { type: "env" },
      } satisfies CloudflareResolvedCredentials),
    ),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(
      LocalRuntimeState,
      LocalRuntimeState.of({
        queues: MutableHashMap.empty(),
        queueConsumers: MutableHashMap.empty(),
        workerRestarts: MutableHashMap.empty(),
      }),
    ),
    Layer.succeed(Stack, testStack),
    Layer.succeed(Stage, testStack.stage),
    Layer.succeed(InstanceId, INSTANCE_ID),
    Layer.succeed(AlchemyContext, {
      dotAlchemy: "/tmp/.alchemy-test",
      dev: false,
      adopt: false,
    }),
    Layer.sync(ArtifactStore, createArtifactStore),
    NodeServices.layer,
  ).pipe(Layer.provideMerge(transport));

const stubbedOutput = {
  bucketName: "my-bucket",
  storageClass: "Standard" as const,
  jurisdiction: "default" as const,
  location: undefined,
  accountId: TEST_ACCOUNT,
  domains: [],
  lifecycleRules: [],
  cors: [],
  publicDomain: undefined,
};

/** `DELETE .../r2/buckets/{name}/objects` — the request that wipes data. */
const objectDeletes = (calls: Recorded[]) =>
  calls.filter((c) => c.method === "DELETE" && c.url.includes("/objects"));

/** `DELETE .../r2/buckets/{name}` — deleting the bucket itself. */
const bucketDeletes = (calls: Recorded[]) =>
  calls.filter(
    (c) =>
      c.method === "DELETE" &&
      c.url.endsWith(`/r2/buckets/${stubbedOutput.bucketName}`),
  );

/** One object in the bucket, so the empty path has something to delete. */
const stubResponse = (call: Recorded) =>
  new Response(
    JSON.stringify(
      call.method === "GET" && call.url.includes("/objects")
        ? { success: true, result: [{ key: "precious.txt" }] }
        : { success: true, result: {} },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Run the real provider delete; return every request it made. */
const recordDelete = (
  props: { forceDestroy?: boolean },
  options?: { force?: boolean },
) =>
  Effect.gen(function* () {
    const transport = recordingTransport(stubResponse);
    yield* Effect.gen(function* () {
      const provider = yield* Provider<Cloudflare.R2.Bucket>(
        "Cloudflare.R2.Bucket",
      );
      yield* provider.delete({
        id: "Bucket",
        fqn: "Bucket",
        instanceId: INSTANCE_ID,
        olds: props,
        output: stubbedOutput,
        bindings: [] as never,
        session: {
          emit: () => Effect.void,
          done: () => Effect.void,
          note: () => Effect.void,
        },
        force: options?.force,
      });
    }).pipe(
      Effect.provide(Cloudflare.R2.BucketProvider()),
      Effect.provide(stubbedEnv(transport.layer)),
    );
    return transport.calls;
  });

describe("destructive delete requires explicit opt-in", () => {
  it.effect("no forceDestroy never empties the bucket", () =>
    Effect.gen(function* () {
      const calls = yield* recordDelete({});

      expect(objectDeletes(calls)).toEqual([]);
      // The bucket delete itself is still attempted — R2 answers 409
      // "is not empty" (`BucketNotEmpty`), which is the protection.
      expect(bucketDeletes(calls)).toHaveLength(1);
    }),
  );

  it.effect("forceDestroy empties the bucket first", () =>
    Effect.gen(function* () {
      const calls = yield* recordDelete({ forceDestroy: true });

      expect(objectDeletes(calls).length).toBeGreaterThan(0);
      expect(bucketDeletes(calls)).toHaveLength(1);
    }),
  );

  // Nuke enumerates buckets from the cloud, so `olds` carries Attributes and
  // never has `forceDestroy` — the operator's confirmation IS the flag.
  it.effect("nuke's force empties without the prop", () =>
    Effect.gen(function* () {
      const calls = yield* recordDelete({}, { force: true });

      expect(objectDeletes(calls).length).toBeGreaterThan(0);
    }),
  );
});
